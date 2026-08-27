import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  codeOf,
  errorLine,
  errorMessage,
  isInputValidation,
  messageOf,
  reasonKeys,
  reasonOf,
} from './errors.js'
import { en } from './messages.js'

/**
 * Every actionable failure a person can hit, in a language they chose.
 *
 * Eight call sites read `toast.error(error.message || t('common.error'))`, and `error.message` is a
 * sentence the *server* wrote in English. So a Persian reader losing a race on a handover was shown
 * "Somebody changed who is holding this a moment before you did. Reload to see where it is now." —
 * the single most useful sentence this module has, in the wrong language, at the exact moment they
 * needed to read it.
 *
 * Three things are checked here, and the third is the one that lasts:
 *
 *   1. the reason token is found wherever a transport puts it, and the code when there is none;
 *   2. every key this file can name exists in the catalogue, so none renders as its own key;
 *   3. **every reason the server actually throws has a sentence here** — read out of
 *      `src/server`, so a refusal added next month fails in this file rather than reaching
 *      somebody's screen in English.
 */
const conflict = (reason: string, message = 'English prose the server wrote.') => ({
  code: 'CONFLICT',
  message,
  data: { reason },
})

describe('reading what the server sent', () => {
  it('finds the reason where `kernErrorToORPC` puts it', () => {
    // The reason is folded into `data` rather than sent beside it, because `data` is what oRPC
    // already carries to the client.
    expect(reasonOf(conflict('inventory.custody.conflict'))).toBe('inventory.custody.conflict')
  })

  it('finds it on the error itself too, which is where the in-memory mock carries it', () => {
    expect(reasonOf({ code: 'CONFLICT', reason: 'inventory.custody.not_held' })).toBe(
      'inventory.custody.not_held',
    )
  })

  it('has no reason for a plain failure, rather than inventing one', () => {
    expect(reasonOf(new Error('network'))).toBe(null)
    expect(reasonOf(null)).toBe(null)
    expect(reasonOf({ data: { reason: 42 } })).toBe(null)
  })

  it('reads the code, and keeps the server sentence for the fallback line', () => {
    expect(codeOf({ code: 'NOT_FOUND' })).toBe('NOT_FOUND')
    expect(codeOf(new Error('boom'))).toBe(null)
    expect(messageOf(new Error('  boom  '))).toBe('boom')
    expect(messageOf({ message: '   ' })).toBe(null)
  })
})

