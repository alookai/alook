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

/**
 * Validate a picked model value (the `string | null` the ModelField emits). A
 * `Custom…` selection that was left empty resolves to `null` (Default), which
 * is valid; the only failure is a name over the server's 100-char cap. Returns
 * an error message, or undefined when the model is acceptable.
 */
export function validateBotModel(model: string | null): string | undefined {
  if (model === null) return undefined
  if (model.trim().length === 0) return "Enter a model name"
  if (model.length > 100) return "Model name must be 100 characters or fewer"
  return undefined
}
