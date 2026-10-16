/**
 * What a command may touch outside itself. `bin.ts` passes the real process;
 * tests pass strings and a fake Horizon, so every command runs in-process.
 */

export interface Output {
  /** Returns false when the caller should wait for `drain`, as a Node stream does. */
  write(chunk: string): boolean
  once?(event: 'drain', listener: () => void): unknown
  readonly isTTY?: boolean
}

export interface Io {
  readonly stdout: Output
  readonly stderr: Output
  readonly env: Readonly<Record<string, string | undefined>>
  /** Relative database paths and output files resolve against this. */
  readonly cwd: string
  /** Used for every Horizon request. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

/** Write a chunk, waiting for the stream to drain if it asks. */
export async function write(out: Output, chunk: string): Promise<void> {
  if (out.write(chunk) || out.once === undefined) return
  await new Promise<void>((resolve) => out.once!('drain', resolve))
}

/**
 * Make text safe to print to a terminal. Memos, references and exception
 * details can come from whoever sent a payment, so control characters
 * (which can rewrite the screen) and bidirectional overrides (which can make
 * text read differently from what it is) are shown escaped, never sent raw.
 */
export function clean(text: string): string {
  return text.replace(
    /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** Left-aligned columns, two spaces apart. Cells are cleaned. */
export function table(rows: readonly (readonly string[])[]): string {
  const cells = rows.map((r) => r.map(clean))
  const widths: number[] = []
  for (const r of cells) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)))
  return cells.map((r) => `${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ')}\n`).join('')
}

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
