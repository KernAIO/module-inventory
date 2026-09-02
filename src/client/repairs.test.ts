import { describe, expect, it } from 'vitest'
import { repairActions } from './repairs.js'

/**
 * What the Repairs section is allowed to offer.
 *
 * A decision rather than rendering, and wrong in a way nothing else would catch: a *Send for repair*
 * button on an item that is already at a repairer produces a 409 every single time it is pressed —
 * the unique index refuses the second open repair — so the interface must not offer it at all.
 */
describe('repairActions', () => {
  const live = { archived: false, disposed: false, may: true }

  it('offers sending it away when nothing is open', () => {
    expect(repairActions({ ...live, open: false })).toEqual(['create'])
  })

  it('offers completing and correcting while one is open, and never a second send', () => {
    const actions = repairActions({ ...live, open: true })
    expect(actions).toEqual(['complete', 'edit'])
    // The one combination that would conflict on every press.
    expect(actions).not.toContain('create')
  })

  it('offers nothing without the permission — hidden, not disabled', () => {
    expect(repairActions({ ...live, open: false, may: false })).toEqual([])
    expect(repairActions({ ...live, open: true, may: false })).toEqual([])
  })

  it('offers nothing new on an archived item, which the server refuses anyway', () => {
    expect(repairActions({ ...live, open: false, archived: true })).toEqual([])
  })

  it('keeps the way out of an open repair reachable even on an archived item', () => {
    // Archiving is refused while a repair is open, so this state should be unreachable — and if
    // the data ever says otherwise, hiding *complete* would leave the item stuck at `under_repair`
    // for ever with no control that could finish it.
    expect(repairActions({ ...live, open: true, archived: true })).toEqual(['complete', 'edit'])
  })

  /**
   * A lost or retired item cannot be *sent* anywhere — the server refuses with
   * `inventory.repair.disposed` — but one that was already at the repairer when it was lost still
   * has an open repair, and logging it back has to stay possible.
   */
  it('offers nothing new on a lost or retired item, and keeps an open repair finishable', () => {
    expect(repairActions({ ...live, open: false, disposed: true })).toEqual([])
    expect(repairActions({ ...live, open: true, disposed: true })).toEqual(['complete', 'edit'])
  })
})
