# fetch-multipart

Streaming `multipart/*` parser for the browser. One file. No dependencies.

```html
<script type="module">
  import { parseMultipart } from 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

  const response = await fetch('/stream')
  for await (const part of parseMultipart(response)) {
    console.log(part.headers.get('content-type'))
    console.log(await part.text())
  }
</script>
```

## What it does

Parses any `multipart/*` HTTP response into an async iterable of `BodyPart` objects. Works on long-lived streaming responses (`multipart/mixed`, `multipart/x-mixed-replace`) and one-shot bodies (`multipart/form-data`, `multipart/byteranges`, etc.).

## Usage

### Parse a multipart response

```js
import { parseMultipart } from 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

const response = await fetch('/stream')

for await (const part of parseMultipart(response)) {
  part.headers.get('content-type')   // 'application/json'
  await part.json()                  // { ... }
}
```

Or use the prollyfill (auto-installed on import):

```js
import 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

const response = await fetch('/stream')
for await (const part of response.multipart()) {
  await part.text()
}
```

### Read parts as different types

Each part implements the same [`Body`](https://developer.mozilla.org/en-US/docs/Web/API/Body) interface as `Response` and `Request`:

```js
for await (const part of response.multipart()) {
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

### Parse a raw byte stream

When you already have a `ReadableStream<Uint8Array>` and the boundary string:

```js
import { parseMultipartStream } from 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

for await (const part of parseMultipartStream(stream, boundary)) {
  await part.text()
}
```

### Extract the boundary from a Content-Type header

```js
import { getMultipartBoundary } from 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

getMultipartBoundary('multipart/mixed; boundary=abc')   // 'abc'
getMultipartBoundary('text/plain')                      // null
```

### Drive the parser by hand

For non-stream sources, feed bytes directly:

```js
import { MultipartParser } from 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

const parser = new MultipartParser(boundary)
for (const chunk of chunks) {
  for (const part of parser.write(chunk)) {
    await part.text()
  }
}
parser.finish()
```

### Handle errors

Errors are `MultipartParseError`, which extends `TypeError` (matching the [WHATWG Fetch convention](https://fetch.spec.whatwg.org/#dom-body-formdata) for `Body` method errors):

```js
import { MultipartParseError } from 'https://cdn.jsdelivr.net/gh/scriptogre/fetch-multipart@main/fetch-multipart.js'

try {
  for await (const part of response.multipart()) { /* ... */ }
} catch (err) {
  err instanceof TypeError              // true
  err instanceof MultipartParseError    // true
}
```

## Behavior

Each part's body is buffered in memory before the part is yielded. Suitable for small parts (hypermedia fragments, form fields, header-style messages). For large or open-ended parts, see [`ROADMAP.md`](./ROADMAP.md).

## Credits

The parser state machine is ported from [`@remix-run/multipart-parser`](https://github.com/remix-run/remix/tree/main/packages/multipart-parser) (MIT, Shopify Inc).

## License

MIT
