/**
 * The categories screen's drag, its two arrow buttons and the one save behind both — as a value.
 *
 * In its own file for the reason `reorder.ts`, `custody.ts` and `price.ts` are: a `.svelte` file
 * cannot be unit-tested here, so anything living inside one is only ever checked by reading it. This
 * is not arithmetic, though. It is a small state machine with four inputs that arrive in an order
 * nobody controls — a drag, a keypress, a server answer and a refetch — and every defect it has had
 * was an *ordering*, not a calculation. Those are three assertions each rather than three careful
 * reads.
 *
 * Three snapshots, and they are only equal when nothing is in flight:
 *
 *   - `rows` is what the list renders.
 *   - `shown` is what the screen was showing before the gesture in progress, which while a save is
 *     in flight is the optimistic order and **not** what the server holds. A blocked move rolls back
 *     to this, so the move being written at that moment survives.
 *   - `settled` is what the **server** is believed to hold, and it is what a refusal rolls back to.
 *
 * Every transition is pure and returns the work the caller owes: a list to post, a row to speak
 * about, or neither. The screen does the posting and the speaking; nothing here knows what a request
 * or a live region is.
 */

import { moveBy, type Ordered, sameOrder } from './reorder.js'

/**
 * The trigger `svelte-dnd-action` puts on the `consider` it fires when a **keyboard** drag ends.
 *
 * The library's two routes do not have the same shape, and reading only the pointer one is what left
 * this screen permanently stale. A pointer drag is `consider`…`consider`…`finalize`. A keyboard drag
 * is `consider` (`dragStarted`), then one `finalize` per arrow key, and then — on Enter, on Escape,
 * on a click elsewhere, on the row being removed — a **`consider`** carrying this trigger. So the
 * last event of a keyboard drag is a consider, and a handler that sets "dragging" on every consider
 * and clears it only on finalize is stuck true from that moment on. Whatever the flag then guards is
 * guarded for ever: here it was the seeding effect, so the screen quietly stopped showing what the
 * database held, with no error anywhere.
 */
export const DRAG_STOPPED = 'dragStopped'

export interface Sequence<T extends Ordered> {
  /** What the list renders. */
  rows: readonly T[]
  /** What the server is believed to hold — where a refusal rolls back to. */
  settled: readonly T[]
  /** What the screen showed before the gesture in progress. */
  shown: readonly T[]
  /** A drag is in progress, so a refetch must not pull the list out from under the pointer. */
  dragging: boolean
  /** A save is in flight. Set in the same tick as the gesture; a disabled button is a render late. */
  saving: boolean
  /** Moves made while that save was in flight, coalesced into the one list they add up to. */
  pending: readonly T[] | null
}

/** A transition, and the work it leaves the screen to do. */
export interface Step<T extends Ordered> {
  next: Sequence<T>
  /** The ids to post, in order. Null when nothing needs writing. */
  save: readonly string[] | null
  /** The row to speak about and the list that now holds it. Null when there is nothing to say. */
  announce: { id: string; list: readonly T[] } | null
}

export function start<T extends Ordered>(rows: readonly T[] = []): Sequence<T> {
  return { rows, settled: rows, shown: rows, dragging: false, saving: false, pending: null }
}

/**
 * Adopt what a query just delivered — unless a gesture or a write is in the middle of something.
 *
 * Seeding under a drag pulls the list out from under the pointer, and seeding under a save replaces
 * the optimistic order with data the write has not reached yet, so the screen disagrees with the
 * change it is at that moment making.
 *
 * **A skipped seed is dropped, not queued, and that is only safe because of `reseed`.** A refetch
 * landing mid-save is skipped here; on success the server's own answer is fresher than anything the
 * query could hold, and on a refusal `reseed` takes what the server actually has. Without that second
 * half this is the whole defect: skip one refetch, refuse the save, and the screen is left holding a
 * list the server has already rejected once, with no route back to a fresh one.
 */
export function seed<T extends Ordered>(seq: Sequence<T>, live: readonly T[]): Sequence<T> {
  if (seq.dragging || seq.saving) return seq
  return { ...seq, rows: live, settled: live, shown: live }
}

/**
 * Take what the server actually has, whatever this screen was in the middle of.
 *
 * What makes an `order_stale` refusal recoverable. The rollback alone is not enough and reads as
 * though it were: it restores the same list the server has just refused, so every retry sends it
 * again and is refused again, under a message telling the reader to try once more. The seeding effect
 * cannot rescue it either — it is keyed on the query's data, and the refetch that follows the refusal
 * returns the value it already skipped, which is not a change and so does not re-run anything.
 *
 * The same thing `start` does, and named separately because the call site is where it has to be
 * obvious that the previous state is being thrown away on purpose rather than merged into.
 */
