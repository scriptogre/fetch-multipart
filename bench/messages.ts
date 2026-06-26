// Multipart message fixtures. Ported from @remix-run/multipart-parser's bench
// suite (MIT, Shopify Inc).

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function getRandomBytes(size: number): Uint8Array {
  const chunks: Uint8Array[] = []
  for (let i = 0; i < size; i += 65536) {
    chunks.push(crypto.getRandomValues(new Uint8Array(Math.min(size - i, 65536))))
  }
  return concat(chunks)
}

const NodeDefaultHighWaterMark = 65536

export class MultipartMessage {
  boundary: string
  content: Uint8Array
  #chunkCache = new Map<number, Uint8Array[]>()

  constructor(boundary: string, partSizesOrContents: number[] | Uint8Array[]) {
    this.boundary = boundary

    const chunks: Uint8Array[] = []
    const enc = new TextEncoder()
    const pushLine = (line = '') => chunks.push(enc.encode(line + '\r\n'))

    const partContents =
      typeof partSizesOrContents[0] === 'number'
        ? (partSizesOrContents as number[]).map((size) => getRandomBytes(size))
        : (partSizesOrContents as Uint8Array[])

    for (let i = 0; i < partContents.length; i++) {
      pushLine(`--${boundary}`)
      pushLine(`Content-Disposition: form-data; name="file${i}"; filename="file${i}.dat"`)
      pushLine('Content-Type: application/octet-stream')
      pushLine()
      chunks.push(partContents[i])
      pushLine()
    }
    chunks.push(enc.encode(`--${boundary}--`))

    this.content = concat(chunks)
  }

  getChunks(chunkSize = NodeDefaultHighWaterMark): Uint8Array[] {
    const cached = this.#chunkCache.get(chunkSize)
    if (cached) return cached

    const chunks: Uint8Array[] = []
    for (let i = 0; i < this.content.length; i += chunkSize) {
      chunks.push(this.content.subarray(i, i + chunkSize))
    }
    this.#chunkCache.set(chunkSize, chunks)
    return chunks
  }

  toReadableStream(chunkSize = NodeDefaultHighWaterMark): ReadableStream<Uint8Array> {
    const chunks = this.getChunks(chunkSize)
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
  }
}

const oneKb = 1024
const oneMb = 1024 * oneKb
const boundary = '----WebKitFormBoundaryzv0Og5zWtGjvzP2A'

// Adversarial: bytes are filled with a repeating pattern that almost matches
// the boundary (one char short). Stresses the boundary-search algorithm with
// constant false starts.
function createAdversarialBytes(size: number, boundary: string): Uint8Array {
  const repeatingPattern = new TextEncoder().encode(`\r\n--${boundary.slice(0, -1)}X`)
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i += repeatingPattern.length) {
    bytes.set(repeatingPattern.subarray(0, Math.min(repeatingPattern.length, size - i)), i)
  }
  return bytes
}

export const oneSmallFile = new MultipartMessage(boundary, [oneKb])
export const oneLargeFile = new MultipartMessage(boundary, [10 * oneMb])
export const oneHundredSmallFiles = new MultipartMessage(boundary, Array(100).fill(oneKb))
export const fiveLargeFiles = new MultipartMessage(boundary, [
  10 * oneMb,
  10 * oneMb,
  10 * oneMb,
  20 * oneMb,
  50 * oneMb,
])
export const oneLargeFileAdversarial = new MultipartMessage(boundary, [
  createAdversarialBytes(10 * oneMb, boundary),
])
export const fiveLargeFilesAdversarial = new MultipartMessage(boundary, [
  createAdversarialBytes(10 * oneMb, boundary),
  createAdversarialBytes(10 * oneMb, boundary),
  createAdversarialBytes(10 * oneMb, boundary),
  createAdversarialBytes(20 * oneMb, boundary),
  createAdversarialBytes(50 * oneMb, boundary),
])
