// Streaming multipart parser for the browser.
//
// Public API:
//   parseMultipart(response)              -> AsyncIterable<BodyPart>
//   parseMultipartStream(stream, boundary)-> AsyncIterable<BodyPart>
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

// Finds a partial occurrence of `pattern` whose suffix touches the end of the
// haystack. Used to detect a boundary that may be split across two chunks.
function createPartialTailSearch(pattern) {
  const needle = utf8Encoder.encode(pattern)
  const byteIndexes = Object.create(null)
  for (let i = 0; i < needle.length; ++i) {
    const byte = needle[i]
    if (byteIndexes[byte] === undefined) byteIndexes[byte] = []
    byteIndexes[byte].push(i)
  }

  return (haystack) => {
    const haystackEnd = haystack.length - 1
    const indexes = byteIndexes[haystack[haystackEnd]]
    if (indexes) {
      for (let i = indexes.length - 1; i >= 0; --i) {
        for (let j = indexes[i], k = haystackEnd; j >= 0 && haystack[k] === needle[j]; --j, --k) {
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
  #currentContent = null
  #remainingBodyBytes = 0

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

  *write(chunk) {
    // Discard epilogue bytes after the closing boundary (RFC 2046 §5.1.1).
    // https://www.rfc-editor.org/rfc/rfc2046#section-5.1.1
    if (this.#state === State.DONE) return

    let index = 0
    let chunkLength = chunk.length

    if (this.#buffer !== null) {
      if (this.#state === State.READING_BODY_UNTIL_BOUNDARY) {
        const carry = this.#buffer
        const carryResult = this.#analyzeCarryBoundary(carry, chunk)

        if (carryResult.kind === 'none') {
          this.#append(carry)
        } else if (carryResult.kind === 'partial') {
          if (carryResult.start > 0) this.#append(carry.subarray(0, carryResult.start))
          const tailLength = carry.length + chunk.length - carryResult.start
          const tail = new Uint8Array(tailLength)
          const carryTail = carry.subarray(carryResult.start)
          tail.set(carryTail, 0)
          tail.set(chunk, carryTail.length)
          this.#buffer = tail
          return
        } else {
          if (carryResult.start > 0) this.#append(carry.subarray(0, carryResult.start))
          yield this.#createPart()
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
      }

      this.#buffer = null
    }

    while (true) {
      if (this.#state === State.READING_BODY_UNTIL_BOUNDARY) {
        if (chunkLength - index < this.#boundaryLength) {
          this.#buffer = chunk.subarray(index)
          break
        }

        const boundaryIndex = this.#findBoundary(chunk, index)
        if (boundaryIndex === -1) {
          const partialTailIndex = this.#findPartialTailBoundary(chunk)
          if (partialTailIndex === -1) {
            this.#append(index === 0 ? chunk : chunk.subarray(index))
          } else {
            if (partialTailIndex > index) this.#append(chunk.subarray(index, partialTailIndex))
            this.#buffer = chunk.subarray(partialTailIndex)
          }
          break
        }

        if (boundaryIndex > index) this.#append(chunk.subarray(index, boundaryIndex))
        yield this.#createPart()
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
        this.#currentContent = []
        index = headerEndIndex + 4 // skip \r\n\r\n
        const contentLength = extractContentLength(this.#currentHeader)
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
        this.#append(chunk.subarray(index, index + bodyBytes))
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
            throw new MultipartParseError(
              'Content-Length does not match actual body length',
            )
          }
        }

        yield this.#createPart()
        index += this.#boundaryLength
        this.#state = State.READING_BOUNDARY_SUFFIX
      }

      if (this.#state === State.START) {
        if (chunkLength < this.#openingBoundaryLength) {
          this.#buffer = chunk
          break
        }
        // Discard preamble bytes before the opening boundary (RFC 2046 §5.1.1).
        // https://www.rfc-editor.org/rfc/rfc2046#section-5.1.1
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
    if (this.#state !== State.DONE) {
      throw new MultipartParseError('Stream ended before final boundary')
    }
  }

  #append(chunk) {
    if (chunk.length === 0) return
    this.#currentContent.push(chunk)
  }

  #createPart() {
    return new BodyPart(this.#currentHeader, this.#currentContent)
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

const utf8Decoder = new TextDecoder()

function parseHeaderBytes(raw) {
  const headers = new Headers()
  const text = utf8Decoder.decode(raw)
  for (const line of text.split('\r\n')) {
    const match = line.match(/^([^:]+):(.*)/)
    if (match) headers.append(match[1].trim(), match[2].trim())
  }
  return headers
}

function concatChunks(chunks) {
  let size = 0
  for (const c of chunks) size += c.length
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/**
 * A MIME body part. Implements the WHATWG Fetch `Body` interface.
 */
export class BodyPart {
  /** @type {Uint8Array[]} */ #content
  /** @type {Uint8Array} */ #headerBytes
  /** @type {Headers | null} */ #headers = null
  /** @type {ReadableStream<Uint8Array> | null} */ #body = null
  #bodyUsed = false

  /**
   * @param {Uint8Array} headerBytes
   * @param {Uint8Array[]} contentChunks
   */
  constructor(headerBytes, contentChunks) {
    this.#headerBytes = headerBytes
    this.#content = contentChunks
  }

  /** @returns {Headers} */
  get headers() {
    if (this.#headers === null) this.#headers = parseHeaderBytes(this.#headerBytes)
    return this.#headers
  }

  /** @returns {ReadableStream<Uint8Array>} */
  get body() {
    if (this.#body === null) {
      const chunks = this.#content
      this.#body = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      })
    }
    return this.#body
  }

  /** @returns {boolean} */
  get bodyUsed() {
    return this.#bodyUsed
  }

  /** @returns {Promise<Uint8Array>} */
  async bytes() {
    if (this.#bodyUsed) throw new TypeError('Body already used')
    this.#bodyUsed = true
    return concatChunks(this.#content)
  }

  /** @returns {Promise<ArrayBuffer>} */
  async arrayBuffer() {
    const bytes = await this.bytes()
    return /** @type {ArrayBuffer} */ (bytes.buffer)
  }

  /** @returns {Promise<string>} */
  async text() {
    if (this.#bodyUsed) throw new TypeError('Body already used')
    this.#bodyUsed = true
    return utf8Decoder.decode(concatChunks(this.#content))
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
    return new Blob([concatChunks(this.#content)], { type })
  }
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

/**
 * Parse a `multipart/*` HTTP response into an async iterable of {@link BodyPart}.
 *
 * @param {Response} response
 * @returns {AsyncGenerator<BodyPart, void, unknown>}
 */
export async function* parseMultipart(response) {
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
  yield* parseMultipartStream(response.body, boundary)
}

/**
 * Parse a stream of `multipart/*` bytes given an explicit boundary.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {string} boundary
 * @returns {AsyncGenerator<BodyPart, void, unknown>}
 */
export async function* parseMultipartStream(stream, boundary) {
  const parser = new MultipartParser(boundary)
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.length === 0) continue
      yield* parser.write(value)
    }
  } finally {
    reader.releaseLock()
  }
  parser.finish()
}

// ---------- prollyfill: Response.prototype.parts() ----------
//
// Speculative install of a `parts()` method on Response. Mirrors the shape of
// `Response.prototype.formData()`. Conditional so a future native version wins
// automatically.

if (typeof Response !== 'undefined' && typeof Response.prototype.parts !== 'function') {
  Object.defineProperty(Response.prototype, 'parts', {
    value: function parts() {
      return parseMultipart(this)
    },
    writable: true,
    configurable: true,
  })
}
