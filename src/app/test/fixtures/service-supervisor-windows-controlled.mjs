import { execFileSync as nodeExecFileSync, spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServiceSupervisorRuntime } from "../../src/service-supervisor-runtime.js";
import {
  TRUSTED_WINDOWS_POWERSHELL,
  TRUSTED_WINDOWS_TASKKILL,
  trustedWindowsAuthorityEnvironment,
} from "../../src/lib/windows-command.js";

function waitForRelease(barrier, timeoutMs) {
  writeFileSync(barrier, "ready\n");
  const release = `${barrier}.release`;
  const deadline = Date.now() + timeoutMs;
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) {
    if (Date.now() >= deadline) throw new Error("controlled tree signal barrier timed out");
    Atomics.wait(waitArray, 0, 0, 10);
  }
}

const execFileSync = (command, args, options) => {
  if (command.toLowerCase() === TRUSTED_WINDOWS_TASKKILL.toLowerCase()) {
    const barrier = process.env.ALOOK_FIXTURE_TREE_SIGNAL_BARRIER;
    if (barrier && !existsSync(`${barrier}.consumed`)) {
      writeFileSync(`${barrier}.consumed`, "consumed\n");
      waitForRelease(barrier, 5_000);
    }
    if (process.env.ALOOK_FIXTURE_FORCE_TREE_SIGNAL_ERROR === "1" && args.includes("/F")) {
      throw new Error("controlled forced tree signal failure");
    }
  }
  return nodeExecFileSync(command, args, options);
};

function readWindowsProcessSnapshot(timeoutMs) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$rows=@(Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; birth=[string]($_.CreationDate.ToUniversalTime().ToFileTimeUtc()) } })",
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join("; ");
  const output = nodeExecFileSync(TRUSTED_WINDOWS_POWERSHELL, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    env: trustedWindowsAuthorityEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsHide: true,
  }).trim();
  const controlPath = process.env.ALOOK_FIXTURE_REUSED_SEED_CONTROL;
  if (!controlPath || !existsSync(controlPath) || !output) return output;
  const control = JSON.parse(readFileSync(controlPath, "utf8"));
  const parsed = JSON.parse(output);
  const records = (Array.isArray(parsed) ? parsed : [parsed]).filter((record) => record.pid !== control.rootPid);
  const unrelated = records.find((record) => record.pid === control.unrelatedPid);
  if (unrelated) unrelated.parentPid = control.rootPid;
  return JSON.stringify(records);
}

function spawnWindowsProcessWatcher(parentPid) {
  const trigger = process.env.ALOOK_FIXTURE_WITHHOLD_MARKER_TRIGGER ?? "";
  const script = [
    "$ErrorActionPreference='Stop'",
    `$parentPid=${parentPid}`,
    `$withholdTrigger=${JSON.stringify(trigger)}`,
    "$query=New-Object System.Management.WqlEventQuery -ArgumentList 'SELECT ProcessID, ParentProcessID, TIME_CREATED FROM Win32_ProcessStartTrace'",
    "$watcher=New-Object System.Management.ManagementEventWatcher -ArgumentList $query",
    "$watcher.Options.Timeout=[TimeSpan]::FromMilliseconds(100)",
    "$watcher.Start()",
    "[Console]::Out.WriteLine('ready')",
    "[Console]::Out.Flush()",
    "try { while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { try { $event=$watcher.WaitForNextEvent(); if (-not $withholdTrigger -or -not (Test-Path -LiteralPath $withholdTrigger)) { [Console]::Out.WriteLine(([PSCustomObject]@{pid=[int]$event.ProcessID;parentPid=[int]$event.ParentProcessID;eventTime=[string]$event.TIME_CREATED}|ConvertTo-Json -Compress)); [Console]::Out.Flush() } } catch [System.Management.ManagementException] { if ($_.Exception.ErrorCode -ne [System.Management.ManagementStatus]::Timedout) { throw } } } } finally { $watcher.Stop(); $watcher.Dispose() }",
  ].join("; ");
  return nodeSpawn(TRUSTED_WINDOWS_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: trustedWindowsAuthorityEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

createServiceSupervisorRuntime({
  execFileSync,
  readWindowsProcessSnapshot,
  spawnWindowsProcessWatcher,
}).run();