describe('which sentence a refusal earns', () => {
  it('translates the conflict on a handover, which is the message that mattered most', () => {
    expect(errorLine(conflict('inventory.custody.conflict'))).toEqual({
      key: 'error_custody_conflict',
      detail: null,
    })
  })

  it('drops the server prose once it has named the failure itself', () => {
    // Keeping it would print an English sentence under the Persian one, undoing the translation.
    expect(errorLine(conflict('inventory.category.name_taken')).detail).toBe(null)
  })

  /**
   * A **disabled capability answers 404, not 403** — the module contract says so, and the shell has
   * already hidden the navigation for it. So a workspace that switches `repairs` off mid-session
   * lands here, and "it is no longer there, reload" is the right sentence for it.
   */
  it('falls back to the class of failure when there is no reason', () => {
    expect(errorLine({ code: 'NOT_FOUND', message: 'Asset not found' })).toEqual({
      key: 'error_not_found',
      detail: null,
    })
    expect(errorLine({ code: 'MODULE_DISABLED', message: 'Module inventory is disabled' }).key).toBe(
      'error_module_disabled',
    )
    expect(errorLine({ code: 'FORBIDDEN' }).key).toBe('error_forbidden')
  })

  it('prefers the reason over the code, because it is the more specific fact', () => {
    expect(errorLine(conflict('inventory.repair.already_open')).key).toBe('error_repair_already_open')
    expect(errorLine({ code: 'CONFLICT' }).key).toBe('error_conflict')
  })

  /**
   * A reason a newer server invented, an error from core, a socket that died. The generic sentence
   * says what happened and the server's words are kept as the only actionable clue left — as
   * *detail*, under a sentence that is at least in the reader's language.
   */
  it('keeps the server words only for a failure it does not recognise', () => {
    const unknown = { code: 'CONFLICT', message: 'Some newer refusal.', data: { reason: 'inventory.x.y' } }
    // A reason nothing here maps falls through to the code, which is still translated.
    expect(errorLine(unknown).key).toBe('error_conflict')
    expect(errorLine(new Error('Failed to fetch'))).toEqual({
      key: 'error_unknown',
      detail: 'Failed to fetch',
    })
  })

  it('says something rather than nothing for a failure with no words at all', () => {
    expect(errorLine({})).toEqual({ key: 'error_unknown', detail: null })
    expect(errorMessage({}, (key) => key)).toBe('error_unknown')
  })

  /**
   * The four refusals that were told to go and check a form where nothing was wrong.
   *
   * `KernError.badRequest` and oRPC's own schema failure both come out as `BAD_REQUEST`, and the
   * client mapped every one of them to "Something in the form was not accepted. Check what you
   * entered." The server was actually saying "That person is not a member of this workspace", "That
   * file has not finished uploading yet", "That file is not one this workspace can attach" and
   * "That page marker is not one this list issued" — none of which is a field somebody typed
   * wrong. A confident wrong instruction is worse than a vague right one: nobody finds the mistake,
   * because there isn't one.
   *
   * `data.issues` is the only structural difference between the two, and oRPC always sets it —
   * `validateInput` throws `ORPCError('BAD_REQUEST', { data: { issues } })`.
   */
  describe('a refusal is not a form error', () => {
    const refusal = (message: string) => ({ code: 'BAD_REQUEST', message })

    it('tells a validation failure from a service refusing', () => {
      expect(isInputValidation({ code: 'BAD_REQUEST', data: { issues: [{ message: 'too long' }] } })).toBe(
        true,
      )
      expect(isInputValidation(refusal('That file has not finished uploading yet.'))).toBe(false)
      expect(isInputValidation({ data: { issues: 'nope' } })).toBe(false)
      expect(isInputValidation(null)).toBe(false)
    })

    it('keeps "check what you entered" for the failure that really is about the form', () => {
      expect(
        errorLine({
          code: 'BAD_REQUEST',
          message: 'Input validation failed',
          data: { issues: [{ message: 'Too long' }] },
        }),
      ).toEqual({ key: 'error_bad_request', detail: null })
      // `VALIDATION` is the code making that claim itself, so it needs no issues to be believed.
      expect(errorLine({ code: 'VALIDATION' }).key).toBe('error_bad_request')
    })

    it('does not send anybody to the form for any of the four the server actually refuses', () => {
      for (const message of [
        'That person is not a member of this workspace, so nothing can be handed to them.',
        'That file has not finished uploading yet.',
        'That file is not one this workspace can attach.',
        'That page marker is not one this list issued',
      ]) {
        expect(errorLine(refusal(message))).toEqual({ key: 'error_refused', detail: message })
      }
    })

    /**
     * Until those four carry a stable `reason`, the server's own sentence is the only thing that
     * says *which* refusal it was — so it is kept, as detail under a translated line. Dropping it
     * would leave "That was not accepted." and nothing else.
     */
    it('keeps the server’s explanation, because nothing else identifies the refusal', () => {
      expect(errorMessage(refusal('That file has not finished uploading yet.'), (key) => `<${key}>`)).toBe(
        '<error_refused> — That file has not finished uploading yet.',
      )
      // And says something rather than nothing when there are no words at all.
      expect(errorLine({ code: 'BAD_REQUEST' })).toEqual({ key: 'error_refused', detail: null })
    })

    /**
     * The moment the server does carry one, that reason wins and the sentence is fully translated.
     * Nothing is required of this file then except an entry in `REASON_KEYS` — this checks the
     * precedence is already the right way round.
     */
    it('prefers a reason over the refusal fallback, once the server carries one', () => {
      expect(
        errorLine({
          code: 'BAD_REQUEST',
          message: 'This item is archived. Restore it before handing it over.',
          data: { reason: 'inventory.custody.archived' },
        }),
      ).toEqual({ key: 'error_custody_archived', detail: null })
    })
  })

  it('joins the sentence and the detail into one line for the toast', () => {
    expect(errorMessage(new Error('Failed to fetch'), (key) => `<${key}>`)).toBe(
      '<error_unknown> — Failed to fetch',
    )
    expect(errorMessage(conflict('inventory.custody.not_held'), (key) => `<${key}>`)).toBe(
      '<error_custody_not_held>',
    )
  })
})

// ------------------------------------------------------- the two lists that have to stay in step

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'server')

/**
 * Every reason literal the server passes to a `KernError`, dug out of the source.
 *
 * Deliberately not a grep for `'inventory.…'`: permission keys, capability ids and notification
 * types all look exactly like a reason token, and matching them would demand a sentence for things
 * that are not refusals. This reads the argument position instead — the second of `conflict` and
 * `notFound`, the fourth of the constructor — which is the only place a reason can be.
 */
