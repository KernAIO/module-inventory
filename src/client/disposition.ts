/**
 * Which of the three disposition verbs an asset can actually take right now.
 *
 * `markLost`, `retire` and `reinstate` are three procedures because they are three facts with
 * three sets of refusals, and the two screens that offer them — the row menu and the detail panel
 * — must agree about which to show. A menu that offered *Reinstate* on an item in service would
 * 409 with `inventory.asset.not_disposed` on every press; one that offered *Retire* beside
 * *Reinstate* would be asking a question the row has already answered.
 *
 * A `.ts` file rather than a `const` inside either component, for the reason `custody.ts` and
 * `repairs.ts` are: this is a fact with a right answer, a `.svelte` file cannot be unit-tested,
 * and the type is shared with the dialog, which cannot import it from a component's instance
 * script.
 */
export type DispositionAction = 'lost' | 'retire' | 'reinstate'

export interface DispositionState {
  /** `assets.disposition` — what somebody said happened to it, or null while it is in service. */
  disposition: 'lost' | 'retired' | null
  /** The workspace has taken it out of the register; the server refuses all three verbs. */
  archived: boolean
  /** This person holds `inventory.asset.manage`. */
  may: boolean
}

/**
 * What to offer, in the order the controls appear.
 *
 * Empty for somebody without the permission — hide what a person may never do — and empty for an
 * archived item: an archived row's menu already says *Restore*, and restoring it is the one step
 * that makes any of these possible again. A live item in service takes `lost` and `retire`; a
 * disposed one takes only `reinstate`, which is the single door out of either.
 *
 * `retire` is offered even while somebody holds the item, although the server will refuse it with
 * `inventory.asset.still_held`. Deliberate, and the opposite of what `custodyActions` does: the
 * refusal is the *instruction* — "take it back before retiring it" — and the person reaching for
 * Retire needs to read it, where a missing menu item teaches nothing. The same reasoning keeps
 * *Archive* in the menu of a held item.
 */
export function dispositionActions(state: DispositionState): DispositionAction[] {
  if (!state.may || state.archived) return []
  return state.disposition ? ['reinstate'] : ['lost', 'retire']
}
