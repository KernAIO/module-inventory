import { describe, expect, it } from 'vitest'
import {
  consider,
  DRAG_STOPPED,
  finalize,
  move,
  refused,
  reseed,
  type Sequence,
  saved,
  seed,
  start,
} from './sequence.js'

/**
 * The order of events on the categories screen — which is where every defect in it has been.
 *
 * The arithmetic lives in `reorder.ts` and is tested beside it. Nothing here recalculates a list; it
 * asserts *when* a list is adopted, sent, rolled back or spoken, because the four inputs — a drag, a
 * keypress, a server answer and a refetch — arrive in an order nobody controls, and each of the four
 * cases below shipped as a silent wrong answer.
 */
type Row = { id: string; name: string }
const list = (...ids: string[]): Row[] => ids.map((id) => ({ id, name: id.toUpperCase() }))
const ids = (items: readonly Row[]) => items.map((item) => item.id)

/** A pointer drag, start to finish, as the library fires it. */
function pointerDrag(seq: Sequence<Row>, to: readonly Row[], id: string) {
  const considered = consider(seq, to, 'draggedOverIndex')
  return finalize(considered.next, to, id)
}

describe('a keyboard drag ending', () => {
  /**
   * The proved defect: `svelte-dnd-action` ends a keyboard drag with a **`consider`**, not a
   * `finalize`. Enter, Escape, a click elsewhere and the row disappearing all land on the same
   * `handleDrop`, which dispatches `consider` with `dragStopped` and nothing after it.
   *
   * A handler that sets "dragging" on every consider and clears it only on finalize is therefore
   * stuck true from the moment somebody uses the keyboard once — and the seeding effect below is
   * skipped for the rest of the page's life, so the screen silently stops reflecting the database.
   */
  it('leaves nothing in progress, so the list goes on updating', () => {
    let seq = start(list('a', 'b', 'c'))

    // Enter on a row: the library fires `consider` with `dragStarted`.
    seq = consider(seq, list('a', 'b', 'c'), 'dragStarted').next
    expect(seq.dragging, 'a drag really is in progress now').toBe(true)

    // One arrow key: `finalize`, per press.
    const step = finalize(seq, list('b', 'a', 'c'), 'a')
    seq = step.next
    expect(step.save, 'and it is worth sending').toEqual(['b', 'a', 'c'])

    // Enter again, or Escape, or a click elsewhere. This is the last event of the whole gesture.
    seq = consider(seq, list('b', 'a', 'c'), DRAG_STOPPED).next
    expect(seq.dragging, 'the gesture is over').toBe(false)

    // Which is the thing that actually matters: a later refetch is adopted rather than skipped.
    seq = saved(seq, list('b', 'a', 'c')).next
    seq = seed(seq, list('b', 'a', 'c', 'd'))
    expect(ids(seq.rows), 'somebody added a category in another tab and the screen shows it').toEqual([
      'b',
      'a',
      'c',
      'd',
    ])
  })

  /** A drag picked up and put straight down: two considers, no finalize at all, nothing sent. */
  it('sends nothing when it is picked up and put down again', () => {
    let seq = start(list('a', 'b', 'c'))
    seq = consider(seq, list('a', 'b', 'c'), 'dragStarted').next
    const step = consider(seq, list('a', 'b', 'c'), DRAG_STOPPED)
    expect(step.save).toBeNull()
    expect(step.next.dragging).toBe(false)
    expect(ids(step.next.rows)).toEqual(['a', 'b', 'c'])
    expect(
      seed(step.next, list('c', 'b', 'a')).rows.map((r) => r.id),
      'and seeding works',
    ).toEqual(['c', 'b', 'a'])
  })
})

describe('a refusal the reader can act on', () => {
  /**
   * The proved sequence, from the review:
   *
   *     3. refetch lands mid-save   rows = abc   live = abcd   <- skipped
   *     6. after the invalidation   rows = abc   live = abcd   <- never re-runs
   *
   * The rollback restores the list the server has just refused, and the effect that would replace it
   * is keyed on the query's data — which did not change between the skipped refetch and the one after
   * the invalidation, because it was already the fresh value. So every retry sends the same stale list
   * and earns the same refusal, under a message telling the reader to try again.
   */
  it('re-seeds from what the server has, so the next attempt is a different one', () => {
    let seq = start(list('a', 'b', 'c'))

    // Somebody drags b in front of a. The write goes.
    const step = pointerDrag(seq, list('b', 'a', 'c'), 'b')
    seq = step.next
    expect(step.save).toEqual(['b', 'a', 'c'])

    // A refetch lands mid-save carrying a category another tab added. Skipped — correctly, because
    // adopting it would undo the move being written at that moment.
    const live = list('a', 'b', 'c', 'd')
    seq = seed(seq, live)
    expect(ids(seq.rows), 'the optimistic order is still on screen').toEqual(['b', 'a', 'c'])

    // The server refuses: the list did not name `d`. Rolling back alone leaves `abc`.
    expect(ids(refused(seq).rows), 'which is exactly the list that was just refused').toEqual(['a', 'b', 'c'])

    // Re-seeding is what makes the next attempt a different one.
    seq = reseed(live)
    expect(ids(seq.rows), 'the workspace as it actually is').toEqual(['a', 'b', 'c', 'd'])
    expect(seq.saving).toBe(false)
    expect(seq.dragging).toBe(false)
    expect(seq.pending).toBeNull()

    // And the retry now names every live category, which is what the server was asking for.
    const retry = pointerDrag(seq, list('b', 'a', 'c', 'd'), 'b')
    expect(retry.save).toEqual(['b', 'a', 'c', 'd'])
  })

  it('rolls back to the server, not to the screen, and forgets anything queued behind it', () => {
    let seq = start(list('a', 'b', 'c'))
    seq = move(seq, 'c', -1).next // acb, in flight
    seq = move(seq, 'c', -1).next // cab, coalesced behind it
    expect(ids(seq.rows)).toEqual(['c', 'a', 'b'])
    expect(seq.pending).not.toBeNull()

    const back = refused(seq)
    expect(ids(back.rows), 'where the server is believed to be').toEqual(['a', 'b', 'c'])
    expect(back.pending, 'the queued move was built on top of a write that never happened').toBeNull()
    expect(back.saving).toBe(false)
  })
})

