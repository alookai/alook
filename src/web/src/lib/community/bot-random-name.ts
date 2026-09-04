import { names, uniqueNamesGenerator } from "unique-names-generator"

/** The same one-word generated name used by the ordinary bot creation flow. */
export function randomBotName(): string {
  return uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "capital" })
}
