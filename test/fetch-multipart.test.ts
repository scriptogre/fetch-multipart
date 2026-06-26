import { assertEquals, assertRejects } from 'jsr:@std/assert'

import {
  BodyPart,
  MultipartParseError,
  MultipartParser,
  getMultipartBoundary,
  parseContentDisposition,
} from '../fetch-multipart.js'

// ---------- helpers ----------

const CRLF = '\r\n'
const BOUNDARY = '----WebKitFormBoundaryz8Zv2UxQ7f4a0Z3H'

function bytes(input: string): Uint8Array {
  return new TextEncoder().encode(input)
}

function buildBody(parts: Array<{ headers: string[]; body: string | Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const part of parts) {
    chunks.push(bytes(`--${BOUNDARY}${CRLF}`))
    chunks.push(bytes(part.headers.join(CRLF) + CRLF + CRLF))
    chunks.push(typeof part.body === 'string' ? bytes(part.body) : part.body)
    chunks.push(bytes(CRLF))
  }
  chunks.push(bytes(`--${BOUNDARY}--`))

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

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  outer: for (let i = start; i <= haystack.length - needle.length; ++i) {
    for (let j = 0; j < needle.length; ++j) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function chunkedResponse(body: Uint8Array, chunkSize: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < body.length; i += chunkSize) {
        controller.enqueue(body.subarray(i, i + chunkSize))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'content-type': `multipart/mixed; boundary=${BOUNDARY}` },
  })
}

function singleChunkResponse(body: Uint8Array): Response {
  return new Response(body as unknown as BodyInit, {
    headers: { 'content-type': `multipart/mixed; boundary=${BOUNDARY}` },
  })
}

async function collect(response: Response): Promise<BodyPart[]> {
  const parts: BodyPart[] = []
  for await (const part of response.parts()) parts.push(part)
  return parts
}

async function collectTexts(response: Response): Promise<string[]> {
  const texts: string[] = []
  for await (const part of response.parts()) texts.push(await part.text())
  return texts
}

// ---------- getMultipartBoundary ----------

Deno.test('getMultipartBoundary: extracts boundary', () => {
  assertEquals(getMultipartBoundary('multipart/form-data; boundary=abc123'), 'abc123')
})

Deno.test('getMultipartBoundary: extracts quoted boundary', () => {
  assertEquals(getMultipartBoundary('multipart/mixed; boundary="abc 123"'), 'abc 123')
})

Deno.test('getMultipartBoundary: returns null when missing', () => {
  assertEquals(getMultipartBoundary('multipart/form-data'), null)
})

Deno.test('getMultipartBoundary: returns null for non-multipart type', () => {
  assertEquals(getMultipartBoundary('text/plain'), null)
})

Deno.test('getMultipartBoundary: trims trailing whitespace in the bare form', () => {
  assertEquals(getMultipartBoundary('multipart/mixed; boundary=abc ; charset=utf-8'), 'abc')
})

Deno.test('getMultipartBoundary: tolerates whitespace around the equals sign', () => {
  assertEquals(getMultipartBoundary('multipart/mixed; boundary = abc'), 'abc')
})

Deno.test('getMultipartBoundary: preserves whitespace inside the quoted form', () => {
  assertEquals(getMultipartBoundary('multipart/mixed; boundary=" abc "'), ' abc ')
})

// ---------- parseContentDisposition ----------

Deno.test('parseContentDisposition: form-data with name', () => {
  assertEquals(
    parseContentDisposition('form-data; name="email"'),
    { type: 'form-data', name: 'email', filename: null },
  )
})

Deno.test('parseContentDisposition: form-data with name and filename', () => {
  assertEquals(
    parseContentDisposition('form-data; name="file"; filename="resume.pdf"'),
    { type: 'form-data', name: 'file', filename: 'resume.pdf' },
  )
})

Deno.test('parseContentDisposition: attachment with filename', () => {
  assertEquals(
    parseContentDisposition('attachment; filename="cat.jpg"'),
    { type: 'attachment', name: null, filename: 'cat.jpg' },
  )
})

