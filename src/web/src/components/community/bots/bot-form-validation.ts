export interface BotCreateRequiredFields {
  name: string
  machineId: string
  runtime: string
}

export interface BotCreateFieldErrors {
  name?: string
  machineId?: string
  runtime?: string
}

export function validateBotCreateFields({
  name,
  machineId,
  runtime,
}: BotCreateRequiredFields): BotCreateFieldErrors {
  const errors: BotCreateFieldErrors = {}

  if (!name.trim()) {
    errors.name = "Name is required"
  }
  if (!machineId) {
    errors.machineId = "Pick a machine"
  }
  if (!runtime) {
    errors.runtime = "Pick a runtime"
  }

  return errors
}

export function hasBotCreateFieldErrors(errors: BotCreateFieldErrors): boolean {
  return Boolean(errors.name || errors.machineId || errors.runtime)
}
