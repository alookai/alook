declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    EMAIL_BUCKET: R2Bucket
    WS_DO_WORKER: Fetcher
    NEXT_INC_CACHE_R2_BUCKET: R2Bucket
    NEXT_TAG_CACHE_D1: D1Database
    NEXT_CACHE_DO_QUEUE: DurableObjectNamespace
    GITHUB_CLIENT_ID: string
    GITHUB_CLIENT_SECRET: string
    GOOGLE_CLIENT_ID: string
    GOOGLE_CLIENT_SECRET: string
    BETTER_AUTH_SECRET: string
    BETTER_AUTH_URL: string
  }
}

type Env = CloudflareEnv