Deno.test('parseContentDisposition: type-only header (inline)', () => {
  assertEquals(
    parseContentDisposition('inline'),
    { type: 'inline', name: null, filename: null },
  )
})

Deno.test('parseContentDisposition: unquoted parameter values', () => {
  assertEquals(
    parseContentDisposition('form-data; name=email'),
    { type: 'form-data', name: 'email', filename: null },
  )
})

Deno.test('parseContentDisposition: case-insensitive parameter names', () => {
  assertEquals(
    parseContentDisposition('form-data; Name="email"; Filename="file.txt"'),
    { type: 'form-data', name: 'email', filename: 'file.txt' },
  )
})

Deno.test('parseContentDisposition: type is lowercased', () => {
  assertEquals(
    parseContentDisposition('FORM-DATA; name="email"'),
    { type: 'form-data', name: 'email', filename: null },
  )
})

Deno.test('parseContentDisposition: filename* (RFC 5987) wins over filename', () => {
  assertEquals(
    parseContentDisposition(
      `form-data; name="file"; filename="cafe.txt"; filename*=UTF-8''caf%C3%A9.txt`,
    ),
    { type: 'form-data', name: 'file', filename: 'café.txt' },
  )
})

Deno.test('parseContentDisposition: filename* alone (non-ASCII filename)', () => {
  assertEquals(
    parseContentDisposition(`attachment; filename*=UTF-8''%E2%98%83.txt`),
    { type: 'attachment', name: null, filename: '☃.txt' },
  )
})

Deno.test('parseContentDisposition: tolerates semicolon inside quoted value', () => {
  assertEquals(
    parseContentDisposition('form-data; name="a;b"; filename="c;d.txt"'),
    { type: 'form-data', name: 'a;b', filename: 'c;d.txt' },
  )
})

Deno.test('parseContentDisposition: null header returns all nulls', () => {
  assertEquals(
    parseContentDisposition(null),
    { type: null, name: null, filename: null },
  )
})

Deno.test('parseContentDisposition: empty header returns all nulls', () => {
  assertEquals(
    parseContentDisposition(''),
    { type: null, name: null, filename: null },
  )
})

// ---------- Response.prototype.parts(): happy paths ----------

Deno.test('parses an empty multipart message', async () => {
  const body = bytes(`--${BOUNDARY}--`)
  const parts = await collect(singleChunkResponse(body))
  assertEquals(parts.length, 0)
})

Deno.test('parses a single part', async () => {
  const body = buildBody([{ headers: ['Content-Type: text/plain'], body: 'hello' }])
  const parts = await collect(singleChunkResponse(body))

  assertEquals(parts.length, 1)
  assertEquals(parts[0].headers.get('content-type'), 'text/plain')
  assertEquals(await parts[0].text(), 'hello')
})

Deno.test('parses multiple parts', async () => {
  const body = buildBody([
    { headers: ['Content-Type: text/plain'], body: 'one' },
    { headers: ['Content-Type: text/plain'], body: 'two' },
    { headers: ['Content-Type: text/plain'], body: 'three' },
  ])
  const parts = await collect(singleChunkResponse(body))

  assertEquals(parts.length, 3)
  assertEquals(await parts[0].text(), 'one')
  assertEquals(await parts[1].text(), 'two')
  assertEquals(await parts[2].text(), 'three')
})

Deno.test('parses empty parts', async () => {
  const body = buildBody([{ headers: ['X-Empty: yes'], body: '' }])
  const parts = await collect(singleChunkResponse(body))

  assertEquals(parts.length, 1)
  assertEquals((await parts[0].bytes()).length, 0)
})

Deno.test('preserves non-ASCII body bytes', async () => {
  const content = '名前テスト 🎉'
  const body = buildBody([{ headers: ['Content-Type: text/plain; charset=utf-8'], body: content }])
  const parts = await collect(singleChunkResponse(body))

  assertEquals(await parts[0].text(), content)
})

// ---------- headers ----------

