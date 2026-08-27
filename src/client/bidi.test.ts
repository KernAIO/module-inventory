import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FSI, isolate, isolated, PDI } from './bidi.js'

/**
 * The rule that stops a Latin value rendering backwards inside a Persian or Arabic sentence.
 *
 * Two halves, and the second is the one that lasts. The first checks `isolate()` itself. The second
 * reads every client source and refuses a `t()` call that interpolates a value without isolating it
 * — because this defect is invisible in the source, invisible in a type-check, invisible in
 * English, and only appears as a quote or a full stop at the wrong end of a name on somebody's
 * screen. A message added next year with a `{name}` in it fails here rather than there.
 */
describe('isolate', () => {
  it('wraps a value in the first-strong isolate pair', () => {
    expect(isolate('MacBook Pro 14"')).toBe(`${FSI}MacBook Pro 14"${PDI}`)
  })

  it('leaves an absent value as nothing at all, rather than two invisible characters', () => {
    // `{name}` at a call site is very often `asset?.name ?? ''`, and a placeholder nothing filled
    // should leave no trace in the sentence.
    expect(isolate('')).toBe('')
    expect(isolate(null)).toBe('')
    expect(isolate(undefined)).toBe('')
  })

  it('is idempotent, so a value isolated twice is still one run', () => {
    // `history_cleared` passes a `field` that is already `t(key)` or an isolated column name, and
    // `isolated({ field })` runs over it again. An unbalanced nest would reorder the sentence.
    expect(isolate(isolate('INV-0042'))).toBe(isolate('INV-0042'))
  })

  it('strips embedding controls that rode along on a pasted value', () => {
    // The same characters `price.ts` strips before parsing a number: they arrive by copying out of
    // an RTL document, and an unbalanced one inside an isolate reorders the rest of the sentence.
    expect(isolate('‫C02X1234')).toBe(`${FSI}C02X1234${PDI}`)
  })

  it('takes a number as readily as a string', () => {
    expect(isolate(42)).toBe(`${FSI}42${PDI}`)
  })

  it('isolates every value of a bag, so a parameter added later is covered by construction', () => {
    expect(isolated({ actor: 'Ada', person: 'Bruno' })).toEqual({
      actor: `${FSI}Ada${PDI}`,
      person: `${FSI}Bruno${PDI}`,
    })
  })
})

// ---------------------------------------------------------------- every call site, mechanically

const HERE = dirname(fileURLToPath(import.meta.url))

/** Comments only. Never a code line, so a `//` inside a string literal cannot truncate a call. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    .join('\n')
}

/**
 * The arguments of a call, split on the commas that are actually arguments.
 *
 * **String-aware**, because a message key is not the only thing that can carry a comma and a
 * scanner that silently finds fewer call sites than there are is one that passes while the defect
 * ships. `errors.test.ts` has the same walker for the same reason.
 */
function argumentsOf(source: string, open: number): string[] | null {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = open + 1
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--
      if (depth === 0) {
        parts.push(source.slice(start, i))
        return parts
      }
    } else if (ch === ',' && depth === 1) {
      parts.push(source.slice(start, i))
      start = i + 1
    }
  }
  return null
}

/** The second argument of every `t(…)` call that has one. */
function parameterisedCalls(source: string): Array<{ key: string; params: string }> {
  const found: Array<{ key: string; params: string }> = []
  for (const match of source.matchAll(/\bt\(/g)) {
    const args = argumentsOf(source, match.index + match[0].length - 1)
    if (!args || args.length < 2) continue
    found.push({ key: args[0]!.trim(), params: args.slice(1).join(',').trim() })
  }
  return found
}

/**
 * A count is exempt, and must be: `t()` formats a number through `Intl.NumberFormat`, so «۱۲»
 * reaches a Persian reader as their own digits. Isolating it would hand `t()` a string instead and
 * print "12" in the middle of a Persian sentence — the opposite of the fix.
 */
const COUNT_ONLY = /^\{\s*(n|count)\s*(:[^,}]+)?\s*\}$/

function sources(): Array<{ file: string; text: string }> {
  return readdirSync(HERE, { recursive: true, encoding: 'utf8' })
    .filter((file) => (file.endsWith('.ts') || file.endsWith('.svelte')) && !file.endsWith('.test.ts'))
    .map((file) => ({ file, text: stripComments(readFileSync(join(HERE, file), 'utf8')) }))
}

describe('every translated sentence isolates the values put into it', () => {
  it('passes `isolated(…)` at every parameterised call site, or a bare count', () => {
    const offenders: string[] = []
    for (const { file, text } of sources())
      for (const { key, params } of parameterisedCalls(text))
        if (!params.startsWith('isolated(') && !COUNT_ONLY.test(params))
          offenders.push(`${file}: t(${key}, ${params.replace(/\s+/g, ' ')})`)
    expect(offenders).toEqual([])
  })

  /**
   * The scanner has to actually find things, or an empty result would pass for ever. This module
   * has dozens of parameterised messages; a run that finds none means the matcher broke, not that
   * the code got better.
   */
  it('is looking at real call sites rather than passing on an empty sweep', () => {
    const total = sources().reduce((sum, { text }) => sum + parameterisedCalls(text).length, 0)
    expect(total).toBeGreaterThan(20)
  })
})