export function reseed<T extends Ordered>(live: readonly T[]): Sequence<T> {
  return start(live)
}

/**
 * The drag library considering a position — or, on `dragStopped`, telling us the keyboard drag ended.
 *
 * The trigger is the whole point. See `DRAG_STOPPED`.
 */
export function consider<T extends Ordered>(seq: Sequence<T>, items: readonly T[], trigger: string): Step<T> {
  if (trigger === DRAG_STOPPED)
    return { next: { ...seq, dragging: false, rows: seq.shown }, save: null, announce: null }
  return { next: { ...seq, dragging: true, rows: items }, save: null, announce: null }
}

/** A drop, from either route: the arrangement is final, so decide whether it is worth sending. */
export function finalize<T extends Ordered>(seq: Sequence<T>, items: readonly T[], id: string): Step<T> {
  return apply({ ...seq, dragging: false }, items, id)
}

/** *Move up* or *move down* on one row, which must produce exactly what the same drag would. */
export function move<T extends Ordered>(seq: Sequence<T>, id: string, delta: number): Step<T> {
  return apply(seq, moveBy(seq.rows, id, delta), id)
}

/**
 * Take an arrangement, decide whether it is worth sending, and say where the row ended up.
 *
 * One function for both routes, because a drag and a keypress that produce the same list must produce
 * the same request, the same optimistic update and the same sentence. Three outcomes:
 *
 *   - **nothing actually moved**: a drag that ended where it started fires `finalize` exactly as a
 *     real one does, and *move up* on the first row is a button somebody will press. Neither is a
 *     write. Both still get an answer, because silence reads as a broken button.
 *   - **a save already in flight**: the move is applied on screen and **coalesced** into `pending`,
 *     which is posted the moment the current write answers. It used to be discarded — the list
 *     snapped back to `shown` and the row announced the position it had not left, so somebody
 *     pressing *move down* three times was told three times that nothing had moved, while the second
 *     and third presses vanished. A write per keypress is the other wrong answer: they arrive out of
 *     order and each one describes a list the next one contradicts.
 *   - **a real move with nothing in flight**: optimistic, announced at once, posted, and rolled back
 *     by `refused` if the server says no.
 *
 * Every one of the three announces, and every announcement is now true — which is the point of
 * coalescing rather than dropping.
 */
function apply<T extends Ordered>(seq: Sequence<T>, next: readonly T[], id: string): Step<T> {
  if (sameOrder(next, seq.shown))
    return { next: { ...seq, rows: seq.shown }, save: null, announce: { id, list: seq.shown } }

  const rows = [...next]
  const moved = { ...seq, rows, shown: rows }
  if (seq.saving) return { next: { ...moved, pending: rows }, save: null, announce: { id, list: rows } }
  return { next: { ...moved, saving: true }, save: rows.map((row) => row.id), announce: { id, list: rows } }
}

/**
 * The server wrote it, and answered the sequence it wrote.
 *
 * Nothing to guess and no flash: the optimistic list is replaced by the same list. When moves were
 * coalesced while this one was in flight, they go now — and `rows` is deliberately *not* rewound to
 * the server's answer first, because that answer is one move behind what the person is looking at.
 * `saving` stays set across that hand-off, so a third move still coalesces rather than racing.
 */
export function saved<T extends Ordered>(seq: Sequence<T>, server: readonly T[]): Step<T> {
  const queued = seq.pending
  if (queued && !sameOrder(queued, server))
    return {
      next: { ...seq, settled: server, pending: null },
      save: queued.map((row) => row.id),
      announce: null,
    }
  return {
    next: { rows: server, settled: server, shown: server, dragging: false, saving: false, pending: null },
    save: null,
    announce: null,
  }
}

/**
 * The server refused it. Put the list back where the server is believed to be, and drop the queue.
 *
 * Anything coalesced behind the refused write was built on top of it, so it describes an arrangement
 * that never existed. Sending it next would be refused for the same reason, or — worse — accepted.
 */
export function refused<T extends Ordered>(seq: Sequence<T>): Sequence<T> {
  return { ...seq, rows: seq.settled, shown: seq.settled, dragging: false, saving: false, pending: null }
}
