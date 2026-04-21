export interface EmailEnv {
  DB: D1Database
  EMAIL_BUCKET: R2Bucket
  WEB_SERVICE: Fetcher
  SEND_EMAIL: SendEmail
  IMAP_POLLER: DurableObjectNamespace
  BETTER_AUTH_SECRET: string
}
