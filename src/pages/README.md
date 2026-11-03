# alook-pages

Private management of static sites and backend Workers with assets, with public dispatch at `https://<prefix>.<BASE_DOMAIN>`. This package has no Web application integration or production deployment workflow.

## Entrypoints

The default `fetch` handler only resolves a single subdomain in the configured domain, reads its active release from D1 and invokes that recorded Worker through the dispatch binding. It forwards the original request and response without buffering, including WebSocket upgrades. Management paths or authorization headers on this handler do not grant management access.

The named `PageManager` WorkerEntrypoint provides these private RPC methods through a same-account Service Binding:

| Method | Input | Result |
| --- | --- | --- |
| `create(request)` | Multipart Request, including prefix | New registration and publication outcome |
| `get(pageId)` | Stable registration ID | Durable status, limits and last operation |
| `update(pageId, request)` | Multipart Request, without prefix | New immutable release; existing active release remains available |
| `configure(pageId, limits)` | `{cpuMs, subRequests}` | Lower native per-invocation limits |
| `destroy(pageId)` | Stable registration ID | Deleting status or confirmed deletion |
| `recover(pageId)` | Stable registration ID | One bounded reconciliation/cleanup pass |

Each method returns a Response. Validation/conflict/not-found errors use HTTP400/409/404 with a safe `error` code. HTTP200 is an operation result: inspect `state`, `operation.pending`, `operation.stage` and `operation.error`. It does not itself prove a successful publication. `url` is non-null only with a confirmed active release outside deletion. `activeRelease` identifies the currently serving script, operation and artifact digest; `revision` includes a pending attempt and must not be treated as the active version. No credentials, asset JWTs or uploaded source are included in results.

Only the manager receives `REGISTRY`, `DISPATCHER` and the `PAGES_API_TOKEN` Secret. Application bindings are restricted to caller-owned plain-text variables and native `ASSETS`; callers cannot supply arbitrary Cloudflare metadata or resource bindings. The private helper methods use JavaScript private fields and are not RPC methods.

## Registry authority and recovery

The dedicated D1 `pages` table has a unique constraint on normalized `prefix` alone. Its namespace and account columns scope reads and management but are not part of uniqueness. Account identity is persisted with native references: changing the configured account must not make a404 in a different account count as cleanup of an old target. Entrypoints that claim one global prefix authority must bind the same designated registry. Separate development and production databases cannot provide cross-database uniqueness. Development resources must not reuse Alook's production database.

Registration, current operation, known release references and active release are stored in one row. Every change uses a version compare-and-set, so intent and its references change atomically. A new release uses `p-<pageUUID-without-hyphens>-<revision>`; public prefixes are never mutable native script names. The manager checks absence before uploading a new target and verifies page/operation/artifact ownership tags before activation or deletion. Normal namespace writes must go through this manager; out-of-band writes to its namespace break that ownership boundary.

Native script inspection recognizes HTTP404 or a valid successful response with explicit `result.script:null` as absence. Missing script fields, malformed metadata and invalid envelopes remain provider errors. An absent read after an unknown PUT does not prove the write has finished: recovery keeps the operation and prefix occupied without replaying publication.

No atomic transaction across D1 and Cloudflare is claimed. A publication PUT is sent once. Transport failures, server failures and malformed success responses retain the operation and prefix. `recover` can activate a late successful result only after matching ownership metadata and a dispatch probe. A404 after an uncertain PUT never frees the reservation or authorizes a retry. Matching metadata can resolve an earlier ownership mismatch. An unresolved publication must remain reserved until an operator obtains authoritative evidence; there is no timeout-based force-release method.

The original caller records `operation.putAcknowledged:true` in D1 only after its PUT returns a valid successful response. Missing means unknown. Recovery never infers that receipt from ownership tags or the confirming stage. After ownership matches, an application probe exception can end as `application_probe_failed` only with that durable acknowledgment: references remain, a new page has no ready URL, and an update retains the old active release. Explicit update/configure/destroy are then available. Without the acknowledgment, a probe exception reports `publication_probe_unconfirmed` and keeps the operation/prefix held. Losing the process before the receipt is durably recorded therefore stays conservative. Late callbacks remain fenced by operation ID and stage.