describe('pressing an arrow key faster than the server answers', () => {
  /**
   * The proved defect: a second press while a save was in flight was **discarded** — the list snapped
   * back to what was on screen and the row announced the position it had not left. Somebody pressing
   * *move down* three times was told three times that nothing had moved, and two of the three presses
   * vanished.
   *
   * Coalesced rather than queued: three presses are one extra request, not three, and a request per
   * keypress would arrive out of order with each one describing a list the next contradicts.
   */
  it('applies every press and announces where the row really is', () => {
    let seq = start(list('a', 'b', 'c', 'd'))

    const first = move(seq, 'd', -1)
    seq = first.next
    expect(first.save, 'the first press goes at once').toEqual(['a', 'b', 'd', 'c'])
    expect(ids(first.announce!.list), 'and is announced in the list it produced').toEqual([
      'a',
      'b',
      'd',
      'c',
    ])

    const second = move(seq, 'd', -1)
    seq = second.next
    expect(second.save, 'the second waits rather than racing the first').toBeNull()
    expect(ids(seq.rows), 'but the row really moved on screen').toEqual(['a', 'd', 'b', 'c'])
    expect(ids(second.announce!.list), 'so the sentence is true').toEqual(['a', 'd', 'b', 'c'])

    const third = move(seq, 'd', -1)
    seq = third.next
    expect(third.save).toBeNull()
    expect(ids(third.announce!.list)).toEqual(['d', 'a', 'b', 'c'])

    // The first write answers. The three presses add up to one more request, not two.
    const settled = saved(seq, list('a', 'b', 'd', 'c'))
    seq = settled.next
    expect(settled.save, 'everything pressed since, in one list').toEqual(['d', 'a', 'b', 'c'])
    expect(seq.saving, 'still writing, so a fourth press coalesces too').toBe(true)
    expect(ids(seq.rows), 'and the screen is never rewound past what was pressed').toEqual([
      'd',
      'a',
      'b',
      'c',
    ])

    const done = saved(seq, list('d', 'a', 'b', 'c'))
    expect(done.save, 'nothing left over').toBeNull()
    expect(done.next.saving).toBe(false)
    expect(done.next.pending).toBeNull()
  })

  it('sends nothing more when the coalesced moves add up to where the server already is', () => {
    let seq = start(list('a', 'b'))
    seq = move(seq, 'a', 1).next // ba, in flight
    seq = move(seq, 'a', -1).next // back to ab, coalesced
    const settled = saved(seq, list('b', 'a'))
    expect(settled.save, 'ab is not where the server is, so it does go').toEqual(['a', 'b'])

    let other = start(list('a', 'b'))
    other = move(other, 'a', 1).next
    other = move(other, 'a', -1).next
    other = move(other, 'a', 1).next
    const same = saved(other, list('b', 'a'))
    expect(same.save, 'and ba is exactly what was written, so nothing more goes').toBeNull()
    expect(same.next.saving).toBe(false)
  })

  it('says where a row is when it cannot move, rather than saying nothing', () => {
    const seq = start(list('a', 'b', 'c'))
    const step = move(seq, 'a', -1)
    expect(step.save, 'the first row cannot go up, and that is not a write').toBeNull()
    expect(step.announce, 'silence reads as a broken button').not.toBeNull()
    expect(step.announce?.id).toBe('a')
    expect(ids(step.announce!.list)).toEqual(['a', 'b', 'c'])
  })
})

describe('seeding from the query', () => {
  it('adopts what a refetch delivers when nothing is in progress', () => {
    const seq = seed(start(list('a', 'b')), list('a', 'b', 'c'))
    expect(ids(seq.rows)).toEqual(['a', 'b', 'c'])
    expect(ids(seq.settled)).toEqual(['a', 'b', 'c'])
    expect(ids(seq.shown)).toEqual(['a', 'b', 'c'])
  })

  it('leaves the list alone under a drag, so it does not move under the pointer', () => {
    const dragging = consider(start(list('a', 'b', 'c')), list('b', 'a', 'c'), 'draggedOverIndex').next
    expect(ids(seed(dragging, list('a', 'b', 'c', 'd')).rows)).toEqual(['b', 'a', 'c'])
  })

  it('leaves it alone under a save, so the screen never disagrees with the write in flight', () => {
    const saving = move(start(list('a', 'b', 'c')), 'c', -1).next
    expect(ids(seed(saving, list('a', 'b', 'c')).rows)).toEqual(['a', 'c', 'b'])
  })
})

describe('a drag that ends where it started', () => {
  it('costs no request, because the library fires finalize either way', () => {
    const seq = start(list('a', 'b', 'c'))
    const step = pointerDrag(seq, list('a', 'b', 'c'), 'b')
    expect(
      step.save,
      'every open screen in the workspace would hear about a write that did nothing',
    ).toBeNull()
    expect(step.next.dragging).toBe(false)
    expect(step.announce?.id, 'and the row still says where it is').toBe('b')
  })
})