Deno.test('exposes headers as a real Headers instance', async () => {
  const body = buildBody([
    {
      headers: ['Content-Type: text/plain', 'X-Custom: one', 'X-Custom: two'],
      body: 'data',
    },
  ])
  const parts = await collect(singleChunkResponse(body))

  assertEquals(parts[0].headers instanceof Headers, true)
  assertEquals(parts[0].headers.get('content-type'), 'text/plain')
  // Headers.get joins multi-value with ", ".
  assertEquals(parts[0].headers.get('x-custom'), 'one, two')
  // Case-insensitive lookup.
  assertEquals(parts[0].headers.get('Content-Type'), 'text/plain')
})

Deno.test('tolerates malformed header lines', async () => {
  const raw =
    `--${BOUNDARY}${CRLF}` +
    `Not-A-Valid-Header-Line${CRLF}` +
    `Content-Type: text/plain${CRLF}${CRLF}` +
    `content${CRLF}` +
    `--${BOUNDARY}--`
  const parts = await collect(singleChunkResponse(bytes(raw)))

  assertEquals(parts.length, 1)
  assertEquals(parts[0].headers.get('content-type'), 'text/plain')
  assertEquals(await parts[0].text(), 'content')
})

// ---------- BodyPart implements Body ----------

Deno.test('BodyPart.body is a ReadableStream', async () => {
  const body = buildBody([{ headers: ['Content-Type: text/plain'], body: 'abc' }])
  const parts = await collect(singleChunkResponse(body))

  assertEquals(parts[0].body instanceof ReadableStream, true)

  const reader = parts[0].body.getReader()
  const collected: number[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    collected.push(...value)
  }
  assertEquals(new TextDecoder().decode(new Uint8Array(collected)), 'abc')
})

Deno.test('BodyPart.bytes returns the content', async () => {
  const body = buildBody([{ headers: ['Content-Type: text/plain'], body: 'abc' }])
  const parts = await collect(singleChunkResponse(body))

  const result = await parts[0].bytes()
  assertEquals(result instanceof Uint8Array, true)
  assertEquals(new TextDecoder().decode(result), 'abc')
})

Deno.test('BodyPart.arrayBuffer returns the content', async () => {
  const body = buildBody([{ headers: ['Content-Type: text/plain'], body: 'abc' }])
  const parts = await collect(singleChunkResponse(body))

  const result = await parts[0].arrayBuffer()
  assertEquals(result instanceof ArrayBuffer, true)
  assertEquals(new TextDecoder().decode(new Uint8Array(result)), 'abc')
})

Deno.test('BodyPart.json parses JSON content', async () => {
  const body = buildBody([
    { headers: ['Content-Type: application/json'], body: '{"x":1,"y":[2,3]}' },
  ])
  const parts = await collect(singleChunkResponse(body))

  assertEquals(await parts[0].json(), { x: 1, y: [2, 3] })
})

Deno.test('BodyPart.blob applies the part Content-Type', async () => {
  const body = buildBody([{ headers: ['Content-Type: image/png'], body: 'fake-png-bytes' }])
  const parts = await collect(singleChunkResponse(body))

  const blob = await parts[0].blob()
  assertEquals(blob.type, 'image/png')
  assertEquals(await blob.text(), 'fake-png-bytes')
})

Deno.test('BodyPart.bodyUsed flips after consuming', async () => {
  const body = buildBody([{ headers: ['Content-Type: text/plain'], body: 'abc' }])
  const parts = await collect(singleChunkResponse(body))

  assertEquals(parts[0].bodyUsed, false)
  await parts[0].text()
  assertEquals(parts[0].bodyUsed, true)
})

Deno.test('BodyPart throws when re-consumed', async () => {
  const body = buildBody([{ headers: ['Content-Type: text/plain'], body: 'abc' }])
  const parts = await collect(singleChunkResponse(body))

  await parts[0].text()
  await assertRejects(() => parts[0].text(), TypeError)
})

// ---------- chunk-edge cases ----------

const sampleBody = buildBody([
  { headers: ['Content-Type: text/plain'], body: 'value1' },
  { headers: ['Content-Type: text/plain'], body: 'value2' },
])
const boundaryBytes = bytes(`\r\n--${BOUNDARY}`)
const splitIndex = indexOfBytes(sampleBody, boundaryBytes, 1)

