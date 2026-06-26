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

export interface MultipartMessageOptions {
  withContentLength?: boolean
}

export class MultipartMessage {
  boundary: string
  content: Uint8Array
  #chunkCache = new Map<number, Uint8Array[]>()

  constructor(
    boundary: string,
    partSizesOrContents: number[] | Uint8Array[],
    options: MultipartMessageOptions = {},
  ) {
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
      if (options.withContentLength) {
        pushLine(`Content-Length: ${partContents[i].length}`)
      }
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

// ---------- HTML fragment scenarios ----------
//
// Realistic shape for hypermedia server-push: many small parts whose bodies
// are HTML text. No '\r' bytes appear inside body content (LF line breaks
// only). This is the workload where memchr-style searches potentially shine.

const HTML_TEMPLATE = `<div class="message" id="msg-__N__">
  <header class="msg-header">
    <span class="user">user__N__@example.com</span>
    <time datetime="2026-06-26T12:34:56Z">just now</time>
  </header>
  <div class="msg-body">
    <p>This is hypermedia fragment __N__ with some readable text content.</p>
    <p>Server-pushed HTML over a long-lived multipart/mixed stream.</p>
  </div>
</div>`

function makeHtmlFragment(index: number, targetSize: number): Uint8Array {
  let text = HTML_TEMPLATE.replaceAll('__N__', String(index))
  while (text.length < targetSize) {
    text += `\n<p>Filler line ${text.length} to reach target size.</p>`
  }
  return new TextEncoder().encode(text.slice(0, targetSize))
}

function makeHtmlFragments(count: number, sizeFn: (i: number) => number): Uint8Array[] {
  return Array.from({ length: count }, (_, i) => makeHtmlFragment(i, sizeFn(i)))
}

// 1000 tiny HTML fragments (~200 B each), like a chatty real-time feed.
export const manyTinyHtmlFragments = new MultipartMessage(
  boundary,
  makeHtmlFragments(1000, () => 200),
)

// 100 typical fragments (~1 KiB each), like a moderate hypermedia stream.
export const typicalHtmlBurst = new MultipartMessage(
  boundary,
  makeHtmlFragments(100, () => oneKb),
)

// 50 mixed-size fragments (200 B - 5 KiB), more realistic distribution.
export const realisticHtmlBurst = new MultipartMessage(
  boundary,
  makeHtmlFragments(50, (i) => 200 + ((i * 97) % (5 * oneKb))),
)

// One large HTML page (100 KiB), like a server-rendered initial response.
export const oneLargeHtmlPage = new MultipartMessage(boundary, [
  makeHtmlFragment(0, 100 * oneKb),
])

// ---------- Content-Length variants ----------
//
// Same payloads as above but with a Content-Length header on each part. Lets
// the parser take the fast-path read instead of scanning for the boundary.

export const oneHundredSmallFilesWithContentLength = new MultipartMessage(
  boundary,
  Array(100).fill(oneKb),
  { withContentLength: true },
)
export const oneLargeFileWithContentLength = new MultipartMessage(
  boundary,
  [10 * oneMb],
  { withContentLength: true },
)
export const manyTinyHtmlFragmentsWithContentLength = new MultipartMessage(
  boundary,
  makeHtmlFragments(1000, () => 200),
  { withContentLength: true },
)
export const typicalHtmlBurstWithContentLength = new MultipartMessage(
  boundary,
  makeHtmlFragments(100, () => oneKb),
  { withContentLength: true },
)
