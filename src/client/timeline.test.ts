import { describe, expect, it } from 'vitest'
import { AssetInput } from '../contract/models.js'
import { en } from './messages.js'
import {
  actionKey,
  changeLineKind,
  changeShape,
  fieldKey,
  isKnownAction,
  isLongText,
  isOpaque,
  noteOf,
  personIdOf,
} from './timeline.js'

/**
 * The decisions behind a readable timeline, checked where they can be checked.
 *
 * `Timeline.svelte` supplies the words; every judgement it makes — which sentence, about whom, with
 * what label — is in `timeline.ts`, and each one has a right answer. The three that matter are the
 * ones nothing else can catch:
 *
 *   1. an action the catalogue has no sentence for must not be described as something else;
 *   2. a field added to the contract must not reach a screen as its own column name;
 *   3. a return names who gave it back, not who received it — they are different keys in `data`,
 *      and reading the wrong one renders "took it back from nobody".
 */
describe('actionKey', () => {
  it('names a key the catalogue actually has, for every action the server writes', () => {
    // Exactly what `AssetService` and `CustodyService` write today.
    for (const action of [
      'created',
      'updated',
      'assigned',
      'transferred',
      'returned',
      'retired',
      'restored',
    ]) {
      expect({ action, key: actionKey(action) }).toEqual({ action, key: `history_${action}` })
      expect({ action, has: `inventory.${actionKey(action)}` in en }).toEqual({ action, has: true })
    }
  })

  it('falls back honestly for an action written by a newer image', () => {
    // Reservations and stock counts write their own actions, and a browser tab open across a
    // deploy will meet one. "Somebody changed it — reserved" is true; "edited it" would not be.
    expect(actionKey('reserved')).toBe('history_unknown')
    expect(isKnownAction('reserved')).toBe(false)
    expect('inventory.history_unknown' in en).toBe(true)
  })

  it('phrases what repairs and attachments write, rather than falling back', () => {
    // These four were the fallback's example until the change that made them real. An action this
    // client *does* know must never render as "changed it — repair_logged".
    for (const action of ['repair_logged', 'repair_completed', 'attachment_added', 'attachment_removed']) {
      expect({ action, key: actionKey(action) }).toEqual({ action, key: `history_${action}` })
      expect({ action, has: `inventory.${actionKey(action)}` in en }).toEqual({ action, has: true })
    }
  })
})

describe('fieldKey', () => {
  it('labels every field the contract lets somebody edit', () => {
    // `AssetInput` is the whole of what `assets.update` accepts, and therefore the whole of what a
    // stored diff can name. A field added there with no key here would print `warrantyUntil` in the
    // middle of a Persian sentence.
    for (const field of Object.keys(AssetInput.shape)) {
      const key = fieldKey(field)
      expect({ field, key }).not.toEqual({ field, key: null })
      expect({ field, has: `inventory.${key}` in en }).toEqual({ field, has: true })
    }
  })

  it('says it does not know a field rather than guessing at one', () => {
    expect(fieldKey('somethingNewer')).toBe(null)
  })
})

describe('changeShape', () => {
  it('tells filling a field in from clearing it from moving it', () => {
    expect(changeShape(null, 'Desk 4')).toBe('set')
    expect(changeShape('Desk 4', null)).toBe('cleared')
    expect(changeShape('Desk 4', 'Desk 5')).toBe('changed')
  })

  it('treats an empty string as absent, because that is what clearing a description stores', () => {
    // `description` is `not null` in the database, so emptying it writes `''` — and "changed from
    // to x" is a sentence with a hole in it.
    expect(changeShape('', 'A note')).toBe('set')
    expect(changeShape('A note', '')).toBe('cleared')
  })
})

describe('personIdOf', () => {
  it('reads the recipient for a handover and the giver for a return', () => {
    expect(personIdOf('assigned', { userId: 'ada' })).toBe('ada')
    expect(personIdOf('transferred', { userId: 'bruno', previousUserId: 'ada' })).toBe('bruno')
    // The one that would silently read "nobody": `returned` stores no `userId` at all.
    expect(personIdOf('returned', { previousUserId: 'ada' })).toBe('ada')
  })

  it('has no person for an entry that is not about one', () => {
    expect(personIdOf('created', {})).toBe(null)
    expect(personIdOf('assigned', { userId: 123 })).toBe(null)
  })
})

describe('noteOf', () => {
  it('takes a note only when somebody actually wrote one', () => {
    expect(noteOf({ note: '  For the Berlin trip ' })).toBe('For the Berlin trip')
    expect(noteOf({ note: '   ' })).toBe(null)
    expect(noteOf({})).toBe(null)
  })
})

/**
 * The decision that keeps eight kilobytes of somebody's prose out of a row of the panel.
 *
 * `description` is `z.string().max(8000)` in the contract, and the timeline read a change to it out
 * as "Description changed from … to …" with both versions inline — so one edit to one paragraph
 * pushed every entry below it off a 440px sheet. Nothing failed: the string was correct, the
 * translation was correct, and the row was unusable.
 */
describe('changeLineKind', () => {
  it('says only that a description changed, and never what it says', () => {
    const long = 'x'.repeat(8000)
    expect(changeLineKind('description', 'before', long)).toBe('text_changed')
    // Filling one in for the first time is the same sentence once the value is gone: two keys
    // saying "Description changed" would be two translations to keep in step for no gain.
    expect(changeLineKind('description', null, long)).toBe('text_changed')
  })

  it('decides on the field, not on how long the value happens to be today', () => {
    // A short description is still prose. Branching on length would make the timeline's shape
    // depend on what somebody typed, so the same field would render two different ways.
    expect(changeLineKind('description', 'a', 'b')).toBe('text_changed')
    expect(isLongText('description')).toBe(true)
    expect(isLongText('location')).toBe(false)
  })

  it('still says "cleared" when a description is emptied — there is nothing to disclose', () => {
    // `description` is `not null` in the database, so clearing it stores `''`.
    expect(changeLineKind('description', 'A note', '')).toBe('cleared')
    expect(changeLineKind('description', 'A note', null)).toBe('cleared')
  })

  it('keeps reading an ordinary field out, which is the whole point of a timeline', () => {
    expect(changeLineKind('location', null, 'Desk 4')).toBe('set')
    expect(changeLineKind('location', 'Desk 4', 'Desk 5')).toBe('changed')
    expect(changeLineKind('location', 'Desk 4', null)).toBe('cleared')
  })

  it('reports an opaque id as a replacement rather than printing a uuid', () => {
    expect(isOpaque('photoFileId')).toBe(true)
    expect(changeLineKind('photoFileId', 'a', 'b')).toBe('replaced')
    // Removing the photo is still "cleared": there is no id to avoid printing.
    expect(changeLineKind('photoFileId', 'a', null)).toBe('cleared')
  })

  it('names a key the catalogue has, for every kind it can return', () => {
    const keys = {
      cleared: 'history_cleared',
      replaced: 'history_replaced',
      set: 'history_set',
      changed: 'history_changed',
      text_changed: 'history_text_changed',
    }
    for (const key of Object.values(keys))
      expect({ key, has: `inventory.${key}` in en }).toEqual({ key, has: true })
    // And the disclosure's own three, which `TimelineText.svelte` reads.
    for (const key of ['history_show_text', 'history_text_before', 'history_text_after'])
      expect({ key, has: `inventory.${key}` in en }).toEqual({ key, has: true })
  })
})