async function expectTwoPartsFromChunks(chunkSize: number) {
  const texts = await collectTexts(chunkedResponse(sampleBody, chunkSize))
  assertEquals(texts, ['value1', 'value2'])
}

Deno.test('parses correctly when boundary is split mid-pattern', () =>
  expectTwoPartsFromChunks(splitIndex + 3))

Deno.test('parses correctly when only the leading "\\r" of the boundary ends the first chunk', () =>
  expectTwoPartsFromChunks(splitIndex + 1))

Deno.test('parses correctly when the boundary starts exactly at the next chunk edge', () =>
  expectTwoPartsFromChunks(splitIndex))

Deno.test('parses correctly across many small chunks', async () => {
  const body = buildBody([
    { headers: ['Content-Type: text/plain'], body: 'one' },
    { headers: ['Content-Type: text/plain'], body: 'two' },
    { headers: ['Content-Type: text/plain'], body: 'three' },
  ])
  assertEquals(await collectTexts(chunkedResponse(body, 1)), ['one', 'two', 'three'])
})

// ---------- errors ----------

Deno.test('throws when Content-Type is not multipart/*', async () => {
  const response = new Response('hello', { headers: { 'content-type': 'text/plain' } })
  await assertRejects(async () => {
    for await (const _ of response.parts()) void _
  }, MultipartParseError)
})

Deno.test('throws when Content-Type has no boundary', async () => {
  const response = new Response('hello', { headers: { 'content-type': 'multipart/mixed' } })
  await assertRejects(async () => {
    for await (const _ of response.parts()) void _
  }, MultipartParseError)
})

Deno.test('throws when response body is null', async () => {
  const response = new Response(null, {
    headers: { 'content-type': `multipart/mixed; boundary=${BOUNDARY}` },
  })
  await assertRejects(async () => {
    for await (const _ of response.parts()) void _
  }, MultipartParseError)
})

Deno.test('throws when stream contains no boundary at all', async () => {
  const raw = `Content-Type: text/plain${CRLF}${CRLF}value1`
  await assertRejects(async () => {
    for await (const _ of singleChunkResponse(bytes(raw)).parts()) void _
  }, MultipartParseError)
})

Deno.test('throws when final closing boundary is missing', async () => {
  const raw =
    `--${BOUNDARY}${CRLF}` +
    `Content-Type: text/plain${CRLF}${CRLF}` +
    `value1${CRLF}` +
    `--${BOUNDARY}`
  await assertRejects(async () => {
    for await (const _ of singleChunkResponse(bytes(raw)).parts()) void _
  }, MultipartParseError)
})

Deno.test('MultipartParseError is a TypeError', () => {
  const err = new MultipartParseError('test')
  assertEquals(err instanceof TypeError, true)
  assertEquals(err instanceof MultipartParseError, true)
  assertEquals(err.name, 'MultipartParseError')
})

// ---------- boundary validation ----------

Deno.test('rejects empty boundary', () => {
  assertThrowsConstructor('')
})

Deno.test('rejects boundary longer than 70 characters', () => {
  assertThrowsConstructor('a'.repeat(71))
})

Deno.test('rejects non-ASCII boundary', () => {
  assertThrowsConstructor('café')
})

Deno.test('rejects boundary with control characters', () => {
  assertThrowsConstructor('abc\x01def')
})

Deno.test('accepts a 70-character ASCII boundary', () => {
  new MultipartParser('a'.repeat(70))
})

Deno.test('accepts boundary with the full printable ASCII range', () => {
  new MultipartParser(`abc-XYZ_0123 +'(),/:=?.!*~@#$%^&{}|`)
})

function assertThrowsConstructor(boundary: string) {
  let threw = false
  try {
    new MultipartParser(boundary)
  } catch (err) {
    threw = true
    assertEquals(err instanceof MultipartParseError, true)
  }
  assertEquals(threw, true)
}

// ---------- Content-Length-aware parsing ----------

Deno.test('honors Content-Length when present', async () => {
  const body = buildBody([
    { headers: ['Content-Type: text/plain', 'Content-Length: 5'], body: 'hello' },
  ])
  const parts = await collect(singleChunkResponse(body))
  assertEquals(await parts[0].text(), 'hello')
})

