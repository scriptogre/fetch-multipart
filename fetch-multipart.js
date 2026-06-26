// Streaming multipart parser for the browser.
//
// Public API:
//   parseMultipart(response)              -> AsyncIterable<BodyPart>
//   parseMultipartStream(stream, boundary)-> AsyncIterable<BodyPart>
//   getMultipartBoundary(contentType)     -> string | null
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

const STATE_START = 0
const STATE_AFTER_BOUNDARY = 1
const STATE_HEADER = 2
const STATE_BODY = 3
const STATE_DONE = 4

const findDoubleNewline = createSearch('\r\n\r\n')

export class MultipartParser {
  #findOpeningBoundary
  #openingBoundaryLength
  #findBoundary
  #findPartialTailBoundary
  #boundaryLength
  #boundaryBytes

  #state = STATE_START
  #buffer = null
  #currentHeader = null
  #currentContent = null

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
    if (this.#state === STATE_DONE) {
      throw new MultipartParseError('Unexpected data after final boundary')
    }

    let index = 0
    let chunkLength = chunk.length

    if (this.#buffer !== null) {
      if (this.#state === STATE_BODY) {
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
          this.#state = STATE_AFTER_BOUNDARY
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
      if (this.#state === STATE_BODY) {
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
        this.#state = STATE_AFTER_BOUNDARY
      }

      if (this.#state === STATE_AFTER_BOUNDARY) {
        if (chunkLength - index < 2) {
          this.#buffer = chunk.subarray(index)
          break
        }
        // Closing boundary is followed by '--'.
        if (chunk[index] === 45 && chunk[index + 1] === 45) {
          this.#state = STATE_DONE
          break
        }
        index += 2 // skip \r\n
        this.#state = STATE_HEADER
      }

      if (this.#state === STATE_HEADER) {
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
        this.#state = STATE_BODY
        continue
      }

      if (this.#state === STATE_START) {
        if (chunkLength < this.#openingBoundaryLength) {
          this.#buffer = chunk
          break
        }
        if (this.#findOpeningBoundary(chunk) !== 0) {
          throw new MultipartParseError('Missing initial boundary')
        }
        index = this.#openingBoundaryLength
        this.#state = STATE_AFTER_BOUNDARY
      }
    }
  }

  finish() {
    if (this.#state !== STATE_DONE) {
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
  /** @type {Headers} */ #headers
  /** @type {ReadableStream<Uint8Array> | null} */ #body = null
  #bodyUsed = false

  /**
   * @param {Uint8Array} headerBytes
   * @param {Uint8Array[]} contentChunks
   */
  constructor(headerBytes, contentChunks) {
    this.#content = contentChunks
    this.#headers = parseHeaderBytes(headerBytes)
  }

  /** @returns {Headers} */
  get headers() {
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
    const type = this.#headers.get('content-type') ?? ''
    return new Blob([concatChunks(this.#content)], { type })
  }
}

// ---------- public API ----------

/**
 * @param {string} contentType
 * @returns {string | null}
 */
export function getMultipartBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  return match ? (match[1] ?? match[2]) : null
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

// ---------- prollyfill: Response.prototype.multipart() ----------
//
// Speculative install of a `multipart()` method on Response. Mirrors the shape
// of `Response.prototype.formData()`. Conditional so a future native version
// wins automatically.

if (typeof Response !== 'undefined' && typeof Response.prototype.multipart !== 'function') {
  Object.defineProperty(Response.prototype, 'multipart', {
    value: function multipart() {
      return parseMultipart(this)
    },
    writable: true,
    configurable: true,
  })
}
