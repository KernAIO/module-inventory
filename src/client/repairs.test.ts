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
  it('offers sending it away when nothing is open', () => {
    expect(repairActions({ open: false, archived: false, may: true })).toEqual(['create'])
  })

  it('offers completing and correcting while one is open, and never a second send', () => {
    const actions = repairActions({ open: true, archived: false, may: true })
    expect(actions).toEqual(['complete', 'edit'])
    // The one combination that would conflict on every press.
    expect(actions).not.toContain('create')
  })

  it('offers nothing without the permission — hidden, not disabled', () => {
    expect(repairActions({ open: false, archived: false, may: false })).toEqual([])
    expect(repairActions({ open: true, archived: false, may: false })).toEqual([])
  })

  it('offers nothing new on an archived item, which the server refuses anyway', () => {
    expect(repairActions({ open: false, archived: true, may: true })).toEqual([])
  })

  it('keeps the way out of an open repair reachable even on an archived item', () => {
    // Archiving is refused while a repair is open, so this state should be unreachable — and if
    // the data ever says otherwise, hiding *complete* would leave the item stuck at `under_repair`
    // for ever with no control that could finish it.
    expect(repairActions({ open: true, archived: true, may: true })).toEqual(['complete', 'edit'])
  })
})