Deno.test('honors Content-Length: 0 (empty body)', async () => {
  const body = buildBody([{ headers: ['Content-Length: 0'], body: '' }])
  const parts = await collect(singleChunkResponse(body))
  assertEquals((await parts[0].bytes()).length, 0)
})

Deno.test('throws when Content-Length disagrees with body length', async () => {
  // Claims Content-Length: 3 but the body is 5 bytes.
  const body = buildBody([
    { headers: ['Content-Length: 3'], body: 'hello' },
  ])
  await assertRejects(async () => {
    for await (const _ of singleChunkResponse(body).parts()) void _
  }, MultipartParseError)
})

Deno.test('handles a mix of Content-Length and unsized parts', async () => {
  const body = buildBody([
    { headers: ['Content-Length: 5'], body: 'hello' },
    { headers: ['Content-Type: text/plain'], body: 'world' },
  ])
  const parts = await collect(singleChunkResponse(body))
  assertEquals(parts.length, 2)
  assertEquals(await parts[0].text(), 'hello')
  assertEquals(await parts[1].text(), 'world')
})

Deno.test('Content-Length lets a part body legally contain the boundary marker', async () => {
  // Body contains literal "\r\n--<boundary>" bytes. Without Content-Length the
  // boundary scanner would terminate the part early. With Content-Length the
  // parser reads exactly N bytes and ignores the embedded marker.
  const sneaky = `prefix\r\n--${BOUNDARY}\r\nfake\r\n--${BOUNDARY}--suffix`
  const body = buildBody([
    { headers: [`Content-Length: ${bytes(sneaky).length}`], body: sneaky },
  ])
  const parts = await collect(singleChunkResponse(body))
  assertEquals(await parts[0].text(), sneaky)
})

Deno.test('Content-Length works when chunks split the body', async () => {
  const body = buildBody([
    { headers: ['Content-Length: 11'], body: 'hello world' },
  ])
  assertEquals(await collectTexts(chunkedResponse(body, 1)), ['hello world'])
})

Deno.test('Content-Length header name is case-insensitive', async () => {
  const body = buildBody([
    { headers: ['CONTENT-LENGTH: 3'], body: 'abc' },
  ])
  const parts = await collect(singleChunkResponse(body))
  assertEquals(await parts[0].text(), 'abc')
})

// ---------- preamble and epilogue (RFC 2046 §5.1.1) ----------

Deno.test('ignores preamble before the first boundary', async () => {
  const raw =
    `This is a preamble that some MIME senders include.${CRLF}` +
    `It must be discarded.${CRLF}` +
    `--${BOUNDARY}${CRLF}` +
    `Content-Type: text/plain${CRLF}${CRLF}` +
    `payload${CRLF}` +
    `--${BOUNDARY}--`
  const parts = await collect(singleChunkResponse(bytes(raw)))

  assertEquals(parts.length, 1)
  assertEquals(await parts[0].text(), 'payload')
})

Deno.test('ignores preamble split across chunks', async () => {
  const raw =
    `preamble bytes that span more than one chunk boundary${CRLF}` +
    `--${BOUNDARY}${CRLF}` +
    `Content-Type: text/plain${CRLF}${CRLF}` +
    `payload${CRLF}` +
    `--${BOUNDARY}--`
  assertEquals(await collectTexts(chunkedResponse(bytes(raw), 8)), ['payload'])
})

Deno.test('ignores epilogue after the closing boundary', async () => {
  const raw =
    `--${BOUNDARY}${CRLF}` +
    `Content-Type: text/plain${CRLF}${CRLF}` +
    `payload${CRLF}` +
    `--${BOUNDARY}--${CRLF}` +
    `Trailing epilogue text that some senders include.${CRLF}` +
    `It must be discarded.`
  const parts = await collect(singleChunkResponse(bytes(raw)))

  assertEquals(parts.length, 1)
  assertEquals(await parts[0].text(), 'payload')
})