function serverReasons(): string[] {
  const found = new Set<string>()
  const files = readdirSync(SERVER, { recursive: true, encoding: 'utf8' }).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
  )
  for (const file of files) {
    const source = readFileSync(join(SERVER, file), 'utf8')
    for (const [call, position] of [
      ['KernError.conflict(', 1],
      ['KernError.notFound(', 1],
      ['new KernError(', 3],
    ] as const) {
      let at = source.indexOf(call)
      while (at !== -1) {
        const args = argumentsOf(source, at + call.length - 1)
        const literal = args?.[position]?.trim().match(/^'([^']+)'$/)?.[1]
        if (literal?.startsWith('inventory.')) found.add(literal)
        at = source.indexOf(call, at + 1)
      }
    }
  }
  return [...found].sort()
}

/**
 * The arguments of a call, split on the commas that are actually arguments.
 *
 * **String-aware, and that is not fussiness.** The first version split on every top-level comma and
 * missed `inventory.custody.not_held` — because its message is "Nobody is holding this item, so
 * there is nothing to hand on. Assign it instead." and the comma inside the sentence made the
 * reason the *third* argument. A scanner that silently finds fewer things than there are is worse
 * than no scanner: it passes.
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

/**
 * Every sentence the server passes to `KernError.badRequest`, dug out of the source.
 *
 * The same trick `serverReasons` uses and for the same reason: the list grows. It was four when
 * this was written — a non-member, an unfinished upload, a file from another workspace, a page
 * marker this list never issued — and by the time it was finished it was six. None of them is a
 * form-validation failure, and every one of them used to arrive as "check what you entered".
 */
function serverBadRequests(): string[] {
  const found = new Set<string>()
  const call = 'KernError.badRequest('
  const files = readdirSync(SERVER, { recursive: true, encoding: 'utf8' }).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
  )
  for (const file of files) {
    const source = readFileSync(join(SERVER, file), 'utf8')
    let at = source.indexOf(call)
    while (at !== -1) {
      const literal = argumentsOf(source, at + call.length - 1)?.[0]
        ?.trim()
        .match(/^'((?:[^'\\]|\\.)*)'$/)?.[1]
      if (literal) found.add(literal)
      at = source.indexOf(call, at + 1)
    }
  }
  return [...found].sort()
}

describe('the catalogue keeps up with the server', () => {
  /**
   * Not one of the module's own `BAD_REQUEST` refusals is about a field somebody typed, so not one
   * of them may land on `error_bad_request`. This reads them out of `src/server` rather than
   * listing them, so a refusal added next month is covered the day it is written — and if one ever
   * *is* a form error, it fails here and asks for a `reason` instead of a reworded sentence.
   */
  it('sends no refusal the server actually throws back to the form', () => {
    const refusals = serverBadRequests()
    expect(refusals.length).toBeGreaterThan(3)
    for (const message of refusals)
      expect({ message, line: errorLine({ code: 'BAD_REQUEST', message }) }).toEqual({
        message,
        line: { key: 'error_refused', detail: message },
      })
  })

  it('has a translated sentence for every reason the server throws', () => {
    // If this fails, a refusal was added to `src/server` without a sentence — and it will reach a
    // Persian, Arabic, German or Turkish reader as English prose. Add the reason to `REASON_KEYS`
    // and the sentence to all five bundles.
    const missing = serverReasons().filter((reason) => !reasonKeys().includes(reason))
    expect(missing).toEqual([])
  })

  it('is reading the server rather than passing on an empty sweep', () => {
    // An empty result would make the check above pass for ever. The services throw eleven of these.
    expect(serverReasons().length).toBeGreaterThan(8)
  })

  it('names no reason the server does not throw', () => {
    // The other direction: a sentence for a refusal that cannot happen is dead weight nobody will
    // ever notice has gone wrong.
    const server = serverReasons()
    expect(reasonKeys().filter((key) => !server.includes(key))).toEqual([])
  })

  it('names a key the catalogue actually has, for every reason and every code', () => {
    const keys = new Set<string>()
    for (const reason of reasonKeys()) keys.add(errorLine(conflict(reason)).key)
    for (const code of [
      'NOT_FOUND',
      'FORBIDDEN',
      'MODULE_DISABLED',
      'CONFLICT',
      'BAD_REQUEST',
      'VALIDATION',
      'UNAUTHORIZED',
      'RATE_LIMITED',
      'UNAVAILABLE',
      'INTERNAL',
    ])
      keys.add(errorLine({ code }).key)
    for (const key of keys) expect({ key, has: `inventory.${key}` in en }).toEqual({ key, has: true })
  })
})
