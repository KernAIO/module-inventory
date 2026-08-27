/**
 * Moving one row up or down a list, and saying where it landed.
 *
 * Pure arithmetic, in its own file, for the reason `custody.ts` and `price.ts` are: a `.svelte` file
 * cannot be unit-tested here, so anything inside one is only ever checked by reading it. The ends of
 * a list are exactly where an off-by-one lives — moving the first row up, moving the last row down,
 * dragging something to a position it already occupies — and those are three assertions rather than
 * three careful reads.
 *
 * **A no-op returns the array it was given, by reference.** That is the signal the caller acts on:
 * nothing moved, so there is nothing to send and nothing to announce as a move. Returning an equal
 * copy would look identical in a test and cost a request every time somebody pressed *move up* on
 * the row that is already first.
 */

/**
 * The one property `svelte-dnd-action` reads, and therefore the one this file needs.
 *
 * The library tracks items by `id` and by nothing else — a list keyed by anything else renders
 * perfectly and refuses to move, by mouse and by keyboard, with no error at all. A `Category` has
 * an `id` already, which is the only reason the settings page hands its rows over unwrapped.
 */
export interface Ordered {
  id: string
}

/**
 * The list with `id` moved `delta` places, or the same list when that would change nothing.
 *
 * `delta` is clamped rather than refused: *move up* on the first row is a thing somebody will press,
 * and the honest answer is "it is already first", not an error. The input is never mutated.
 */
export function moveBy<T extends Ordered>(items: readonly T[], id: string, delta: number): readonly T[] {
  const from = items.findIndex((item) => item.id === id)
  if (from === -1) return items
  const to = Math.min(items.length - 1, Math.max(0, from + delta))
  if (to === from) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved as T)
  return next
}

/** Where a row sits now, in the terms a sentence can use — never as a number. */
export type Placement<T> =
  | { at: 'first' }
  | { at: 'last' }
  /** Somewhere in the middle: the row it now follows is what identifies the spot. */
  | { at: 'after'; previous: T }
  /** It is not in this list at all — it was archived or removed while the page was open. */
  | { at: 'gone' }

/**
 * Where `id` ended up, for the sentence a screen reader is given.
 *
 * **"first", "last" or "after {name}" rather than a position number.** A number is the thing this
 * whole screen stopped showing: nobody arranges their categories by index, and "moved to position 4
 * of 9" asks somebody to hold two numbers in their head to work out what a neighbour's name would
 * have told them outright. A one-row list is `first`, which is true and reads better than `last`.
 */
export function placementOf<T extends Ordered>(items: readonly T[], id: string): Placement<T> {
  const at = items.findIndex((item) => item.id === id)
  if (at === -1) return { at: 'gone' }
  if (at === 0) return { at: 'first' }
  if (at === items.length - 1) return { at: 'last' }
  return { at: 'after', previous: items[at - 1] as T }
}

/**
 * Whether two lists hold the same ids in the same order.
 *
 * What decides a request is worth making. A drag that ends where it started fires `finalize` exactly
 * as a real one does — the library has no opinion about whether anything moved — so without this
 * every aborted drag would post a reorder and every open screen in the workspace would be told
 * about a write that changed nothing.
 */
export function sameOrder(a: readonly Ordered[], b: readonly Ordered[]): boolean {
  return a.length === b.length && a.every((item, index) => item.id === b[index]?.id)
}
