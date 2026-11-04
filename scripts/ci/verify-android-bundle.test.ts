import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const helper = resolve(import.meta.dirname, "verify-android-bundle.py")
const certificate = "-----BEGIN CERTIFICATE-----\naW5kZXBlbmRlbnQgdGVzdCBjZXJ0aWZpY2F0ZSBieXRlcw==\n-----END CERTIFICATE-----"
const fingerprint = createHash("sha256").update("independent test certificate bytes").digest("hex").toUpperCase()
const manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="ai.alook.android" android:versionName="0.1.63" android:versionCode="10"><application android:debuggable="false"/></manifest>'
const names = ["base/lib/arm64-v8a/libapp.so", "base/lib/armeabi-v7a/libapp.so"]

function run(overrides: Record<string, unknown> = {}, nativeFailure = "") {
  return spawnSync("python3", ["-c", `
import argparse, hashlib, importlib.util, json, os, pathlib, sys, tempfile, zipfile
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("bundle_verifier", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
fixture = json.load(sys.stdin)
calls = []
def native(command):
    calls.append(command)
    if command[0] == fixture["nativeFailure"]:
        raise ValueError("controlled native rejection")
    if command[0] == "keytool": return fixture["certificate"]
    if "dump" in command: return fixture["manifest"]
    return ""
module.native = native
with tempfile.TemporaryDirectory(prefix="alook-bundle-metadata-") as root:
    root = pathlib.Path(root)
    source, staged, receipt = [root / name for name in ["input.aab", "staged.aab", "receipt.json"]]
    with zipfile.ZipFile(source, "w") as bundle:
        for name in fixture["names"]: bundle.writestr(name, b"fixture native bytes")
    os.environ["SIGNING_STORE_FILE"] = str(root / "offline.jks")
    os.environ["SIGNING_STORE_PASSWORD"] = "offline-fixture-password"
    args = argparse.Namespace(bundle=str(source), output=str(staged), receipt=str(receipt),
        bundletool="offline-bundletool.jar", version_name="0.1.63", version_code="10",
        certificate_sha256=fixture["fingerprint"])
    try:
        result = module.verify(args)
        assert staged.read_bytes() == source.read_bytes()
        assert result["sha256"] == hashlib.sha256(staged.read_bytes()).hexdigest()
        print(json.dumps({"result": result, "calls": calls, "receipt": json.loads(receipt.read_text())}))
    except Exception as error:
        print(json.dumps({"error": str(error), "calls": calls, "receiptExists": receipt.exists()}))
        sys.exit(1)
`, helper], {
    encoding: "utf8", input: JSON.stringify({ certificate, fingerprint, manifest, names, nativeFailure, ...overrides }),
    timeout: 10_000,
  })
}

describe("AAB metadata and native-command boundary with controlled tools", () => {
  it("binds staged bytes, decoded identity, version, ABI and certificate to the receipt", () => {
    const execution = run()
    expect(execution.status, execution.stderr).toBe(0)
    const { result, calls, receipt } = JSON.parse(execution.stdout)
    expect(result).toMatchObject({ package: "ai.alook.android", versionName: "0.1.63", versionCode: 10,
      certificateSha256: fingerprint, abis: ["arm64-v8a", "armeabi-v7a"] })
    expect(receipt).toEqual(result)
    expect(calls[0].slice(0, 3)).toEqual(["jarsigner", "-verify", "-strict"])
    expect(calls[0]).toContain("-storepass:env")
    expect(calls.map((command: string[]) => command[0])).toEqual(["jarsigner", "keytool", "java", "java"])
    expect(execution.stdout).not.toContain("offline-fixture-password")
  })

  it.each([
    [{ manifest: manifest.replace("ai.alook.android", "wrong.app") }, "package"],
    [{ manifest: manifest.replace('versionCode="10"', 'versionCode="11"') }, "version"],
    [{ manifest: manifest.replace('versionName="0.1.63"', 'versionName="0.1.62"') }, "version"],
    [{ manifest: manifest.replace('debuggable="false"', 'debuggable="true"') }, "release application"],
    [{ names: [names[0]] }, "ARM architectures"],
    [{ names: [...names, "base/lib/x86/libapp.so"] }, "ARM architectures"],
    [{ certificate: "Not a signed jar file" }, "no signing certificate"],
    [{ fingerprint: "0".repeat(64) }, "signing certificate differs"],
  ] as const)("rejects the isolated metadata violation %j", (override, error) => {
    const execution = run(override)
    expect(execution.status).toBe(1)
    const result = JSON.parse(execution.stdout)
    expect(result.error).toContain(error)
    expect(result.receiptExists).toBe(false)
  })

  it.each(["jarsigner", "keytool", "java"])("stops receipt publication after %s rejects", tool => {
    const execution = run({}, tool)
    expect(execution.status).toBe(1)
    const result = JSON.parse(execution.stdout)
    expect(result.error).toBe("controlled native rejection")
    expect(result.calls.at(-1)[0]).toBe(tool)
    expect(result.receiptExists).toBe(false)
  })
})
