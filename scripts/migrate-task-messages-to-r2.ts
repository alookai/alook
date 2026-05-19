/**
 * One-off script to migrate existing task_message rows from D1 to R2.
 *
 * Prerequisites:
 * - Environment variables: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
 * - R2 bucket "alook-task-messages" created
 * - D1 database still has content/input/output columns (run BEFORE migration 0030)
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=xxx npx tsx scripts/migrate-task-messages-to-r2.ts
 *
 * Options:
 *   --dry-run    Print what would be migrated without writing to R2
 *   --offset N   Start from task index N (for resuming interrupted runs)
 */

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const D1_DATABASE_ID = "1593b87c-d8a8-4cdf-b6c0-c80d94442654";
const R2_BUCKET = "alook-task-messages";

const BATCH_SIZE = 50;
const D1_ROW_LIMIT = 10000;
const CONCURRENCY = 5;

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const offsetIdx = args.indexOf("--offset");
const startOffset = offsetIdx !== -1 ? parseInt(args[offsetIdx + 1], 10) : 0;

interface TaskMessageRow {
  id: string;
  task_id: string;
  seq: number;
  type: string;
  tool: string;
  call_id: string;
  content: string;
  input: string | null;
  output: string;
  created_at: string;
}

async function queryD1(sql: string, params: string[] = []): Promise<any[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    }
  );
  const json = (await res.json()) as any;
  if (!json.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
  }
  return json.result[0].results;
}

async function putR2(key: string, body: string): Promise<void> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body,
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 PUT failed for ${key}: ${res.status} ${text}`);
  }
}

async function processTask(taskId: string): Promise<{ rows: number }> {
  const rows: TaskMessageRow[] = await queryD1(
    `SELECT id, task_id, seq, type, tool, call_id, content, input, output, created_at
     FROM task_message WHERE task_id = ? ORDER BY seq ASC LIMIT ${D1_ROW_LIMIT}`,
    [taskId]
  );

  if (rows.length === 0) return { rows: 0 };

  const messages = rows.map((r) => ({
    id: r.id,
    task_id: r.task_id,
    seq: r.seq,
    type: r.type,
    tool: r.tool,
    call_id: r.call_id,
    content: r.content,
    ...(r.input ? { input: JSON.parse(r.input) } : {}),
    output: r.output,
    created_at: r.created_at,
  }));

  const key = `task-messages/${taskId}.json`;
  const json = JSON.stringify(messages);

  if (!dryRun) {
    await putR2(key, json);
  }

  return { rows: rows.length };
}

async function migrate() {
  console.log(`Fetching distinct task IDs...`);
  const taskRows = await queryD1("SELECT DISTINCT task_id FROM task_message ORDER BY task_id");
  const allTaskIds = taskRows.map((r: any) => r.task_id as string);
  const taskIds = allTaskIds.slice(startOffset);

  console.log(`Total tasks: ${allTaskIds.length}, starting from offset: ${startOffset}`);
  console.log(`Tasks to process: ${taskIds.length}`);
  if (dryRun) console.log("*** DRY RUN — no R2 writes ***");

  let migrated = 0;
  let failed = 0;
  let totalRows = 0;

  for (let i = 0; i < taskIds.length; i += BATCH_SIZE) {
    const batch = taskIds.slice(i, i + BATCH_SIZE);

    // Process batch with limited concurrency
    const chunks: string[][] = [];
    for (let j = 0; j < batch.length; j += CONCURRENCY) {
      chunks.push(batch.slice(j, j + CONCURRENCY));
    }

    for (const chunk of chunks) {
      const results = await Promise.allSettled(
        chunk.map(async (taskId) => {
          const { rows } = await processTask(taskId);
          return rows;
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") {
          migrated++;
          totalRows += r.value;
        } else {
          failed++;
          console.error(`  FAILED:`, r.reason);
        }
      }
    }

    const progress = startOffset + i + batch.length;
    console.log(
      `[${progress}/${allTaskIds.length}] migrated=${migrated} failed=${failed} rows=${totalRows}`
    );
  }

  console.log(`\n=== DONE ===`);
  console.log(`Tasks migrated: ${migrated}`);
  console.log(`Tasks failed: ${failed}`);
  console.log(`Total rows: ${totalRows}`);
  if (dryRun) console.log("(dry run — no actual writes)");
}

migrate().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
