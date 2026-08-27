import { describe, expect, it } from 'vitest'
import { deriveStatus } from './status.js'

/**
 * The one rule that two services would otherwise each write their own version of.
 *
 * `CustodyService.stamp` wrote `userId ? 'assigned' : 'in_stock'` unconditionally before repairs
 * existed, which is correct right up to the moment an item can be somewhere. This is the arithmetic
 * of `status`, tested where it is cheap; `inventory.int.test.ts` proves the same combinations end to
 * end through the procedures that write them.
 */
describe('deriveStatus', () => {
  it('is in stock when nobody has it and nothing is being fixed', () => {
    expect(deriveStatus({ custodianUserId: null, awayForRepair: false })).toBe('in_stock')
  })

  it('is assigned when somebody has it', () => {
    expect(deriveStatus({ custodianUserId: 'ada', awayForRepair: false })).toBe('assigned')
  })

  it('is under repair whether or not somebody still has it', () => {
    // The whole point of the rule: a repair says *where* the thing is, and custody says *who is
    // answerable for it*. A laptop at the workshop is still Dan's, and the status has to show the
    // thing somebody looking for it needs to know.
    expect(deriveStatus({ custodianUserId: null, awayForRepair: true })).toBe('under_repair')
    expect(deriveStatus({ custodianUserId: 'dan', awayForRepair: true })).toBe('under_repair')
  })

  it('goes back to the custodian rather than to stock when a repair ends', () => {
    // The failure this prevents is silent: completing a repair straight to `in_stock` releases
    // whoever was answerable for the item without anybody deciding to.
    expect(deriveStatus({ custodianUserId: 'dan', awayForRepair: false })).toBe('assigned')
  })
})
