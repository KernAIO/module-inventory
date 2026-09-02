/**
 * Turning a stored history row into something a person reads.
 *
 * `asset_history` holds `{ action, changes: [{field, from, to}], data: {…ids} }`, which is a shape
 * for a database and not a sentence. A panel that renders it raw shows somebody a JSON diff of
 * their own laptop; the point of a timeline is that it reads as "Ada handed it to Bruno".
 *
 * **"it", not the asset tag** — and this note exists because the README claimed otherwise for a
 * release. The timeline only ever appears inside that asset's own panel, under a header already
 * showing `INV-0042`, so naming the tag in all fifty entries would repeat on every line the one
 * thing that cannot change while somebody is reading it.
 *
 * The decisions live here rather than inside the component for the reason `price.ts` does: a
 * `.svelte` file drags a compiler behind it and cannot be unit-tested, and every one of these is a
 * fact with a right answer. The component supplies the words — this file only says which words and
 * about whom.
 *
 * Nothing here imports `@kernhq/ui`. That entry point reaches the Svelte components, and a helper
 * that pulls a compiler into whatever imports it is a helper nothing can test.
 */

/** Every action this client knows how to phrase. Anything else is honest about not knowing. */
const KNOWN = new Set([
  'created',
  'updated',
  'assigned',
  'transferred',
  'returned',
  'archived',
  'restored',
  'lost',
  'written_off',
  'reinstated',
  'repair_logged',
  'repair_completed',
  'attachment_added',
  'attachment_removed',
])

/**
 * Actions an earlier image wrote under a different name, and the name they read as now.
 *
 * `archived` was written as `retired` until 0.5.0. The rows are still there and always will be —
 * nothing edits history — and the word now means something else in this module, so the old rows
 * are read as the sentence they always meant rather than as the one the word now means.
 */
const RENAMED: Record<string, string> = { retired: 'archived' }

/**
 * The message key for one entry's headline.
 *
 * An unknown action is **not** silently rendered as "changed it". The rows outlive the client that
 * reads them: repairs and attachments write their own actions, and a browser tab left open across
 * a deploy will meet one. `history_unknown` says somebody changed it and names the action, which is
 * honest about the gap; a generic "changed it" would quietly describe a repair as an edit for as
 * long as the tab stayed open.
 */
export function actionKey(action: string): string {
  const current = RENAMED[action] ?? action
  return KNOWN.has(current) ? `history_${current}` : 'history_unknown'
}

export const isKnownAction = (action: string): boolean => KNOWN.has(RENAMED[action] ?? action)

/**
 * Which sentence a single field change wants.
 *
 * "from nothing to Desk 4" is not a change a person recognises — they filled a field in. The three
 * shapes are the three sentences: filled in, cleared, and moved from one value to another.
 *
 * An empty string counts as absent, because that is what the asset form writes for a field somebody
 * emptied: `description` is `not null` in the database, so clearing it stores `''` and never
 * `null`, and `'' → 'x'` reported as "changed from  to x" is a sentence with a hole in it.
 */
export type ChangeShape = 'set' | 'cleared' | 'changed'

const absent = (value: unknown): boolean => value === null || value === undefined || value === ''

export function changeShape(from: unknown, to: unknown): ChangeShape {
  if (absent(to)) return 'cleared'
  if (absent(from)) return 'set'
  return 'changed'
}

/**
 * Who did it is `resolveName` in `members.ts`, and deliberately not here.
 *
 * This file used to carry an `actorKind(actorId, known)` that answered `person`, `former` or
 * `system` from a bare set of ids. It was a second implementation of a question `members.ts`
 * already answers, and it made the same mistake `nameOf` did: a set that has not been fetched yet
 * is indistinguishable from a set somebody has left, so an id absent from it came back as `former`
 * while the request was still in flight. A set cannot say which — only the request's own state can
 * — so the question belongs where the directory is, with the five answers `NameKind` names.
 */

/**
 * The message key naming a field, for the one sentence per change.
 *
 * A stored diff names its column (`serialNumber`, `warrantyUntil`), which is a word for a database
 * and not for a reader — «warrantyUntil از ۲۰۲۷ به ۲۰۲۸ تغییر کرد» is English leaking into a Persian
 * sentence in exactly the place a translation was supposed to be. The map is the whole of
 * `AssetInput`, and `timeline.test.ts` holds it to that: a field added to the contract with no key
 * here shows up as a failing test rather than as a column name on somebody's screen.
 *
 * `null` for a field this client has never heard of. The rows outlive the image that wrote them, so
 * a browser tab open across a deploy will meet one, and the component prints the raw name — which is
 * ugly and true, where a guessed label would be neither.
 */