Deno.test('ignores epilogue split across chunks', async () => {
  const raw =
    `--${BOUNDARY}${CRLF}` +
    `Content-Type: text/plain${CRLF}${CRLF}` +
    `payload${CRLF}` +
    `--${BOUNDARY}--${CRLF}` +
    `epilogue bytes that span more than one chunk boundary`
  assertEquals(await collectTexts(chunkedResponse(bytes(raw), 8)), ['payload'])
})

// ---------- nested multipart ----------

const INNER_BOUNDARY = '----InnerBoundary'

function buildNestedOuterBody(): Uint8Array {
  const innerBody =
    `--${INNER_BOUNDARY}${CRLF}` +
    `Content-Type: text/plain${CRLF}${CRLF}` +
    `inner-one${CRLF}` +
    `--${INNER_BOUNDARY}${CRLF}` +
    `Content-Type: text/plain${CRLF}${CRLF}` +
    `inner-two${CRLF}` +
    `--${INNER_BOUNDARY}--`

  const outerRaw =
    `--${BOUNDARY}${CRLF}` +
    `Content-Type: multipart/mixed; boundary=${INNER_BOUNDARY}${CRLF}${CRLF}` +
    innerBody +
    `${CRLF}--${BOUNDARY}--`

  return bytes(outerRaw)
}

Deno.test('BodyPart.parts() recurses into a multipart/* part body', async () => {
  const outerParts = await collect(singleChunkResponse(buildNestedOuterBody()))
  assertEquals(outerParts.length, 1)

  const innerParts: BodyPart[] = []
  for await (const inner of outerParts[0].parts()) {
    innerParts.push(inner)
  }

  assertEquals(innerParts.length, 2)
  assertEquals(await innerParts[0].text(), 'inner-one')
  assertEquals(await innerParts[1].text(), 'inner-two')
})

Deno.test('BodyPart.parts() throws when Content-Type is not multipart/*', async () => {
  const body = buildBody([{ headers: ['Content-Type: text/plain'], body: 'hello' }])
  const parts = await collect(singleChunkResponse(body))
  await assertRejects(async () => {
    for await (const _ of parts[0].parts()) void _
  }, MultipartParseError)
})

Deno.test('BodyPart.parts() throws when Content-Type has no boundary', async () => {
  const body = buildBody([{ headers: ['Content-Type: multipart/mixed'], body: 'irrelevant' }])
  const parts = await collect(singleChunkResponse(body))
  await assertRejects(async () => {
    for await (const _ of parts[0].parts()) void _
  }, MultipartParseError)
})

Deno.test('BodyPart.parts() throws when the body is already consumed', async () => {
  const outerParts = await collect(singleChunkResponse(buildNestedOuterBody()))
  await outerParts[0].text()
  await assertRejects(async () => {
    for await (const _ of outerParts[0].parts()) void _
  }, TypeError)
})

// ---------- AbortController cancellation ----------

Deno.test('AbortSignal cancels mid-stream and propagates the abort error', async () => {
  const body = buildBody([
    { headers: ['Content-Type: text/plain'], body: 'one' },
    { headers: ['Content-Type: text/plain'], body: 'two' },
  ])

  const controller = new AbortController()
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      controller.signal.addEventListener('abort', () => {
        ctrl.error(new DOMException('Aborted', 'AbortError'))
      })
      // Emit one byte at a time with a yield so the consumer can abort.
      for (let i = 0; i < body.length; i++) {
        if (controller.signal.aborted) return
        ctrl.enqueue(body.subarray(i, i + 1))
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      ctrl.close()
    },
  })
  const response = new Response(stream, {
    headers: { 'content-type': `multipart/mixed; boundary=${BOUNDARY}` },
  })

  let parts = 0
  let error: unknown = null
  try {
    for await (const part of response.parts()) {
      parts++
      await part.text()
      if (parts === 1) controller.abort()
    }
  } catch (err) {
    error = err
  }

  assertEquals(parts, 1)
  assertEquals(error instanceof DOMException, true)
  assertEquals((error as DOMException).name, 'AbortError')
})

// ---------- Response.prototype.parts prollyfill ----------

Deno.test('installs Response.prototype.parts', () => {
  assertEquals(typeof Response.prototype.parts, 'function')
})

