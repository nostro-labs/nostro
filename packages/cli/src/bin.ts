#!/usr/bin/env node
import { main } from './main.js'

// Piped into `head`, say: the reader has gone, which is not an error.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

// Ctrl-C or a container stop: let a running command finish what it is doing and close.
const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort())

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
  signal: stop.signal,
})
