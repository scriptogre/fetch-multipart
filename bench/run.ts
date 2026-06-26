// Benchmark: fetch-multipart vs @remix-run/multipart-parser.
//
// Usage:
//   deno run -A bench/run.ts                    # all benchmarks, both parsers
//   deno run -A bench/run.ts --times=100        # fewer iterations
//   deno run -A bench/run.ts --warmup=20        # warmup iterations before measure

import {
  fiveLargeFiles,
  fiveLargeFilesAdversarial,
  manyTinyHtmlFragments,
  manyTinyHtmlFragmentsWithContentLength,
  MultipartMessage,
  oneHundredSmallFiles,
  oneHundredSmallFilesWithContentLength,
  oneLargeFile,
  oneLargeFileAdversarial,
  oneLargeFileWithContentLength,
  oneLargeHtmlPage,
  oneSmallFile,
  realisticHtmlBurst,
  typicalHtmlBurst,
  typicalHtmlBurstWithContentLength,
} from './messages.ts'

import '../fetch-multipart.js'
import { parseMultipartStream as remixParseStream } from 'npm:@remix-run/multipart-parser'

interface Scenario {
  id: string
  name: string
  message: MultipartMessage
}

const scenarios: Scenario[] = [
  { id: '1-small-file', name: '1 small file', message: oneSmallFile },
  { id: '1-large-file', name: '1 large file', message: oneLargeFile },
  { id: '1-large-file-with-content-length', name: '1 large file (with Content-Length)', message: oneLargeFileWithContentLength },
  { id: '100-small-files', name: '100 small files', message: oneHundredSmallFiles },
  { id: '100-small-files-with-content-length', name: '100 small files (with Content-Length)', message: oneHundredSmallFilesWithContentLength },
  { id: '5-large-files', name: '5 large files', message: fiveLargeFiles },
  { id: '1-large-adversarial', name: '1 large file (adversarial)', message: oneLargeFileAdversarial },
  { id: '5-large-adversarial', name: '5 large files (adversarial)', message: fiveLargeFilesAdversarial },
  { id: 'many-tiny-html', name: '1000 tiny HTML parts', message: manyTinyHtmlFragments },
  { id: 'many-tiny-html-with-content-length', name: '1000 tiny HTML parts (with Content-Length)', message: manyTinyHtmlFragmentsWithContentLength },
  { id: 'typical-html', name: '100 typical HTML parts', message: typicalHtmlBurst },
  { id: 'typical-html-with-content-length', name: '100 typical HTML parts (with Content-Length)', message: typicalHtmlBurstWithContentLength },
  { id: 'realistic-html', name: '50 mixed HTML parts', message: realisticHtmlBurst },
  { id: '1-large-html', name: '1 large HTML page', message: oneLargeHtmlPage },
]

interface Parser {
  name: string
  parse(message: MultipartMessage): Promise<number>
}

// Drain each part's body so both parsers do equivalent work. fetch-multipart
// yields parts at end-of-headers and streams bodies on demand; remix yields
// parts after buffering each body. Without the drain, ours would skip body
// allocation entirely and the comparison would be unfair.
async function drainStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  while (!(await reader.read()).done) {}
}

const parsers: Parser[] = [
  {
    name: 'fetch-multipart',
    async parse(message) {
      const response = new Response(message.toReadableStream(), {
        headers: { 'content-type': `multipart/mixed; boundary=${message.boundary}` },
      })
      const start = performance.now()
      for await (const part of response.parts()) {
        await drainStream(part.body)
      }
      return performance.now() - start
    },
  },
  {
    // remix buffers each body before yielding; iterating already does the work.
    name: '@remix-run/multipart-parser',
    async parse(message) {
      const start = performance.now()
      for await (const _ of remixParseStream(message.toReadableStream(), {
        boundary: message.boundary,
        maxFileSize: 100 * 1024 * 1024,
      })) {
        void _
      }
      return performance.now() - start
    },
  },
]

interface Options {
  times: number
  warmup: number
}

function parseArgs(): Options {
  const opts: Options = { times: 200, warmup: 20 }
  for (const arg of Deno.args) {
    if (arg.startsWith('--times=')) opts.times = parseInt(arg.slice(8), 10)
    else if (arg.startsWith('--warmup=')) opts.warmup = parseInt(arg.slice(9), 10)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return opts
}

function stats(measurements: number[], sizeBytes: number) {
  const mean = measurements.reduce((a, b) => a + b, 0) / measurements.length
  const variance =
    measurements.reduce((a, b) => a + (b - mean) ** 2, 0) / measurements.length
  const stdDev = Math.sqrt(variance)
  const throughputMibPerSec = sizeBytes / (1024 * 1024) / (mean / 1000)
  return { mean, stdDev, throughputMibPerSec }
}

async function run(parser: Parser, scenario: Scenario, opts: Options) {
  for (let i = 0; i < opts.warmup; i++) await parser.parse(scenario.message)
  const measurements: number[] = []
  for (let i = 0; i < opts.times; i++) measurements.push(await parser.parse(scenario.message))
  return stats(measurements, scenario.message.content.length)
}

function printSystemInfo() {
  console.log(`Platform: ${Deno.build.os} (${Deno.build.arch})`)
  console.log(`Deno: ${Deno.version.deno}, V8: ${Deno.version.v8}`)
  console.log(`Date: ${new Date().toISOString()}`)
  console.log()
}

async function main() {
  const opts = parseArgs()
  printSystemInfo()
  console.log(`Iterations: ${opts.times}, warmup: ${opts.warmup}`)
  console.log()

  const summaryRows: Record<string, Record<string, string>> = {}
  const throughputRows: Record<string, Record<string, string>> = {}

  for (const parser of parsers) {
    summaryRows[parser.name] = {}
    throughputRows[parser.name] = {}
    for (const scenario of scenarios) {
      const { mean, stdDev, throughputMibPerSec } = await run(parser, scenario, opts)
      summaryRows[parser.name][scenario.name] = `${mean.toFixed(2)} ms ± ${stdDev.toFixed(2)}`
      throughputRows[parser.name][scenario.name] = `${throughputMibPerSec.toFixed(0)} MiB/s`
    }
  }

  console.log('Mean parse time')
  console.table(summaryRows)
  console.log('Throughput')
  console.table(throughputRows)
}

main()