Deno.test('response.parts() iterates the parts of a multipart response', async () => {
  const body = buildBody([
    { headers: ['Content-Type: text/plain'], body: 'one' },
    { headers: ['Content-Type: text/plain'], body: 'two' },
  ])

  const parts: BodyPart[] = []
  for await (const part of singleChunkResponse(body).parts()) parts.push(part)

  assertEquals(parts.length, 2)
  assertEquals(await parts[0].text(), 'one')
  assertEquals(await parts[1].text(), 'two')
})

// ---------- v2: streaming bodies ----------

type ControllableResponse = {
  response: Response
  push: (chunk: Uint8Array) => void
  close: () => void
  error: (err: unknown) => void
}

function controllableResponse(): ControllableResponse {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c },
  })
  return {
    response: new Response(stream, {
      headers: { 'content-type': `multipart/mixed; boundary=${BOUNDARY}` },
    }),
    push: (chunk) => controller.enqueue(chunk),
    close: () => controller.close(),
    error: (err) => controller.error(err),
  }
}

function pullCountedResponse(chunks: Uint8Array[]): {
  response: Response
  pulls: () => number
} {
  let i = 0
  let pullCount = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCount++
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    },
  })
  return {
    response: new Response(stream, {
      headers: { 'content-type': `multipart/mixed; boundary=${BOUNDARY}` },
    }),
    pulls: () => pullCount,
  }
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

Deno.test('yields BodyPart as soon as headers parse, before body bytes arrive', async () => {
  const { response, push, close } = controllableResponse()

  push(bytes(`--${BOUNDARY}${CRLF}Content-Type: text/plain${CRLF}${CRLF}`))

  const iter = response.parts()[Symbol.asyncIterator]()
  const result = await iter.next()
  assertEquals(result.done, false)
  assertEquals(result.value!.headers.get('content-type'), 'text/plain')

  push(bytes(`hello${CRLF}--${BOUNDARY}--`))
  close()

  assertEquals(await result.value!.text(), 'hello')
})

Deno.test('body bytes land on the body stream as source chunks arrive', async () => {
  const { response, push, close } = controllableResponse()

  push(bytes(`--${BOUNDARY}${CRLF}Content-Type: text/plain${CRLF}${CRLF}`))
  push(bytes('first '))

  const iter = response.parts()[Symbol.asyncIterator]()
  const { value: part } = await iter.next()
  const reader = part!.body.getReader()

  const r1 = await reader.read()
  assertEquals(new TextDecoder().decode(r1.value), 'first ')

  push(bytes('second'))
  const r2 = await reader.read()
  assertEquals(new TextDecoder().decode(r2.value), 'second')

  push(bytes(`${CRLF}--${BOUNDARY}--`))
  close()
  const r3 = await reader.read()
  assertEquals(r3.done, true)
})

Deno.test('iterating past an unread body auto-drains it', async () => {
  const body = buildBody([
    { headers: ['Content-Type: text/plain'], body: 'skip-me' },
    { headers: ['Content-Type: text/plain'], body: 'keep-me' },
  ])
  const iter = singleChunkResponse(body).parts()[Symbol.asyncIterator]()

  const first = await iter.next()
  assertEquals(first.done, false)
  // Do not read first.value!.body or call text().

  const second = await iter.next()
  assertEquals(second.done, false)
  assertEquals(await second.value!.text(), 'keep-me')
})

Deno.test('body.cancel() releases and the iterator advances to the next part', async () => {
  const body = buildBody([
    { headers: ['Content-Type: text/plain'], body: 'first' },
    { headers: ['Content-Type: text/plain'], body: 'second' },
  ])
  const iter = singleChunkResponse(body).parts()[Symbol.asyncIterator]()

  const { value: first } = await iter.next()
  await first!.body.cancel()

  const { value: second } = await iter.next()
  assertEquals(await second!.text(), 'second')
})

