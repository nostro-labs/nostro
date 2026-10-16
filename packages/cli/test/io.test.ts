import { describe, expect, it } from 'vitest'
import type { Output } from '../src/io.js'
import { clean, table, write } from '../src/io.js'
import { redact } from '../src/store.js'

describe('clean', () => {
  it('escapes what could rewrite a terminal or reorder text, and nothing else', () => {
    expect(clean('INV-1042 é中')).toBe('INV-1042 é中')
    expect(clean('\u001b[2J\u001b]0;pwned\u0007')).toBe('\\u001b[2J\\u001b]0;pwned\\u0007')
    expect(clean('a\nb\rc\u007f\u009b')).toBe('a\\u000ab\\u000dc\\u007f\\u009b')
    expect(clean('pay ‮KCOLB‬ now ⁦x⁩')).toBe('pay \\u202eKCOLB\\u202c now \\u2066x\\u2069')
  })
})

describe('table', () => {
  it('aligns columns on the cleaned text', () => {
    expect(table([['A', 'B', 'C'], ['long\u001b', 'x', 'y']])).toBe('A           B  C\nlong\\u001b  x  y\n')
  })
})

describe('write', () => {
  it('waits for drain when the stream asks', async () => {
    let drain: (() => void) | undefined
    const out: Output = { write: () => false, once: (_event, listener) => (drain = listener) }
    let done = false
    const pending = write(out, 'x').then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    drain!()
    await pending
    expect(done).toBe(true)
  })
})

describe('redact', () => {
  it('hides a password, even in a URL that does not parse', () => {
    expect(redact('postgres://nostro:s3cret@db.example:5432/books')).toBe('postgres://nostro:***@db.example:5432/books')
    expect(redact('postgres://nostro@db.example/books')).toBe('postgres://nostro@db.example/books')
    expect(redact('postgres://nostro:s3cret@[db/books')).toBe('postgres://***@[db/books')
  })
})
