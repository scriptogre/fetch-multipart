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

## API

### `parseMultipart(response): AsyncIterable<BodyPart>`

Reads the `Content-Type` header for the boundary, then yields each part as it arrives.

### `parseMultipartStream(stream, boundary): AsyncIterable<BodyPart>`

Lower-level: parse any `ReadableStream<Uint8Array>` given an explicit boundary.

### `getMultipartBoundary(contentType): string | null`

Extract the `boundary` parameter from a `Content-Type` header value.

### `class BodyPart implements Body`

Each part exposes the same `Body` interface as `Response` and `Request`:

```ts
class BodyPart {
  readonly headers: Headers
  readonly body: ReadableStream<Uint8Array>
  readonly bodyUsed: boolean
  arrayBuffer(): Promise<ArrayBuffer>
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
  json(): Promise<any>
  blob(): Promise<Blob>
}
```

A `BodyPart` is the MIME entity from RFC 2046 §5.1: a `Headers` object and a body stream. No status code, no URL.

### `class MultipartParser`

Low-level state machine that yields `BodyPart` objects from raw `Uint8Array` chunks. Use when you need to drive the parser manually.

### `class MultipartParseError extends Error`

Thrown for malformed multipart streams.

## Behavior

Each part's body is buffered in memory before the part is yielded. Suitable for small parts (hypermedia fragments, form fields, header-style messages). For large or open-ended parts, see [`ROADMAP.md`](./ROADMAP.md).

## Credits

The parser state machine is ported from [`@remix-run/multipart-parser`](https://github.com/remix-run/remix/tree/main/packages/multipart-parser) (MIT, Shopify Inc).

## License

MIT
