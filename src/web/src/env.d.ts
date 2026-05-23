declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    EMAIL_BUCKET: R2Bucket
    WS_DO_WORKER: Fetcher
    EMAIL_WORKER: Fetcher
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
    ENCRYPTION_KEY: string
    RATE_LIMIT_KV: KVNamespace
    CACHE_KV: KVNamespace
    AUTH_OTP_RATE_LIMIT_MAX?: string
    AUTH_OTP_RATE_LIMIT_WINDOW_SEC?: string
    RUNTIME_MODEL_OPTIONS?: string
    MIN_CLI_VERSION?: string
    NODE_ENV?: string
  }
}

type Env = CloudflareEnv
