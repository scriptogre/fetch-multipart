// @ts-self-types="./fetch-multipart.d.ts"
// Streaming multipart parser for the browser.
//
// Public API:
//   Response.prototype.parts()            -> AsyncIterable<BodyPart>
//   BodyPart.prototype.parts()            -> AsyncIterable<BodyPart>
//   getMultipartBoundary(contentType)     -> string | null
//   parseContentDisposition(header)       -> { type, name, filename }
//   class BodyPart implements Body
//   class MultipartParser
//   class MultipartParseError extends Error
//
// Parser engine ported from @remix-run/multipart-parser (MIT, Shopify Inc).
// https://github.com/remix-run/remix/tree/main/packages/multipart-parser

/**
 * Thrown when a multipart stream cannot be parsed.
 */
export class MultipartParseError extends TypeError {
  constructor(message) {
    super(message)
    this.name = 'MultipartParseError'
  }
}

// ---------- byte search ----------

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

// Boyer-Moore-Horspool over a Uint8Array.
function createSearch(pattern) {
  const needle = utf8Encoder.encode(pattern)
  const needleEnd = needle.length - 1
  const skipTable = new Uint8Array(256).fill(needle.length)
  for (let i = 0; i < needleEnd; ++i) skipTable[needle[i]] = needleEnd - i

  return (haystack, start = 0) => {
    const haystackLength = haystack.length
    let i = start + needleEnd
    while (i < haystackLength) {
      for (let j = needleEnd, k = i; j >= 0 && haystack[k] === needle[j]; --j, --k) {
        if (j === 0) return k
      }
      i += skipTable[haystack[i]]
    }
    return -1
  }
}

// Find the start index (within `haystack[from..]`) where a suffix of haystack
// matches a prefix of `pattern`. Used to detect a boundary split across chunks.
function createPartialTailSearch(pattern) {
  const needle = utf8Encoder.encode(pattern)
  const byteIndexes = Object.create(null)
  for (let i = 0; i < needle.length; ++i) {
    const byte = needle[i]
    if (byteIndexes[byte] === undefined) byteIndexes[byte] = []
    byteIndexes[byte].push(i)
  }

  return (haystack, from = 0) => {
    const haystackEnd = haystack.length - 1
    if (haystackEnd < from) return -1
    const indexes = byteIndexes[haystack[haystackEnd]]
    if (indexes) {
      for (let i = indexes.length - 1; i >= 0; --i) {
        for (let j = indexes[i], k = haystackEnd; j >= 0 && k >= from && haystack[k] === needle[j]; --j, --k) {
          if (j === 0) return k
        }
      }
    }
    return -1
  }
}

// ---------- parser state machine ----------

const State = Object.freeze({
  // Scan for the opening "--boundary", discarding any preamble bytes.
  START: 0,
  // After a boundary, read "\r\n" or "--".
  READING_BOUNDARY_SUFFIX: 1,
  // Read part headers through "\r\n\r\n".
  READING_HEADERS: 2,
  // No Content-Length. Scan for the next boundary.
  READING_BODY_UNTIL_BOUNDARY: 3,
  // Read exactly the declared Content-Length bytes.
  READING_BODY_WITH_CONTENT_LENGTH: 4,
  // Final "--" after a boundary was read.
  DONE: 5,
})

const findDoubleNewline = createSearch('\r\n\r\n')
const contentLengthRegex = /^content-length:\s*(\d+)/im

function extractContentLength(headerBytes) {
  const match = contentLengthRegex.exec(utf8Decoder.decode(headerBytes))
  return match ? Number(match[1]) : -1
}

export class MultipartParser {
  #findOpeningBoundary
  #openingBoundaryLength
  #findBoundary
  #findPartialTailBoundary
  #boundaryLength
  #boundaryBytes

  #state = State.START
  #buffer = null
  #currentHeader = null
  #remainingBodyBytes = 0
  #activePart = null

