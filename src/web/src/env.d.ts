interface RuntimeEnv {
  ENCRYPTION_KEY: string
  AUTH_OTP_RATE_LIMIT_MAX?: string
  AUTH_OTP_RATE_LIMIT_WINDOW_SEC?: string
  DEVICE_CLIENT_IDS?: string
  NODE_ENV?: string
  DEV_WS_DO_URL?: string
  DEV_WAKE_WORKER_URL?: string
}

declare namespace Cloudflare {
  interface Env extends RuntimeEnv {
    DB: D1Database
    EMAIL_BUCKET: R2Bucket
    COMMUNITY_MEDIA: R2Bucket
    BUG_REPORTS: R2Bucket
    WS_DO_WORKER: Fetcher
    EMAIL_WORKER: Fetcher
    WAKE_QUEUE: Queue<import("@alook/shared").WakePayload>
    WAKE_WORKER: Fetcher
    WORKER_SELF_REFERENCE: Fetcher
    NEXT_INC_CACHE_R2_BUCKET: R2Bucket
    NEXT_TAG_CACHE_D1: D1Database
    NEXT_CACHE_DO_QUEUE: DurableObjectNamespace
    GITHUB_CLIENT_ID: string
    GITHUB_CLIENT_SECRET: string
    GOOGLE_CLIENT_ID: string
    GOOGLE_CLIENT_SECRET: string
    BETTER_AUTH_SECRET: string
    BETTER_AUTH_URL: string
    CACHE_KV: KVNamespace
    BUG_REPORTS_ENABLED?: string
    RUNTIME_MODEL_OPTIONS?: string
    MIN_CLI_VERSION?: string
  }
}

type Env = CloudflareEnv

// Wrangler 4.119 emits CloudflareEnv from config bindings directly. Merge the
// app's non-config runtime variables above back into that generated interface.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface CloudflareEnv extends RuntimeEnv {}
