<script lang="ts">
import { Button, Dialog, Field, Select, type SelectOption, Textarea, toast } from '@kernhq/ui'
import { createMutation, useQueryClient } from '@tanstack/svelte-query'
import type { Asset } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import type { CoreMember } from '../core-api.js'
import type { CustodyAction } from '../custody.js'
import { errorMessage } from '../errors.js'
import { t } from '../i18n.js'
import { displayName } from '../members.js'
import { inventoryKeys } from '../query.js'

/**
 * Handing an item over, handing it on, and taking it back.
 *
 * One dialog for three verbs because they ask for the same two things — a person and an optional
 * note — and differ only in which of them is already known. They are three *procedures* all the
 * same, and deliberately so: assigning something somebody already has and handing on something
 * nobody has are different mistakes, and the server refuses each of them with its own sentence.
 *
 * The member list comes from core through the shell's own client. A module cannot import the app,
 * and `core-api.ts` names only the three procedures this module calls — a wider type would be a
 * promise about core's surface that inventory has no standing to make.
 *
 * Which of the three may be offered at all is `custodyActions` in `custody.ts` — a fact with a
 * right answer, so it lives where it can be tested rather than inside a component.
 */
interface Props {
  workspaceId: string
  /** The item being handed over. Null closes the dialog. */
  asset: Asset | null
  /** Which of the three. Null closes the dialog. */
  action: CustodyAction | null
  /** The workspace's members, already fetched by whatever opened this. */
  members: readonly CoreMember[]
  /** Who is holding it now, as words — for the sentence a return has to state. */
  holderName: string | null
  onclose: () => void
}
const { workspaceId, asset, action, members, holderName, onclose }: Props = $props()

const api = getInventoryApi()
const queryClient = useQueryClient()

const open = $derived(asset !== null && action !== null)
const picksPerson = $derived(action === 'assign' || action === 'transfer')

let userId = $state('')
let note = $state('')

/**
 * Clear the form whenever a different question is being asked.
 *
 * Without this, taking an item back and then handing it on again arrives with the previous note
 * still in the box — and a note is a sentence somebody wrote about a *different* handover.
 */
let seededFor: string | null = null
$effect(() => {
  const key = open && asset && action ? `${action}:${asset.id}` : null
  if (key === null) {
    seededFor = null
    return
  }
  if (seededFor === key) return
  seededFor = key
  userId = ''
  note = ''
})

/**
 * Who it can go to.
 *
 * The current holder is left out of a *transfer*: the server refuses handing something to the
 * person who already has it, so offering them is offering a door that will not open. Sorted by the
 * name actually shown, which is the order somebody scanning the list expects — core returns
 * membership order, which is arbitrary to a reader.
 */
const options = $derived.by<SelectOption[]>(() => {
  const holderId = action === 'transfer' ? asset?.custodianUserId : null
  const people = members
    .filter((member) => member.userId !== holderId)
    .map((member) => ({ value: member.userId, label: displayName(member) ?? member.userId }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return [{ value: '', label: t('custody_person_none') }, ...people]
})

const title = $derived(
  action === 'return'
    ? t('custody_return_title', isolated({ name: asset?.name ?? '' }))
    : action === 'transfer'
      ? t('custody_transfer_title', isolated({ name: asset?.name ?? '' }))
      : t('custody_assign_title', isolated({ name: asset?.name ?? '' })),
)

const confirmLabel = $derived(
  action === 'return'
    ? t('custody_return')
    : action === 'transfer'
      ? t('custody_transfer')
      : t('custody_assign'),
)

/**
 * `disabled={mutation.isPending}` reaches the button one render later, and two quick clicks are one
 * render apart — so a double-click files two handovers. A plain flag set in the same tick as the
 * click is the guard; `loading` says "busy" without disabling the control under somebody's finger.
 */
let busy = $state(false)

const hand = createMutation(() => ({
  mutationFn: () => {
    const row = asset
    if (!row || !action) throw new Error('nothing to hand over')
    const base = { workspaceId, assetId: row.id, note: note.trim() || null }
    if (action === 'return') return api.custody.return(base)
    return action === 'transfer'
      ? api.custody.transfer({ ...base, userId })
      : api.custody.assign({ ...base, userId })
  },
  onSuccess: () => {
    const name = asset?.name ?? ''
    const person = options.find((option) => option.value === userId)?.label ?? ''
    toast.success(
      action === 'return'
        ? t('custody_returned_toast', isolated({ name }))
        : action === 'transfer'
          ? t('custody_transferred_toast', isolated({ name, person }))
          : t('custody_assigned_toast', isolated({ name, person })),
    )
    // Blunt on purpose: a handover moves the row, the list it is in, the panel, the timeline and
    // the dashboard card, and every one of those hangs off `['inventory', …]`.
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    onclose()
  },
  // The server's messages *are* the actionable ones — "Somebody changed who is holding this a
  // moment before you did" — and they are English prose, shown as they arrived to a reader who
  // chose Persian. `errors.ts` translates the reason token instead: every refusal a handover can
  // produce carries one, and `inventory.custody.conflict` is the most important sentence this
  // module has.
  onError: (error: unknown) => toast.error(errorMessage(error, t)),
  onSettled: () => {
    busy = false
  },
}))

const canSubmit = $derived(open && (!picksPerson || Boolean(userId)))

function submit() {
  if (busy || !canSubmit) return
  busy = true
  hand.mutate()
}
</script>

<Dialog
  {open}
  size="sm"
  {title}
  onOpenChange={(next) => {
    if (!next) onclose()
  }}
>
  <div class="form">
    {#if action === 'return'}
      <p class="body">
        {t('custody_return_body', isolated({ person: holderName ?? t('member_former') }))}
      </p>
    {:else}
      <Field label={t('custody_person')} id="inv-custody-person" required>
        {#snippet children(id)}
          <Select {id} bind:value={userId} options={options} ariaLabel={t('custody_person')} />
        {/snippet}
      </Field>
    {/if}

    <Field label={t('custody_note')} id="inv-custody-note" hint={t('custody_note_hint')}>
      {#snippet children(id)}
        <Textarea {id} bind:value={note} rows={2} maxlength={500} />
      {/snippet}
    </Field>
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>{t('common.cancel')}</Button>
    <Button onclick={submit} disabled={!canSubmit} loading={busy}>{confirmLabel}</Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: grid;
    gap: 14px;
  }
  .body {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--kern-ink-700);
  }
</style>
