import { describe, expect, it } from 'vitest'
import { deriveStatus, dispositionOf } from './status.js'

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
    expect(deriveStatus({ custodianUserId: null, awayForRepair: false, disposition: null })).toBe('in_stock')
  })

  it('is assigned when somebody has it', () => {
    expect(deriveStatus({ custodianUserId: 'ada', awayForRepair: false, disposition: null })).toBe('assigned')
  })

  it('is under repair whether or not somebody still has it', () => {
    // The whole point of the rule: a repair says *where* the thing is, and custody says *who is
    // answerable for it*. A laptop at the workshop is still Dan's, and the status has to show the
    // thing somebody looking for it needs to know.
    expect(deriveStatus({ custodianUserId: null, awayForRepair: true, disposition: null })).toBe(
      'under_repair',
    )
    expect(deriveStatus({ custodianUserId: 'dan', awayForRepair: true, disposition: null })).toBe(
      'under_repair',
    )
  })

  it('goes back to the custodian rather than to stock when a repair ends', () => {
    // The failure this prevents is silent: completing a repair straight to `in_stock` releases
    // whoever was answerable for the item without anybody deciding to.
    expect(deriveStatus({ custodianUserId: 'dan', awayForRepair: false, disposition: null })).toBe('assigned')
  })

  it('lets what somebody said happened win over everything the module records', () => {
    // A lost laptop is still Dan's — the custody period stays open — and it is still *lost*, which
    // is what somebody looking for it needs to know. The same for one at a repairer that the
    // repairer then loses.
    expect(deriveStatus({ custodianUserId: 'dan', awayForRepair: false, disposition: 'lost' })).toBe('lost')
    expect(deriveStatus({ custodianUserId: 'dan', awayForRepair: true, disposition: 'lost' })).toBe('lost')
    expect(deriveStatus({ custodianUserId: null, awayForRepair: false, disposition: 'retired' })).toBe(
      'retired',
    )
  })

  it('hands the column back to the other facts once the disposition is cleared', () => {
    // Reinstating writes nothing but `disposition = null`, so a laptop found under a desk reads
    // `assigned` again without anybody re-recording the handover.
    expect(deriveStatus({ custodianUserId: 'dan', awayForRepair: false, disposition: null })).toBe('assigned')
  })
})

describe('dispositionOf', () => {
  it('reads the two words the contract knows and nothing else', () => {
    expect(dispositionOf({ disposition: 'lost' })).toBe('lost')
    expect(dispositionOf({ disposition: 'retired' })).toBe('retired')
    expect(dispositionOf({ disposition: null })).toBe(null)
    // A row written by a newer image with a word this one has never heard of reads as in service
    // rather than as a crash — the column is text, and the rows outlive the image that wrote them.
    expect(dispositionOf({ disposition: 'reserved' })).toBe(null)
  })
})