Deno.test('source errors propagate to the active body stream', async () => {
  const { response, push, error } = controllableResponse()

  push(bytes(`--${BOUNDARY}${CRLF}Content-Type: text/plain${CRLF}${CRLF}hello`))

  const iter = response.parts()[Symbol.asyncIterator]()
  const { value: part } = await iter.next()
  const reader = part!.body.getReader()

  const r1 = await reader.read()
  assertEquals(new TextDecoder().decode(r1.value), 'hello')

  const sourceErr = new Error('network blew up')
  error(sourceErr)

  let caught: unknown = null
  try {
    await reader.read()
  } catch (e) {
    caught = e
  }
  assertEquals(caught, sourceErr)
})

Deno.test('missing closing boundary errors the active body and the iterator', async () => {
  const { response, push, close } = controllableResponse()

  push(bytes(`--${BOUNDARY}${CRLF}Content-Type: text/plain${CRLF}${CRLF}partial`))
  close()

  const iter = response.parts()[Symbol.asyncIterator]()
  const { value: part } = await iter.next()
  const reader = part!.body.getReader()

  const r1 = await reader.read()
  assertEquals(new TextDecoder().decode(r1.value), 'partial')

  let bodyErr: unknown = null
  try {
    await reader.read()
  } catch (e) {
    bodyErr = e
  }
  assertEquals(bodyErr instanceof MultipartParseError, true)

  let iterErr: unknown = null
  try {
    await iter.next()
  } catch (e) {
    iterErr = e
  }
  assertEquals(iterErr instanceof MultipartParseError, true)
})

Deno.test('backpressure: source not pulled while consumer ignores body', async () => {
  const headers = `--${BOUNDARY}${CRLF}Content-Type: text/plain${CRLF}${CRLF}`
  const tail = `${CRLF}--${BOUNDARY}--`
  const chunks = [
    bytes(headers + 'aaaa'),
    bytes('bbbb'),
    bytes('cccc'),
    bytes('dddd'),
    bytes('eeee'),
    bytes(tail),
  ]
  const { response, pulls } = pullCountedResponse(chunks)
  const iter = response.parts()[Symbol.asyncIterator]()

  const { value: part } = await iter.next()
  assertEquals(part!.headers.get('content-type'), 'text/plain')

  await flushMicrotasks()
  const settled = pulls()
  if (settled > 3) {
    throw new Error(`expected <= 3 pulls while body ignored, got ${settled}`)
  }

  assertEquals(await part!.text(), 'aaaabbbbccccddddeeee')
  const { done } = await iter.next()
  assertEquals(done, true)
})

Deno.test('large body streams without buffering all chunks', async () => {
  const chunkSize = 1024
  const numChunks = 100
  const headers = `--${BOUNDARY}${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`

  const chunks: Uint8Array[] = [bytes(headers)]
  for (let i = 0; i < numChunks; i++) {
    chunks.push(new Uint8Array(chunkSize).fill(i % 256))
  }
  chunks.push(bytes(`${CRLF}--${BOUNDARY}--`))

  const { response } = pullCountedResponse(chunks)
  const iter = response.parts()[Symbol.asyncIterator]()
  const { value: part } = await iter.next()

  const reader = part!.body.getReader()
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
  }
  assertEquals(total, chunkSize * numChunks)
})

Deno.test('bodyUsed stays false when body is abandoned', async () => {
  const body = buildBody([
    { headers: ['Content-Type: text/plain'], body: 'first' },
    { headers: ['Content-Type: text/plain'], body: 'second' },
  ])
  const iter = singleChunkResponse(body).parts()[Symbol.asyncIterator]()

  const { value: first } = await iter.next()
  assertEquals(first!.bodyUsed, false)

  await iter.next()
  // Even after auto-drain, the caller never accessed first's body.
  assertEquals(first!.bodyUsed, false)
})

Deno.test('bodyUsed flips after body.cancel()', async () => {
  const body = buildBody([
    { headers: ['Content-Type: text/plain'], body: 'hi' },
    { headers: ['Content-Type: text/plain'], body: 'bye' },
  ])
  const iter = singleChunkResponse(body).parts()[Symbol.asyncIterator]()

  const { value: first } = await iter.next()
  assertEquals(first!.bodyUsed, false)
  await first!.body.cancel()
  assertEquals(first!.bodyUsed, true)
})
