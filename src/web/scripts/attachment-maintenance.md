# Reusable attachment rollout

This candidate is ready for isolated validation, not production rollout. Production schema migration and collection remain blocked until the release operator proves that all old writers have stopped. Deploying another Worker version or waiting 30 seconds does not establish this: HTTP requests have no fixed wall-clock limit while their clients remain connected ([Cloudflare duration limits](https://developers.cloudflare.com/workers/platform/limits/#duration)).

## Data and deletion contract

`community_attachment` stores the named file and its stable random ID. `community_message_attachment` stores ordered message references. New uploads with equal content share an original R2 key; new thumbnails use their own content hashes. Legacy files keep their original and thumbnail keys and bytes. No R2 object migration or historical deduplication is performed. Reuploading creates another file ID, including when bytes and name match.

Only active authenticated actors can read or send files. Uploaders can read their unsent files; other actors need a currently readable live message reference. The common query and message batch recheck account existence and deletion status, including when the account changes after middleware authentication. Downloads read primary D1; message insertion checks readability inside its atomic D1 batch. A URL channel component is only a compatible routing anchor.

Deleting a message cascades its associations. A deletion trigger removes the corresponding file only when the last message reference disappears, in the same transaction. Unsent files are not deletion candidates. Consequently, deleting the last reference invalidates the ID for everyone, including its uploader. Forwarded files survive deletion of the source message, channel, forum or uploader account while another reference remains.

Shared R2 objects are not deleted by requests or failed upload compensation. Their physical deletion is delayed until an independently verified offline maintenance window. This candidate defines no automatic retention timer or promised production collection date. The operator must record the actual retention period and approved collection date before production rollout; old keys are retained by default. Account access/DB deletion and byte deletion are distinct events.

## Isolated rehearsal

Use an independent local D1/R2 state directory and test accounts. Do not use an existing task's state or auth profile. Record the commands, working directories and PIDs of every process that can write this state; stop them and verify they have exited before maintenance. Keep only the maintenance process running until verification finishes.

Create a minimal Wrangler config containing only the local `DB` and `COMMUNITY_MEDIA` bindings, matching the isolated state's database ID and bucket name. Do not mark either binding `remote: true`. The maintenance CLI rejects remote apply and forces local bindings for every apply; a hand-written proof never enables production writes.

1. Export/back up the isolated D1 database and copy its R2 state before schema migration. Record the migration ledger and exact candidate commit. Before 0106, export `id,message_id,position,filename,content_type,size,width,height,created_at,r2_key,thumbnail_r2_key`. Check missing objects, duplicate message positions and foreign-key violations; resolve them before applying.
2. Apply migration 0106 through the existing local Wrangler migrations command using the isolated config/state. Existing IDs, metadata, original keys and thumbnail keys stay unchanged; used files gain ordered associations and unsent files remain files. Verify each old ID and each message's ordered list, plus `PRAGMA foreign_key_check`.
3. Compare metadata/lists/keys against the backup, download originals and thumbnails via the old IDs/URLs, then start the new candidate and execute the plan's actual UI/CLI journeys. Do not hash, copy or rewrite legacy objects.
4. Collection is a separate offline operation after its retention decision. Stop all writers again. Content-addressed prefixes enumerate new orphan candidates. Legacy candidates can only be provided as exact keys in an explicit newline-separated file via `--candidate-keys`; legacy prefixes are never swept. Each candidate is checked against every file's original and thumbnail key. Referenced objects remain in place.

Commands, from `src/web` (replace placeholders with the isolated resources). Wrangler uses `STATE_ROOT/v3` inside its `--persist-to STATE_ROOT`; `getPlatformProxy` uses its persist path directly. Therefore the maintenance CLI must receive the actual `STATE_ROOT/v3` directory, not the Wrangler state root. The proof must also record this exact absolute `localState`:

```sh
pnpm exec wrangler d1 migrations apply <local-database-name> --local --config /absolute/local-wrangler.jsonc --persist-to /absolute/STATE_ROOT
pnpm exec tsx scripts/attachment-maintenance.ts collect --config /absolute/local-wrangler.jsonc --local-state /absolute/STATE_ROOT/v3 --manifest /absolute/collection.jsonl
```

The last command is dry-run. Local apply additionally requires `--apply --quiescence-proof`. The local proof records absolute `configPath`, absolute `localState`, `writersStopped: true`, `invocationsDrained: true`, `stoppedWriterPids`, an `evidence` reference and `expiresAt`. These are records of the completed local stop procedure. The script checks that those PIDs remain absent and the record remains current before each write/delete. A proof is not a replacement for enumerating and stopping every writer.

Use owner-only permissions for backup/state/manifest files. They contain private identifiers and storage keys. Do not attach production data or manifests to public channels. Never include credentials in them.

## Production release gate and rollback

The current CLI cannot apply against remote bindings. Keep the PR unmerged while automatic production deployment could run the new schema-dependent code before migration. No version bump or deployment is authorized by this document.

The release operator must first obtain a verified platform termination contract covering old invocations and background cleanup, or a separately reviewed isolation mechanism that prevents old writers from modifying the migrated DB/R2. The current repository has neither verified mechanism. Sampled logs without requests are not a proof. Until this gate is resolved, use collection dry-run only for any approved remote inspection and retain all objects.

With a verified future gate, snapshot D1 before the short write maintenance window, retain the prior Worker artifact and old objects, complete schema verification and confirm legacy object keys/bytes are unchanged, and only then reopen writes on the exact validated candidate. Record the real stop/restore operations, object retention decision, missing-object count and checksums.

Before reopening writes, restore the complete D1 backup and prior Worker together; retained old objects make that restore possible. After new multi-message associations exist, the old schema cannot represent them without loss. Do not roll back only the Worker or collapse references. Fix forward or prepare and validate an explicit reverse transformation while stopped.