const FIELD_KEYS: Record<string, string> = {
  name: 'name',
  description: 'description',
  categoryId: 'category',
  serialNumber: 'serial_number',
  location: 'location',
  purchasedFrom: 'purchased_from',
  purchasedOn: 'purchased_on',
  warrantyUntil: 'warranty_until',
  priceMinor: 'price',
  currency: 'currency',
  photoFileId: 'photo',
  // The bag itself, which no diff line ever names: a change to a custom value is recorded under
  // `custom.<key>` — see `customKeyOf` — so this entry exists for `timeline.test.ts`'s rule that
  // every key of `AssetInput` has a word, and for nothing else.
  custom: 'custom_fields',
}

export function fieldKey(field: string): string | null {
  return FIELD_KEYS[field] ?? null
}

/**
 * The field key behind a `custom.<key>` diff line, or null for a built-in field.
 *
 * A custom value's change is recorded under the key it is stored under, and the *name* to print is
 * the field definition's — which lives in a query the component holds, not here. So this only says
 * which key to look up; the component asks its definitions for the word, and prints the key itself
 * for a field that has since been archived out of the list it loaded, which is ugly and true.
 */
export function customKeyOf(field: string): string | null {
  return field.startsWith('custom.') && field.length > 'custom.'.length ? field.slice('custom.'.length) : null
}

/**
 * Which fields hold prose rather than a value, and therefore cannot be read out in a sentence.
 *
 * `description` is `z.string().max(8000)` in the contract, and the timeline rendered a change to it
 * as "Description changed from … to …" with both versions inline — up to sixteen kilobytes of
 * somebody's prose in a single row of a 440px panel, and every row below it pushed off the screen.
 * A diff line is a sentence about a value; eight thousand characters is not a value.
 *
 * So a long-text change says **that** it changed and offers the text behind a disclosure, which is
 * `TimelineText.svelte` — the two versions are only put in the document when somebody asks for
 * them. The list stays a list, and nothing is hidden: the text is one keystroke away, labelled
 * before and after.
 *
 * A set rather than a length check on the value, because the decision is about the *field*: a short
 * description is still prose, and rendering it inline on the days it happens to be short would make
 * the timeline's shape depend on what somebody typed.
 */
const LONG_TEXT = new Set(['description'])

export const isLongText = (field: string): boolean => LONG_TEXT.has(field)

/**
 * The sentence a change to one field wants, as a key name.
 *
 * One function rather than the component branching on `isLongText` and `changeShape` separately,
 * because the combination is the decision: clearing a description is still just "Description
 * cleared" — short, complete, and nothing to disclose — while setting or changing one is the case
 * that must not read its own value out.
 *
 * `text_changed` covers both `set` and `changed` for prose. "Description set to …" and "Description
 * changed from … to …" are the same sentence once the values are gone, and two keys saying the same
 * thing are two translations to keep in step for no gain.
 */
export type ChangeLine = 'cleared' | 'replaced' | 'set' | 'changed' | 'text_changed'

/**
 * A field whose value is an opaque id is reported as a replacement rather than with a uuid in it.
 *
 * `photoFileId` is the only one: the value is a file id, and "Photo changed from 0192… to 0193…"
 * says less than "Photo replaced" while being longer and uglier.
 */
const OPAQUE = new Set(['photoFileId'])

export const isOpaque = (field: string): boolean => OPAQUE.has(field)

export function changeLineKind(field: string, from: unknown, to: unknown): ChangeLine {
  const shape = changeShape(from, to)
  if (shape === 'cleared') return 'cleared'
  if (isOpaque(field)) return 'replaced'
  return isLongText(field) ? 'text_changed' : shape
}

/**
 * The other person in a custody sentence, out of the entry's `data`.
 *
 * `assigned` and `transferred` name who received it; `returned` names who gave it back, and both are
 * stored under different keys because they are different facts. Reading `userId` for all three would
 * make a return read "took it back from nobody" — the key is simply absent there.
 */
export function personIdOf(action: string, data: Record<string, unknown>): string | null {
  const value = action === 'returned' ? data.previousUserId : data.userId
  return typeof value === 'string' && value ? value : null
}

/** The note, if whoever handed the item over — or marked it lost, or retired it — left one. */
export function noteOf(data: Record<string, unknown>): string | null {
  const note = data.note
  return typeof note === 'string' && note.trim() ? note.trim() : null
}

/**
 * The thing an entry is *about*, when the sentence alone does not say it.
 *
 * "Ada sent it for repair" is a sentence; which repair is the summary somebody typed, and "Ada
 * attached a file" is missing the only interesting word in it. Both are rendered as a second line
 * under the headline rather than interpolated into it, and neither goes through the catalogue —
 * this is text a person typed or a file they named, so translating around it would be translating
 * a placeholder.
 *
 * Two keys rather than one because they are two facts: a repair's `summary` and a file's `name`.
 * Reading one key for both would print a file id where a summary belongs the day a third action
 * arrives. Null for anything else, and for a row written before this client knew the key — the rows
 * outlive the image that wrote them.
 */
export function subjectOf(action: string, data: Record<string, unknown>): string | null {
  const value =
    action === 'repair_logged' || action === 'repair_completed'
      ? data.summary
      : action === 'attachment_added' || action === 'attachment_removed'
        ? data.name
        : null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
