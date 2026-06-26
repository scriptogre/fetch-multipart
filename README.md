# fetch-multipart

Streaming `multipart/*` parser for the browser. One file. No dependencies.

```html
<script type="module">
  import 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

  const response = await fetch('/stream')
  for await (const part of response.parts()) {
    console.log(part.headers.get('content-type'))
    console.log(await part.text())
  }
</script>
```

## What it does

Parses any `multipart/*` HTTP response into an async iterable of `BodyPart` objects. Works on long-lived streaming responses (`multipart/mixed`, `multipart/x-mixed-replace`) and one-shot bodies (`multipart/form-data`, `multipart/byteranges`, etc.).

Importing the module installs `Response.prototype.parts()`, mirroring the shape of `Response.prototype.formData()`. The install is conditional, so a future native implementation wins automatically.

## Usage

### Parse a multipart response

```js
import 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

const response = await fetch('/stream')
for await (const part of response.parts()) {
  part.headers.get('content-type')   // 'application/json'
  await part.json()                  // { ... }
}
```

### Read parts as different types

Each part implements the same [`Body`](https://developer.mozilla.org/en-US/docs/Web/API/Body) interface as `Response` and `Request`:

```js
for await (const part of response.parts()) {
  await part.text()         // string
  await part.json()         // any
  await part.bytes()        // Uint8Array
  await part.arrayBuffer()  // ArrayBuffer
  await part.blob()         // Blob (typed by part's Content-Type)
  part.body                 // ReadableStream<Uint8Array>
  part.bodyUsed             // boolean
}
```

A `BodyPart` is the MIME entity from [RFC 2046 §5.1](https://www.rfc-editor.org/rfc/rfc2046#section-5.1): headers and a body. No status code, no URL.

### Parse a nested multipart part

When a part's `Content-Type` is itself `multipart/*` (`multipart/related`, `multipart/alternative`, etc.), call `parts()` on the part the same way:

```js
for await (const part of response.parts()) {
  const contentType = part.headers.get('content-type') ?? ''
  if (!contentType.startsWith('multipart/')) {
    await part.text()
    continue
  }
  for await (const inner of part.parts()) {
    await inner.text()
  }
}
```

### Cancel a long-lived stream

Pass an `AbortSignal` to `fetch`. When you call `controller.abort()`, the response body stream errors and the iterator throws a `DOMException` with `name === 'AbortError'`.

```js
const controller = new AbortController()
const response = await fetch('/stream', { signal: controller.signal })

setTimeout(() => controller.abort(), 5000)

try {
  for await (const part of response.parts()) {
    console.log(await part.text())
  }
} catch (err) {
  if (err.name !== 'AbortError') throw err
}
```

### Handle errors

Errors are `MultipartParseError`, which extends `TypeError` (matching the [WHATWG Fetch convention](https://fetch.spec.whatwg.org/#dom-body-formdata) for `Body` method errors):

```js
import { MultipartParseError } from 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

try {
  for await (const part of response.parts()) { /* ... */ }
} catch (err) {
  err instanceof TypeError              // true
  err instanceof MultipartParseError    // true
}
```

## Helpers

### `getMultipartBoundary(contentType)`

Extract the boundary parameter from a `Content-Type` header:

```js
import { getMultipartBoundary } from 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

getMultipartBoundary('multipart/mixed; boundary=abc')   // 'abc'
getMultipartBoundary('text/plain')                      // null
```

### `parseContentDisposition(header)`

Parse a `Content-Disposition` header into `{ type, name, filename }`. Handles quoted values and RFC 5987 (`filename*=UTF-8''…`) encoding:

```js
import { parseContentDisposition } from 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

parseContentDisposition('form-data; name="file"; filename="resume.pdf"')
// → { type: 'form-data', name: 'file', filename: 'resume.pdf' }
```

## Lower-level API

### Parse a raw byte stream

When you have a `ReadableStream<Uint8Array>` and a boundary but no `Response`, wrap the stream:

```js
const response = new Response(stream, {
  headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
})
for await (const part of response.parts()) {
  await part.text()
}
```

### Drive the parser by hand

For non-stream sources, feed bytes directly. `parser.write(chunk)` yields each `BodyPart` as soon as its headers parse, then routes body bytes into that part's stream as later `write()` calls arrive. Closes the body stream when it reaches the next boundary.

Collect the parts during writes; read their bodies after `finish()`:

```js
import { MultipartParser } from 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

const parser = new MultipartParser(boundary)
const parts = []
for (const chunk of chunks) {
  parser.write(chunk, (part) => parts.push(part))
}
parser.finish()

for (const part of parts) {
  console.log(await part.text())
}
```

## Behavior

Each part is yielded as soon as its headers parse. `part.body` is a live `ReadableStream<Uint8Array>` that receives bytes as the parser sees them. Suitable for large files, open-ended streams (`multipart/x-mixed-replace`, MJPEG, server-push), and anything else that should not buffer in memory.

Consume each part's body (`text()`, `bytes()`, `body.getReader()`, etc.) or cancel it (`body.cancel()`) before advancing to the next part. Iterating past an unread body auto-drains it: remaining bytes are discarded until the next boundary.

Backpressure flows from the consumer through the part's body stream to the underlying response stream. Slow readers do not buffer arbitrary bytes in memory.

## Credits

The parser state machine is ported from [`@remix-run/multipart-parser`](https://github.com/remix-run/remix/tree/main/packages/multipart-parser) (MIT, Shopify Inc).

## License

MIT
