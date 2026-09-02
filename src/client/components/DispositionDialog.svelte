<script lang="ts">
import { Button, Dialog, Field, Textarea, toast } from '@kernhq/ui'
import { createMutation, useQueryClient } from '@tanstack/svelte-query'
import type { Asset } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import type { DispositionAction } from '../disposition.js'
import { errorMessage } from '../errors.js'
import { t } from '../i18n.js'
import { inventoryKeys } from '../query.js'

/**
 * Saying what happened to an item — it is lost, the company is done with it — and taking it back.
 *
 * One dialog for three verbs, for the reason `CustodyDialog` is one for three: they ask for the
 * same one thing, an optional note, and differ in what they state will happen. They are three
 * *procedures* all the same, and deliberately so: "we lost it" and "we are done with it" are
 * different facts with different refusals — an item somebody is holding can be lost but cannot
 * be retired — and the server refuses each with its own sentence.
 *
 * Each body states what the disposition *closes*. A lost or retired item cannot be handed to
 * anybody and cannot be sent for repair, and the buttons for both disappear from the panel the
 * moment this succeeds; a person deserves to read that before pressing the button rather than
 * discover it afterwards. Retiring is the destructive-looking one and wears the danger variant,
 * though nothing is destroyed — it is a statement, and `reinstate` is the way back.
 *
 * Which of the three may be offered at all is `dispositionActions` in `disposition.ts` — a fact
 * with a right answer, so it lives where it can be tested rather than inside a component.
 */
interface Props {
  workspaceId: string
  /** The item in question. Null closes the dialog. */
  asset: Asset | null
  /** Which of the three. Null closes the dialog. */
  action: DispositionAction | null
  onclose: () => void
}
const { workspaceId, asset, action, onclose }: Props = $props()

const api = getInventoryApi()
const queryClient = useQueryClient()

const open = $derived(asset !== null && action !== null)

let note = $state('')

/**
 * Clear the note whenever a different question is being asked.
 *
 * Without this, marking one item lost and then retiring another arrives with the first item's
 * note still in the box — and a note is a sentence somebody wrote about a *different* event.
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
  note = ''
})

const title = $derived(
  action === 'reinstate'
    ? t('reinstate_title', isolated({ name: asset?.name ?? '' }))
    : action === 'retire'
      ? t('retire_title', isolated({ name: asset?.name ?? '' }))
      : t('lost_title', isolated({ name: asset?.name ?? '' })),
)

const body = $derived(
  action === 'reinstate' ? t('reinstate_body') : action === 'retire' ? t('retire_body') : t('lost_body'),
)

const confirmLabel = $derived(
  action === 'reinstate' ? t('reinstate') : action === 'retire' ? t('retire') : t('mark_lost'),
)

/**
 * `disabled={mutation.isPending}` reaches the button one render later, and two quick clicks are one
 * render apart — so a double-click would file the same statement twice and earn
 * `inventory.asset.already_disposed` for the second. A plain flag set in the same tick as the click
 * is the guard; `loading` says "busy" without disabling the control under somebody's finger.
 */
let busy = $state(false)

const dispose = createMutation(() => ({
  mutationFn: () => {
    const row = asset
    if (!row || !action) throw new Error('nothing to say about it')
    const input = { workspaceId, assetId: row.id, note: note.trim() || null }
    if (action === 'reinstate') return api.assets.reinstate(input)
    return action === 'retire' ? api.assets.retire(input) : api.assets.markLost(input)
  },
  onSuccess: () => {
    const name = asset?.name ?? ''
    toast.success(
      action === 'reinstate'
        ? t('reinstated_toast', isolated({ name }))
        : action === 'retire'
          ? t('retired_toast', isolated({ name }))
          : t('lost_toast', isolated({ name })),
    )
    // Blunt on purpose: a disposition moves the row, the list it is in, the panel, its custody and
    // repair tabs, the timeline and the dashboard card, and every one of those hangs off
    // `['inventory', …]`.
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    onclose()
  },
  // Not `error.message`: "Somebody is still holding this item. Take it back before retiring it."
  // is exactly the sentence a reader needs, and the server wrote it in English. `errors.ts` maps
  // the reason token each of these refusals carries onto a translated one.
  onError: (error: unknown) => toast.error(errorMessage(error, t)),
  onSettled: () => {
    busy = false
  },
}))

function submit() {
  if (busy || !open) return
  busy = true
  dispose.mutate()
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
    <p class="body">{body}</p>

    <Field label={t('disposition_note')} id="inv-disposition-note" hint={t('disposition_note_hint')}>
      {#snippet children(id)}
        <Textarea {id} bind:value={note} rows={2} maxlength={500} />
      {/snippet}
    </Field>
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>{t('common.cancel')}</Button>
    <Button variant={action === 'retire' ? 'danger' : 'primary'} onclick={submit} loading={busy}>
      {confirmLabel}
    </Button>
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