The default native fetch is bound to globalThis before being stored as a provider method. Provider fetch uses Workers-supported `redirect:"manual"`. A3xx response is rejected without following its destination or forwarding the management header. Write redirects remain uncertain rather than being treated as completed/rejected publication proof. Native regression tests call the actual workerd global fetch with a controlled outbound provider; they cover argument validation, all management methods and non-following GET/PUT redirects.

Recovery of a stopped operation before its PUT fences the old operation in D1, reports `publication_input_required` and permits an explicit `update` with the original/new artifact. A delayed pre-PUT caller must pass the operation guard before it can publish, so it cannot overwrite a later revision. Known rejected publications also allow an explicit new revision. Duplicate creates always conflict while the registration exists.

Updates retain failed cleanup references. `recover` retries cleanup of recorded owned targets; deletion makes the public page unavailable before cleanup starts. Each pass processes at most16 references. Prefix reuse is allowed only after all references are confirmed absent and the D1 row is removed. A delayed deletion cannot affect a new registration because its UUID-based target differs. At64 retained references, new updates return `cleanup_required` until recovery reduces them; this bounds registry metadata rather than introducing a customer usage quota. Foreign objects are never overwritten or deleted.

The publication probe is a GET to `/__alook_publication_probe` through the native dispatcher with the page limits. Any returned application status confirms dispatch availability; application correctness is a separate QA assertion. The body is cancelled. Applications should keep GET requests free of mutation.

## Upload contract

Send `multipart/form-data` with one **text** field named `manifest` containing JSON, and one file part for each `files[].part`. Do not upload `manifest` as a file. Finished code and packages are caller-built; this service does not compile TypeScript or install npm dependencies.

```json
{
  "prefix": "example",
  "compatibilityDate": "2026-10-19",
  "compatibilityFlags": [],
  "variables": { "MESSAGE": "hello" },
  "files": [
    { "part": "html", "path": "/index.html", "role": "asset", "type": "text/html" }
  ]
}
```

Omit `entry` for a static site; the manager generates a minimal ASSETS-forwarding module. For a backend, provide `entry: {path, format}` where format is `module`, `classic` or `python`, and upload the matching entry file. Assets options are `html_handling`, `not_found_handling` and boolean `run_worker_first`. Code, variables, compatibility and asset options change through `update`; `configure` changes dispatch limits only.

| Native MIME | Use and accepted combinations |
| --- | --- |
| `application/javascript+module` | ES module entry and helper modules; optional assets |
| `application/javascript` | One traditional Service Worker entry; no extra modules or assets |
| `text/x-python` | Python entry/helpers; manager adds `python_workers` if absent; optional assets |
| `text/x-python-requirement` | Legacy requirement declaration accepted by the transport; the tested current native runtime rejects the raw requirement combination. Retained as a negative compatibility fixture, not a runnable dependency example |
| `application/wasm` | Caller-built Wasm helper |
| `text/plain` | Text helper |
| `application/octet-stream` | Binary helper |
| `application/source-map` | Source map helper |

Modules use relative, non-traversing names. Assets use absolute URL paths such as `/index.html`. Encoded separators, percent-encoded names, query/fragment suffixes, backslashes, empty/dot segments, control/space characters, duplicate mappings and missing/extra parts are rejected. The metadata part name is reserved. Unsupported MIME types, unknown manifest/options/binding keys and platform binding variable names are rejected before reservation or provider writes. Native compilation and Python package availability remain Cloudflare's responsibility; accepting an upload format does not assert that every program will compile or run.

The basic and vendored Python examples explicitly set `disable_python_external_sdk` to use the runtime's built-in `workers` SDK. With the external SDK enabled, Cloudflare requires a caller-bundled `workers-py` version1.9 or later. Callers supplying their own SDK artifacts can keep that choice. The manager forwards caller compatibility flags and adds only `python_workers` when absent; it does not bundle an SDK or automatically disable the external SDK. The native [compatibility definition](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/compatibility-date.capnp) identifies this SDK switch separately from Python enablement.

