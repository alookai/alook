const stripeZeroDecimalChargeCurrencies = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
])

const iso4217Currencies = new Set(Intl.supportedValuesOf("currency"))

export function stripeAmountToMajorUnit(amount: number, currency: string): number | null {
  const normalizedCurrency = currency.toUpperCase()
  if (!Number.isSafeInteger(amount) || amount < 0 || !iso4217Currencies.has(normalizedCurrency)) return null
  return amount / (stripeZeroDecimalChargeCurrencies.has(normalizedCurrency.toLowerCase()) ? 1 : 100)
}