  /**
   * Driver hook: called when the active part's body stream wants more bytes.
   * The driver should pump from its source until the controller is satisfied.
   *
   * @type {((part: BodyPart) => Promise<void>) | null}
   */
  onPull = null

  constructor(boundary) {
    // RFC 2046 §5.1.1 limits the boundary to 1-70 ASCII characters from a
    // small subset. Real-world implementations stick to printable ASCII; we
    // enforce that broader range so non-ASCII boundaries fail loudly instead
    // of silently misaligning the parser's char-length arithmetic.
    if (!/^[\x20-\x7E]{1,70}$/.test(boundary)) {
      throw new MultipartParseError(
        'Invalid boundary: must be 1-70 printable ASCII characters',
      )
    }

    this.boundary = boundary
    this.#findOpeningBoundary = createSearch(`--${boundary}`)
    this.#openingBoundaryLength = 2 + boundary.length
    const boundaryPattern = `\r\n--${boundary}`
    this.#findBoundary = createSearch(boundaryPattern)
    this.#findPartialTailBoundary = createPartialTailSearch(boundaryPattern)
    this.#boundaryLength = 4 + boundary.length
    this.#boundaryBytes = utf8Encoder.encode(boundaryPattern)
  }

  /** The part currently receiving body bytes, or null. */
  get activePart() {
    return this.#activePart
  }

