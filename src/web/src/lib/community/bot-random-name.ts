import { names, uniqueNamesGenerator } from "unique-names-generator"

export function randomBotName(): string {
  return uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "capital" })
}
