/**
 * Minimal ISO/IEC 18004 QR Code encoder (Byte mode, Error Correction Level M,
 * Versions 1–10, up to 213 UTF-8 bytes) for rendering scannable SVG QR codes
 * locally without external dependencies or network fetches.
 */

export interface QrCodeMatrix {
  version: number
  size: number
  modules: boolean[][]
  /** Combined SVG path (`M x y h1 v1 h-1 z`) in module coordinates `[0, size]`. */
  pathData: string
}

interface VersionSpec {
  version: number
  totalDataBytes: number
  eccPerBlock: number
  blocks: ReadonlyArray<readonly [count: number, dataBytes: number]>
  alignment: readonly number[]
}

// ISO/IEC 18004 Table 9 (Error Correction Level M) + Annex E alignment coords.
const VERSION_SPECS: readonly VersionSpec[] = [
  { version: 1, totalDataBytes: 16, eccPerBlock: 10, blocks: [[1, 16]], alignment: [] },
  { version: 2, totalDataBytes: 28, eccPerBlock: 16, blocks: [[1, 28]], alignment: [6, 18] },
  { version: 3, totalDataBytes: 44, eccPerBlock: 26, blocks: [[1, 44]], alignment: [6, 22] },
  { version: 4, totalDataBytes: 64, eccPerBlock: 18, blocks: [[2, 32]], alignment: [6, 26] },
  { version: 5, totalDataBytes: 86, eccPerBlock: 24, blocks: [[2, 43]], alignment: [6, 30] },
  { version: 6, totalDataBytes: 108, eccPerBlock: 16, blocks: [[4, 27]], alignment: [6, 34] },
  { version: 7, totalDataBytes: 124, eccPerBlock: 18, blocks: [[4, 31]], alignment: [6, 22, 38] },
  { version: 8, totalDataBytes: 154, eccPerBlock: 22, blocks: [[2, 38], [2, 39]], alignment: [6, 24, 42] },
  { version: 9, totalDataBytes: 182, eccPerBlock: 22, blocks: [[3, 36], [2, 37]], alignment: [6, 26, 46] },
  { version: 10, totalDataBytes: 216, eccPerBlock: 26, blocks: [[4, 43], [1, 44]], alignment: [6, 28, 50] },
]

// GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d).
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255]!
  }
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1)
    const factor = GF_EXP[i]!
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!
      next[j + 1] ^= gfMul(poly[j]!, factor)
    }
    poly = next
  }
  return poly
}

function rsComputeEcc(data: Uint8Array, eccLen: number): Uint8Array {
  const gen = rsGeneratorPoly(eccLen)
  const remainder = new Uint8Array(eccLen)
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ remainder[0]!
    for (let j = 0; j < eccLen - 1; j++) {
      remainder[j] = remainder[j + 1]!
    }
    remainder[eccLen - 1] = 0
    if (factor !== 0) {
      for (let j = 0; j < eccLen; j++) {
        remainder[j] ^= gfMul(gen[j + 1]!, factor)
      }
    }
  }
  return remainder
}

function pushBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) {
    bits.push((value >>> i) & 1)
  }
}

function selectVersion(byteLength: number): VersionSpec {
  for (const spec of VERSION_SPECS) {
    const countBits = spec.version <= 9 ? 8 : 16
    const capacityBits = spec.totalDataBytes * 8
    const requiredBits = 4 + countBits + byteLength * 8
    if (requiredBits <= capacityBits) return spec
  }
  throw new Error("QR payload exceeds supported Version 10 Level M capacity (213 bytes)")
}

function buildCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const bits: number[] = []
  const countBits = spec.version <= 9 ? 8 : 16
  pushBits(bits, 0b0100, 4) // Byte mode indicator
  pushBits(bits, bytes.length, countBits)
  for (const b of bytes) pushBits(bits, b, 8)

  const capacityBits = spec.totalDataBytes * 8
  const terminatorLen = Math.min(4, capacityBits - bits.length)
  pushBits(bits, 0, terminatorLen)
  while (bits.length % 8 !== 0) bits.push(0)

  const data = new Uint8Array(spec.totalDataBytes)
  const filledBytes = bits.length / 8
  for (let i = 0; i < filledBytes; i++) {
    let value = 0
    for (let b = 0; b < 8; b++) {
      value = (value << 1) | bits[i * 8 + b]!
    }
    data[i] = value
  }
  for (let i = filledBytes, padIndex = 0; i < spec.totalDataBytes; i++, padIndex++) {
    data[i] = padIndex % 2 === 0 ? 0xec : 0x11
  }

  const dataBlocks: Uint8Array[] = []
  const eccBlocks: Uint8Array[] = []
  let offset = 0
  for (const [count, blockLen] of spec.blocks) {
    for (let i = 0; i < count; i++) {
      const slice = data.slice(offset, offset + blockLen)
      offset += blockLen
      dataBlocks.push(slice)
      eccBlocks.push(rsComputeEcc(slice, spec.eccPerBlock))
    }
  }

  const totalBlocks = dataBlocks.length
  const totalBytes = spec.totalDataBytes + totalBlocks * spec.eccPerBlock
  const out = new Uint8Array(totalBytes)
  let outIndex = 0
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length))
  for (let col = 0; col < maxDataLen; col++) {
    for (const block of dataBlocks) {
      if (col < block.length) out[outIndex++] = block[col]!
    }
  }
  for (let col = 0; col < spec.eccPerBlock; col++) {
    for (const block of eccBlocks) {
      out[outIndex++] = block[col]!
    }
  }
  return out
}