Python dependencies must be prepared by the caller. The current [Python package toolchain](https://developers.cloudflare.com/workers/languages/python/packages/) vendors packages from `pyproject.toml` into `python_modules`. Preserve those relative paths and send the prepared files as modules: package files use `application/octet-stream`, while the runtime SDK's JavaScript helpers use `application/javascript+module`. This service does not install dependencies or unpack a wheel/ZIP. The same file-count and byte limits apply, so accepting this form does not guarantee that an arbitrary package fits or runs.

The manager enforces actual streamed request bytes: at most16MiB total multipart,8MiB per file,128 files and64KiB manifest. Operators may lower these bounds. It does not trust Content-Length. Files are hashed sequentially. Native asset keys use the first32 hex characters of SHA256 over `["alook-assets-v1", fullContentSha256, normalizedMime]`. MIME is lowercased and that exact value is used on the upload part. Identical bytes with different MIME therefore receive different native keys, including across publications; identical bytes and MIME can share a cached asset. The raw content SHA256 and full artifact SHA256 remain separate; the latter covers parsed configuration and full content hashes. Asset groups and completion JWTs follow the native session/upload/publish flow; there is no R2 staging bucket. Session JWTs stay in the request lifetime.

## Configuration and development

`wrangler.jsonc` is a non-routed development template with placeholder account/database IDs. Copy it to an ignored local QA configuration and set unique resource names/actual IDs before using it. Keep `vars.CF_NAMESPACE` equal to the namespace bound as `DISPATCHER`. The dispatch binding is `remote: true`: local management/dispatch can invoke actual applications in that cloud namespace. It requires real development resources and is not an offline simulator.

The checked-in test configuration uses only local D1. Test REST responses and application fetchers are controlled fixtures. These checks do not establish real-cloud publication or public DNS/TLS. Compatibility date2026-10-19 is supported by the installed Wrangler4.152.0/Vitest plugin1.4.7 runtime. Installed types pin the existing workspace5.20261023.1 to preserve all other lockfile resolutions. Latest reviewed platform types5.20261027.1 do not imply a newer installed runtime or additional module execution evidence.

Operator settings:

| Setting | Meaning/default |
| --- | --- |
| `CF_ACCOUNT_ID`, `CF_NAMESPACE` | Private management account and isolated namespace |
| `PAGES_API_TOKEN` | Worker Secret with native Workers script-management permission; never an application variable |
| `BASE_DOMAIN` | Public routing suffix, e.g. `alook.page`; no arbitrary customer domains |
| `PAGE_CPU_MS`, `PAGE_SUBREQUESTS` | Native dispatch ceilings, default1000ms and100 subrequests |
| `UPLOAD_MAX_BYTES`, `FILE_MAX_BYTES`, `UPLOAD_MAX_FILES` | Upload memory/transport bounds |
| `CF_TIMEOUT_MS` | Provider/probe timeout, default30000ms |
| `RESERVED_EXACT`, `RESERVED_PREFIXES` | Comma-separated occupied/service names and reserved ranges |
| `SENSITIVE_EXACT`, `SENSITIVE_PREFIXES` | Independent exact/prefix-sensitive names; no substring filtering |

CPU values are positive integers up to300000ms; this service accepts subrequest limits up to1000. Per-page values cannot exceed current operator ceilings; every public request clamps saved values to those ceilings. These are native invocation limits, not a monthly/global cost cap. No native Rate Limiter, tenant quota, SDK proxy or automatic application KV/D1/R2/DO is provisioned.

Prefixes are ASCII1–63 characters, lowercase canonical form, alphanumeric ends and hyphens inside. Built-ins reserve `www/api/admin/auth/mail/alook` and `alook-/internal-`. Errors distinguish `invalid_prefix`, `reserved_prefix`, `sensitive_prefix` and `prefix_occupied`. Before exposing any domain route, the operator must read the actual DNS and service-route inventory and add occupied non-pages service names. The default list cannot prove that a hostname is free. For QA use only individually allocated development hostnames, never install the production wildcard route merely to test.

For an isolated development namespace/registry, the QA operator creates resources with `wrangler dispatch-namespace create <qa-name>` and `wrangler d1 create <qa-registry-name>`, then records their exact IDs and cleanup owner. Set the secret from a protected file/stdin, apply `migrations/` only to that registry, and use the copied configuration for all commands. Do not deploy the placeholder template.

```sh
pnpm --filter @alook/pages typecheck
pnpm --filter @alook/pages lint
pnpm --filter @alook/pages knip
pnpm --filter @alook/pages test
pnpm --filter @alook/pages build
```

For local private RPC, run the driver first and the manager second with `pnpm exec wrangler dev --config dev/wrangler.jsonc --config <ignored-manager-config> --ip 127.0.0.1 --port 8793`. Update the driver's Service Binding name to the isolated manager name. The driver has `workers_dev:false`, no routes and a loopback-host check; it is development tooling and must never receive a public route. Its HTTP adapter is:

| HTTP on loopback driver | RPC |
| --- | --- |
| `POST /pages` | create |
| `GET/PUT/DELETE /pages/:id` | get/update/destroy |
| `POST /pages/:id/limits` | configure with a bounded JSON body |
| `POST /pages/:id/recover` | recover |

Example native artifacts are under `test-runtime/artifacts/`. The QA operator must replace their example prefixes with allocated QA names. `python-vendored/manifest.json` maps eight module parts: `entry.py`, an empty `python_modules/pyvenv.cfg` marker, and the six original files from the published `six==1.17.0` pure-Python wheel. `provenance.json` records the wheel URL, SHA256, original file hashes and MIT license; no dependency code is changed and no workspace dependency is added. Upload each part from the manifest's relative path. The entry calls `six.iteritems` and returns the package version, value3, actual module path and module SHA256 `c51c91f703d3d4b3696c923cb5fec213e05e75d9215393befac7f2fa6a3904df`, so independent native QA can verify it loaded the uploaded package. The artifact remains subject to actual cloud compilation/execution; a serialization test is not runtime acceptance.

The retained `python-requirement.json`, `python-numpy.py` and `requirement.txt` are a negative compatibility case. With the tested2026-10-19 configuration, both the service publication and a same-input direct native upload returned400/10021 stating that requirement declarations are no longer accepted and callers must use pywrangler. The original failure remains; these files do not promise a successful numpy deployment. With the driver on port8793:

```sh
curl --fail-with-body http://127.0.0.1:8793/pages \
  -F 'manifest=<test-runtime/artifacts/static.json' \
  -F 'html=@test-runtime/artifacts/index.html;type=text/html'
```

For updates, remove `prefix` from the manifest and PUT to the returned page ID. Public hostname/TLS assertions must use the actual allocated HTTPS URL. A loopback request with a controlled Host plus remote dispatch verifies a different layer and must be recorded separately.

## Evidence and cleanup

The author runs local checks only. The named independent QA operator owns real-cloud namespace/registry/manager/driver/DNS resources, verifies static/backend/native-module flows and controlled failure/restart cases, and records exact source/build/resource identities. Preserve original failures and unexecuted/UNKNOWN layers. Production merge and deployment require a separate decision; this task ends with a checked, unmerged PR.

Destroy registrations through the private manager and confirm native targets are absent before deleting their registry. Reconcile uncertain publications before releasing any prefix. The independent QA operator removes only the recorded isolated resources and routes after evidence no longer depends on them; do not remove unrelated workers, databases, DNS records or local evidence.

## Native contracts

- [Worker RPC and streamed Request/Response transfer](https://developers.cloudflare.com/workers/runtime-apis/rpc/)
- [Native Request redirect modes](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Workers for Platforms publication API examples](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/platform-examples/)
- [Asset upload identity and serving MIME](https://developers.cloudflare.com/workers/static-assets/direct-upload/)
- [Native static assets session and uploads](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/)
- [Native dispatch limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/)
- [Python deployment through the multipart API](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/)
