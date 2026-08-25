import { stopServicesAndRestore } from "./services"

export default async function globalTeardown(): Promise<void> {
  await stopServicesAndRestore()
}