function bchFormatBits(mask: number): number {
  // Error Correction Level M = 0b00
  const data = (0b00 << 3) | (mask & 7)
  let rem = data << 10
  for (let i = 14; i >= 10; i--) {
    if (rem & (1 << i)) rem ^= 0x537 << (i - 10)
  }
  return ((data << 10) | rem) ^ 0x5412
}

function bchVersionBits(version: number): number {
  let rem = version << 12
  for (let i = 17; i >= 12; i--) {
    if (rem & (1 << i)) rem ^= 0x1f25 << (i - 12)
  }
  return (version << 12) | rem
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0
    case 1: return row % 2 === 0
    case 2: return col % 3 === 0
    case 3: return (row + col) % 3 === 0
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

function drawFormatInfo(modules: boolean[][], size: number, mask: number): void {
  const bits = bchFormatBits(mask)
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1
    // Vertical near top-left & bottom-left
    if (i < 6) modules[i]![8] = dark
    else if (i < 8) modules[i + 1]![8] = dark
    else modules[size - 15 + i]![8] = dark

    // Horizontal near top-right & top-left
    if (i < 8) modules[8]![size - 1 - i] = dark
    else if (i < 9) modules[8]![15 - i] = dark
    else modules[8]![14 - i] = dark
  }
  modules[size - 8]![8] = true // Always-dark module
}

function drawVersionInfo(modules: boolean[][], isFunc: boolean[][], size: number, version: number): void {
  if (version < 7) return
  const bits = bchVersionBits(version)
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1
    const a = size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    modules[b]![a] = dark
    isFunc[b]![a] = true
    modules[a]![b] = dark
    isFunc[a]![b] = true
  }
}

function penaltyScore(modules: boolean[][], size: number): number {
  let score = 0
  // Rule 1: 5+ adjacent same-color modules in row/col
  for (let r = 0; r < size; r++) {
    let runColor = modules[r]![0]!
    let runLen = 1
    for (let c = 1; c < size; c++) {
      if (modules[r]![c] === runColor) {
        runLen++
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5)
        runColor = modules[r]![c]!
        runLen = 1
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5)
  }
  for (let c = 0; c < size; c++) {
    let runColor = modules[0]![c]!
    let runLen = 1
    for (let r = 1; r < size; r++) {
      if (modules[r]![c] === runColor) {
        runLen++
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5)
        runColor = modules[r]![c]!
        runLen = 1
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5)
  }
  // Rule 2: 2x2 same-color blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r]![c]!
      if (v === modules[r]![c + 1] && v === modules[r + 1]![c] && v === modules[r + 1]![c + 1]) {
        score += 3
      }
    }
  }
  // Rule 4: dark ratio balance
  let darkCount = 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r]![c]) darkCount++
    }
  }
  const total = size * size
  const k = Math.floor(Math.abs(darkCount * 20 - total * 10) / total)
  score += k * 10
  return score
}

export function encodeQrCode(text: string): QrCodeMatrix {
  const bytes = new TextEncoder().encode(text)
  const spec = selectVersion(bytes.length)
  const size = spec.version * 4 + 17
  const modules: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  const isFunc: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false))

  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return
    modules[r]![c] = dark
    isFunc[r]![c] = true
  }

  // Finder patterns + 1-module white separators
  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
        setFunc(top + dr, left + dc, inOuter && (onBorder || inCore))
      }
    }
  }
  drawFinder(0, 0)
  drawFinder(0, size - 7)
  drawFinder(size - 7, 0)

  // Alignment patterns
  for (let i = 0; i < spec.alignment.length; i++) {
    for (let j = 0; j < spec.alignment.length; j++) {
      const isCorner =
        (i === 0 && j === 0) ||
        (i === 0 && j === spec.alignment.length - 1) ||
        (i === spec.alignment.length - 1 && j === 0)
      if (isCorner) continue
      const cr = spec.alignment[i]!
      const cc = spec.alignment[j]!
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc))
          setFunc(cr + dr, cc + dc, dist === 2 || dist === 0)
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0)
    setFunc(i, 6, i % 2 === 0)
  }

  // Reserve format info strips
  for (let i = 0; i <= 8; i++) {
    if (!isFunc[i]![8]) setFunc(i, 8, false)
    if (!isFunc[8]![i]) setFunc(8, i, false)
  }
  for (let i = size - 8; i < size; i++) {
    setFunc(i, 8, false)
    setFunc(8, i, false)
  }
  drawVersionInfo(modules, isFunc, size, spec.version)

  // Place codewords in 2-column upward/downward zigzag
  const codewords = buildCodewords(bytes, spec)
  const totalBits = codewords.length * 8
  let bitIdx = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // Skip vertical timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (let dx = 0; dx < 2; dx++) {
        const col = right - dx
        if (isFunc[row]![col]) continue
        const dark =
          bitIdx < totalBits
            ? ((codewords[bitIdx >>> 3]! >>> (7 - (bitIdx & 7))) & 1) === 1
            : false
        modules[row]![col] = dark
        bitIdx++
      }
    }
    upward = !upward
  }

  // Pick optimal mask 0..7
  let bestMask = 0
  let bestScore = Number.POSITIVE_INFINITY
  let bestModules = modules
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row, r) =>
      row.map((val, c) => (isFunc[r]![c] ? val : val !== maskBit(mask, r, c))),
    )
    drawFormatInfo(candidate, size, mask)
    const score = penaltyScore(candidate, size)
    if (score < bestScore) {
      bestScore = score
      bestMask = mask
      bestModules = candidate
    }
  }
  void bestMask

  const parts: string[] = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (bestModules[r]![c]) {
        parts.push(`M${c} ${r}h1v1h-1z`)
      }
    }
  }

  return {
    version: spec.version,
    size,
    modules: bestModules,
    pathData: parts.join(""),
  }
}
