# Open Artifact ZIP implementation

`zip.ts` is an unchanged copy of `packages/server-sdk/src/zip.ts` from JimLiu/open-artifact revision `a325e46c37f9366132a2ce6b9a42b3654e74d35b` (Apache-2.0), the same upstream revision used by `src/page-host/upstream.json`.

It is bundled into the daemon CLI so directory validation and archive packing need no first-use download or separate package installation. Keep the pin and this file together when updating upstream. The original license is included in the daemon's THIRD_PARTY_NOTICES.md.
