import { stopServicesAndRestore } from "./services"
import { measureSetupAsync } from "./setup-work"

export default async function globalTeardown(): Promise<void> {
  await measureSetupAsync("global-teardown", stopServicesAndRestore)
}
