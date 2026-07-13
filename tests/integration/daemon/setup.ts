if (!process.env.APP_URL) {
  process.env.APP_URL = "http://localhost:3000"
}
if (!process.env.WS_DO_URL) {
  process.env.WS_DO_URL = "ws://localhost:8789"
}
if (!process.env.WAKE_WORKER_HEALTH_URL) {
  process.env.WAKE_WORKER_HEALTH_URL = "http://localhost:8790"
}
