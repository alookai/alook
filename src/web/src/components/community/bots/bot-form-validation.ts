import { requiresExplicitModel } from "@alook/shared"

export interface BotCreateRequiredFields {
  name: string
  machineId: string
  runtime: string
  model: string | null
}

export interface BotCreateFieldErrors {
  name?: string
  machineId?: string
  runtime?: string
  model?: string
}

export function validateBotCreateFields({
  name,
  machineId,
  runtime,
  model,
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
  errors.model = validateBotModel(model, runtime)

  return errors
}

export function hasBotCreateFieldErrors(errors: BotCreateFieldErrors): boolean {
  return Boolean(errors.name || errors.machineId || errors.runtime || errors.model)
}

export function validateBotModel(model: string | null, runtime?: string): string | undefined {
  if (requiresExplicitModel(runtime) && !model?.trim()) return "Choose a model before saving"
  if (model === null) return undefined
  if (model.trim().length === 0) return "Enter a model name"
  if (model.length > 100) return "Model name must be 100 characters or fewer"
  return undefined
}
