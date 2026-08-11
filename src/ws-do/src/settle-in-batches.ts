export function settleInBatches<Input, Output>(
  inputs: readonly Input[],
  mapper: (input: Input, index: number) => Output | PromiseLike<Output>,
  batchSize: number,
): Promise<PromiseSettledResult<Awaited<Output>>[]> {
  if (!Number.isFinite(batchSize) || !Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("batchSize must be a finite integer greater than zero")
  }

  return settleValidBatches(inputs, mapper, batchSize)
}

async function settleValidBatches<Input, Output>(
  inputs: readonly Input[],
  mapper: (input: Input, index: number) => Output | PromiseLike<Output>,
  batchSize: number,
): Promise<PromiseSettledResult<Awaited<Output>>[]> {
  const results: PromiseSettledResult<Awaited<Output>>[] = []

  for (let start = 0; start < inputs.length; start += batchSize) {
    const batch = inputs.slice(start, start + batchSize)
    const batchResults = await Promise.allSettled(
      batch.map((input, offset) => Promise.resolve().then(() => mapper(input, start + offset))),
    )
    results.push(...batchResults)
  }

  return results
}