  *write(chunk) {
    // Discard epilogue bytes after the closing boundary (RFC 2046 §5.1.1).
    if (this.#state === State.DONE) return

    let index = 0
    let chunkLength = chunk.length

    if (this.#buffer !== null) {
      if (this.#state === State.READING_BODY_UNTIL_BOUNDARY) {
        const carry = this.#buffer
        this.#buffer = null
        const carryResult = this.#analyzeCarryBoundary(carry, chunk)

        if (carryResult.kind === 'none') {
          this.#routeBody(carry)
        } else if (carryResult.kind === 'partial') {
          if (carryResult.start > 0) this.#routeBody(carry.subarray(0, carryResult.start))
          const tailLength = carry.length + chunk.length - carryResult.start
          const tail = new Uint8Array(tailLength)
          const carryTail = carry.subarray(carryResult.start)
          tail.set(carryTail, 0)
          tail.set(chunk, carryTail.length)
          this.#buffer = tail
          return
        } else {
          if (carryResult.start > 0) this.#routeBody(carry.subarray(0, carryResult.start))
          this.#finalizeActivePart()
          this.#state = State.READING_BOUNDARY_SUFFIX
          const carryAfterStart = carry.length - carryResult.start
          index = this.#boundaryLength - carryAfterStart
        }
      } else {
        const newChunk = new Uint8Array(this.#buffer.length + chunkLength)
        newChunk.set(this.#buffer, 0)
        newChunk.set(chunk, this.#buffer.length)
        chunk = newChunk
        chunkLength = chunk.length
        this.#buffer = null
      }
    }

    while (true) {
      if (this.#state === State.READING_BODY_UNTIL_BOUNDARY) {
        const boundaryIndex = this.#findBoundary(chunk, index)
        if (boundaryIndex === -1) {
          const partialTailIndex = this.#findPartialTailBoundary(chunk, index)
          if (partialTailIndex === -1) {
            this.#routeBody(index === 0 ? chunk : chunk.subarray(index))
          } else {
            if (partialTailIndex > index) this.#routeBody(chunk.subarray(index, partialTailIndex))
            this.#buffer = chunk.subarray(partialTailIndex)
          }
          break
        }

        if (boundaryIndex > index) this.#routeBody(chunk.subarray(index, boundaryIndex))
        this.#finalizeActivePart()
        index = boundaryIndex + this.#boundaryLength
        this.#state = State.READING_BOUNDARY_SUFFIX
      }

      if (this.#state === State.READING_BOUNDARY_SUFFIX) {
        if (chunkLength - index < 2) {
          this.#buffer = chunk.subarray(index)
          break
        }
        // Closing boundary is followed by '--'.
        if (chunk[index] === 45 && chunk[index + 1] === 45) {
          this.#state = State.DONE
          break
        }
        index += 2 // skip \r\n
        this.#state = State.READING_HEADERS
      }

      if (this.#state === State.READING_HEADERS) {
        if (chunkLength - index < 4) {
          this.#buffer = chunk.subarray(index)
          break
        }
        const headerEndIndex = findDoubleNewline(chunk, index)
        if (headerEndIndex === -1) {
          this.#buffer = chunk.subarray(index)
          break
        }
        this.#currentHeader = chunk.subarray(index, headerEndIndex)
        index = headerEndIndex + 4 // skip \r\n\r\n
        const contentLength = extractContentLength(this.#currentHeader)
        this.#activePart = new BodyPart(this.#currentHeader, this.onPull)
        yield this.#activePart
        if (contentLength >= 0) {
          this.#remainingBodyBytes = contentLength
          this.#state = State.READING_BODY_WITH_CONTENT_LENGTH
        } else {
          this.#state = State.READING_BODY_UNTIL_BOUNDARY
        }
        continue
      }

      // Fast path: the part declared its size, so read exactly that many
      // body bytes, then expect the boundary to immediately follow.
      if (this.#state === State.READING_BODY_WITH_CONTENT_LENGTH) {
        const bodyBytes = Math.min(this.#remainingBodyBytes, chunkLength - index)
        if (bodyBytes > 0) this.#routeBody(chunk.subarray(index, index + bodyBytes))
        this.#remainingBodyBytes -= bodyBytes
        index += bodyBytes

        if (this.#remainingBodyBytes > 0) {
          this.#buffer = chunk.subarray(index)
          break
        }
        if (chunkLength - index < this.#boundaryLength) {
          this.#buffer = chunk.subarray(index)
          break
        }
        for (let i = 0; i < this.#boundaryLength; i++) {
          if (chunk[index + i] !== this.#boundaryBytes[i]) {
            const err = new MultipartParseError(
              'Content-Length does not match actual body length',
            )
            this.abortActive(err)
            throw err
          }
        }

        this.#finalizeActivePart()
        index += this.#boundaryLength
        this.#state = State.READING_BOUNDARY_SUFFIX
      }

      if (this.#state === State.START) {
        if (chunkLength < this.#openingBoundaryLength) {
          this.#buffer = chunk
          break
        }
        // Discard preamble bytes before the opening boundary (RFC 2046 §5.1.1).
        const openingIndex = this.#findOpeningBoundary(chunk)
        if (openingIndex === -1) {
          const tailStart = chunkLength - (this.#openingBoundaryLength - 1)
          this.#buffer = chunk.subarray(tailStart)
          break
        }
        index = openingIndex + this.#openingBoundaryLength
        this.#state = State.READING_BOUNDARY_SUFFIX
      }
    }
  }

  finish() {
    // Flush any body bytes still in the carry buffer.
    if (this.#buffer && this.#state === State.READING_BODY_UNTIL_BOUNDARY) {
      this.#routeBody(this.#buffer)
      this.#buffer = null
    }
    if (this.#state !== State.DONE) {
      const err = new MultipartParseError('Stream ended before final boundary')
      this.abortActive(err)
      throw err
    }
  }

  /** Errors the active part's body stream. Used when the source stream errors. */
  abortActive(err) {
    if (this.#activePart) {
      this.#activePart._error(err)
      this.#activePart = null
    }
  }

  #routeBody(chunk) {
    if (chunk.length === 0) return
    if (this.#activePart) this.#activePart._enqueue(chunk)
  }

  #finalizeActivePart() {
    if (this.#activePart) {
      this.#activePart._close()
      this.#activePart = null
    }
  }

  // Detect a boundary whose start lies inside the carry buffer (from the
  // previous chunk) and continues into the current chunk.
  #analyzeCarryBoundary(carry, chunk) {
    const totalLength = carry.length + chunk.length

    for (let start = 0; start < carry.length; ++start) {
      const availableLength = totalLength - start
      const compareLength = Math.min(this.#boundaryLength, availableLength)

      let matched = true
      for (let i = 0; i < compareLength; ++i) {
        const sourceIndex = start + i
        const sourceByte =
          sourceIndex < carry.length ? carry[sourceIndex] : chunk[sourceIndex - carry.length]
        if (sourceByte !== this.#boundaryBytes[i]) {
          matched = false
          break
        }
      }
      if (!matched) continue

      if (availableLength >= this.#boundaryLength) return { kind: 'full', start }
      return { kind: 'partial', start }
    }

    return { kind: 'none' }
  }
}

// ---------- BodyPart (implements Body) ----------

function parseHeaderBytes(raw) {
  const headers = new Headers()
  const text = utf8Decoder.decode(raw)
  for (const line of text.split('\r\n')) {
    const match = line.match(/^([^:]+):(.*)/)
    if (match) headers.append(match[1].trim(), match[2].trim())
  }
  return headers
}

/**
 * A MIME body part. Implements the WHATWG Fetch `Body` interface plus a
 * `parts()` method for recursing into nested `multipart/*` bodies.
 *
 * The body is a live `ReadableStream<Uint8Array>` that receives bytes as the
 * parser sees them. Callers must consume each part's body (or cancel it)
 * before iterating to the next part; iterating past an unread body
 * auto-drains it.
 */
export class BodyPart {
  /** @type {Uint8Array} */ #headerBytes
  /** @type {Headers | null} */ #headers = null
  #bodyUsed = false
  #closed = false
  /** @type {Error | null} */ #error = null

  // Body bytes accumulate here until something accesses `body` or `bytes()` etc.
  // If the parser finishes the part before the consumer touches it, the bytes
  // are returned directly (no ReadableStream construction).
  /** @type {Uint8Array[] | null} */ #pendingChunks = []

  /** @type {ReadableStream<Uint8Array> | null} */ #body = null
  /** @type {ReadableStreamDefaultController<Uint8Array> | null} */ #controller = null
  /** @type {((part: BodyPart) => Promise<void>) | null} */ #pullHook

  /**
   * @param {Uint8Array} headerBytes
   * @param {((part: BodyPart) => Promise<void>) | null} pullHook
   */
  constructor(headerBytes, pullHook) {
    this.#headerBytes = headerBytes
    this.#pullHook = pullHook
  }

  /** @returns {Headers} */
  get headers() {
    if (this.#headers === null) this.#headers = parseHeaderBytes(this.#headerBytes)
    return this.#headers
  }

  /** @returns {boolean} */
  get bodyUsed() {
    return this.#bodyUsed
  }

  /** @returns {ReadableStream<Uint8Array>} */
  get body() {
    if (this.#body === null) this.#materializeBody()
    return this.#body
  }

  /** @returns {Promise<Uint8Array>} */
  async bytes() {
    if (this.#bodyUsed) throw new TypeError('Body already used')
    this.#bodyUsed = true
    if (this.#body === null && this.#closed) {
      if (this.#error) throw this.#error
      const out = concatChunks(this.#pendingChunks)
      this.#pendingChunks = null
      return out
    }
    return new Response(this.body).bytes()
  }

  /** @returns {Promise<ArrayBuffer>} */
  async arrayBuffer() {
    return /** @type {ArrayBuffer} */ ((await this.bytes()).buffer)
  }

  /** @returns {Promise<string>} */
  async text() {
    return utf8Decoder.decode(await this.bytes())
  }

  /** @returns {Promise<any>} */
  async json() {
    return JSON.parse(await this.text())
  }

  /** @returns {Promise<Blob>} */
  async blob() {
    if (this.#bodyUsed) throw new TypeError('Body already used')
    this.#bodyUsed = true
    const type = this.headers.get('content-type') ?? ''
    if (this.#body === null && this.#closed) {
      if (this.#error) throw this.#error
      const blob = new Blob([concatChunks(this.#pendingChunks)], { type })
      this.#pendingChunks = null
      return blob
    }
    return new Response(this.body, { headers: { 'content-type': type } }).blob()
  }

  /**
   * Parse this part's body as a nested `multipart/*` message.
   *
   * @returns {AsyncGenerator<BodyPart, void, unknown>}
   */
  async *parts() {
    if (this.#bodyUsed) throw new TypeError('Body already used')
    this.#bodyUsed = true
    const contentType = this.headers.get('content-type')
    if (!contentType || !contentType.toLowerCase().startsWith('multipart/')) {
      throw new MultipartParseError('Content-Type is not multipart/*')
    }
    const boundary = getMultipartBoundary(contentType)
    if (!boundary) {
      throw new MultipartParseError('Content-Type has no boundary parameter')
    }
    yield* iterateStreamParts(this.body, boundary)
  }

  #materializeBody() {
    const self = this
    const pending = this.#pendingChunks
    this.#pendingChunks = null
    this.#body = new ReadableStream({
      start(controller) {
        self.#controller = controller
        for (const chunk of pending) controller.enqueue(chunk)
        if (self.#error) controller.error(self.#error)
        else if (self.#closed) controller.close()
      },
      async pull() {
        if (self.#pullHook && !self.#closed) await self.#pullHook(self)
      },
      cancel() {
        self.#closed = true
        self.#bodyUsed = true
      },
    })
  }

  // ---- internal: parser ----

  _enqueue(chunk) {
    if (this.#closed) return
    if (this.#controller) this.#controller.enqueue(chunk)
    else this.#pendingChunks.push(chunk)
  }

  _close() {
    if (this.#closed) return
    this.#closed = true
    if (this.#controller) this.#controller.close()
  }

  _error(err) {
    if (this.#closed) return
    this.#closed = true
    if (this.#controller) this.#controller.error(err)
    else this.#error = err
  }

  /** Drop incoming bytes; used when the iterator advances past an unread body. */
  _drain() {
    this.#closed = true
    this.#bodyUsed = true
    this.#pendingChunks = null
  }

  _wantsMore() {
    if (this.#closed) return false
    if (this.#controller) return (this.#controller.desiredSize ?? 0) > 0
    return true
  }
}

function concatChunks(chunks) {
  // Always copy. A returned Uint8Array's `.buffer` should be sized to the body,
  // not the source chunk it was subarray'd from.
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

// ---------- public API ----------

/**
 * @param {string} contentType
 * @returns {string | null}
 */
export function getMultipartBoundary(contentType) {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  return match ? (match[1] ?? match[2].trim()) : null
}

/**
 * @typedef {Object} ContentDispositionParts
 * @property {string | null} type - 'form-data', 'attachment', 'inline', etc.
 * @property {string | null} name - form field name from the `name=` parameter
 * @property {string | null} filename - decoded filename (`filename*=` wins over `filename=`)
 */

/**
 * Parse a `Content-Disposition` header into its components.
 *
 * @param {string | null} header
 * @returns {ContentDispositionParts}
 */
export function parseContentDisposition(header) {
  if (typeof header !== 'string') return { type: null, name: null, filename: null }

  const segments = splitOnUnquotedSemicolon(header)
  const type = segments[0].trim().toLowerCase() || null

  const params = Object.create(null)
  for (let i = 1; i < segments.length; i++) {
    const eq = segments[i].indexOf('=')
    if (eq === -1) continue
    const key = segments[i].slice(0, eq).trim().toLowerCase()
    let value = segments[i].slice(eq + 1).trim()
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1)
    }
    params[key] = value
  }

  const filenameStar = params['filename*']
  const filename = filenameStar != null
    ? decodeRfc5987(filenameStar)
    : (params.filename ?? null)

  return { type, name: params.name ?? null, filename }
}

// Split on `;` but ignore semicolons inside a quoted-string.
function splitOnUnquotedSemicolon(input) {
  const parts = []
  let inQuotes = false
  let start = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    if (ch === 34 /* " */) inQuotes = !inQuotes
    else if (ch === 59 /* ; */ && !inQuotes) {
      parts.push(input.slice(start, i))
      start = i + 1
    }
  }
  parts.push(input.slice(start))
  return parts
}

// Decode an RFC 5987 ext-value: charset'language'percent-encoded.
// https://www.rfc-editor.org/rfc/rfc5987#section-3.2.1
function decodeRfc5987(value) {
  const firstQuote = value.indexOf("'")
  if (firstQuote === -1) return null
  const secondQuote = value.indexOf("'", firstQuote + 1)
  if (secondQuote === -1) return null
  const charset = value.slice(0, firstQuote).toLowerCase()
  const encoded = value.slice(secondQuote + 1)
  if (charset !== 'utf-8') return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

// Iterate the parts of a `Response` whose Content-Type is `multipart/*`.
async function* iterateResponseParts(response) {
  const contentType = response.headers.get('content-type')
  if (!contentType || !contentType.toLowerCase().startsWith('multipart/')) {
    throw new MultipartParseError('Content-Type is not multipart/*')
  }
  if (!response.body) {
    throw new MultipartParseError('Response body is null')
  }
  const boundary = getMultipartBoundary(contentType)
  if (!boundary) {
    throw new MultipartParseError('Content-Type has no boundary parameter')
  }
  yield* iterateStreamParts(response.body, boundary)
}

// Drive the parser over a `ReadableStream<Uint8Array>` with a known boundary.
// Reads source bytes only when the active part's body controller wants more,
// propagating backpressure from consumer to source.
async function* iterateStreamParts(stream, boundary) {
  const parser = new MultipartParser(boundary)
  const reader = stream.getReader()

  const partQueue = []
  let sourceDone = false
  let sourceError = null
  let pumpInflight = null

  async function pumpOnce() {
    try {
      const { done, value } = await reader.read()
      if (done) {
        sourceDone = true
        try { parser.finish() } catch (err) { sourceError = err }
        return
      }
      if (value.length === 0) return
      for (const part of parser.write(value)) partQueue.push(part)
    } catch (err) {
      sourceError = err
      sourceDone = true
      parser.abortActive(err)
    }
  }

  async function pumpUntil(predicate) {
    while (!predicate()) {
      if (pumpInflight) {
        await pumpInflight
        continue
      }
      pumpInflight = pumpOnce().finally(() => { pumpInflight = null })
      await pumpInflight
    }
  }

  parser.onPull = (part) =>
    pumpUntil(() => sourceDone || sourceError !== null || !part._wantsMore())

  try {
    while (true) {
      if (partQueue.length > 0) {
        yield partQueue.shift()
        continue
      }
      if (sourceError) throw sourceError
      if (sourceDone) return

      // No part queued and source still running. If the caller iterated past
      // an unread body, drop subsequent bytes for it while we scan for the
      // next boundary.
      const active = parser.activePart
      if (active) active._drain()

      await pumpUntil(() =>
        partQueue.length > 0 || sourceDone || sourceError !== null,
      )
    }
  } finally {
    reader.releaseLock()
    parser.abortActive(new MultipartParseError('Iterator exited before stream ended'))
  }
}

// ---------- prollyfill: Response.prototype.parts() ----------
//
// Speculative install of a `parts()` method on Response. Mirrors the shape of
// `Response.prototype.formData()`. Conditional so a future native version wins
// automatically.

if (typeof Response !== 'undefined' && typeof Response.prototype.parts !== 'function') {
  Object.defineProperty(Response.prototype, 'parts', {
    value: function parts() {
      return iterateResponseParts(this)
    },
    writable: true,
    configurable: true,
  })
}
