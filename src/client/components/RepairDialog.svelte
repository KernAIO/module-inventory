<script lang="ts">
import { Button, Dialog, Field, Input, messageLocale, Select, Textarea, toast } from '@kernhq/ui'
import { createMutation, useQueryClient } from '@tanstack/svelte-query'
import type { Asset, Repair } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import { errorMessage } from '../errors.js'
import { t } from '../i18n.js'
import { currencyOptions, formatPrice, parsePrice, priceExample } from '../price.js'
import { inventoryKeys } from '../query.js'
import type { RepairAction } from '../repairs.js'

/**
 * Sending an item for repair, correcting what was recorded, and logging it back.
 *
 * One dialog for three verbs, the way `CustodyDialog` is one for three: they ask for overlapping
 * things and differ in which of them is already known. They are three *procedures* all the same,
 * because the server refuses each of them with its own sentence — sending something that is already
 * away and completing something already completed are different mistakes.
 *
 * The money field is `price.ts`, not a second parser: it is the file that shipped a silent 100×
 * data loss on the asset form, and a repair cost typed as `1.234,56` in German has to survive
 * exactly as a purchase price does.
 *
 * `RepairAction` lives in `repairs.ts` beside the rule that decides which of the three may be
 * offered — a type exported from a component's instance script is a prop, not a type.
 */
interface Props {
  workspaceId: string
  /** The item being repaired — for the title, and for the currency a cost defaults to. */
  asset: Asset | null
  /** The repair being edited or completed. Null when creating one. */
  repair: Repair | null
  /** Which of the three. Null closes the dialog. */
  action: RepairAction | null
  onclose: () => void
}
const { workspaceId, asset, repair, action, onclose }: Props = $props()

const api = getInventoryApi()
const queryClient = useQueryClient()

const open = $derived(asset !== null && action !== null)
const completing = $derived(action === 'complete')

let summary = $state('')
let detail = $state('')
let vendor = $state('')
let sentOn = $state('')
let returnedOn = $state('')
let costText = $state('')
let currency = $state('')

/**
 * Seed the form whenever a different question is being asked.
 *
 * A plain variable rather than `$state`, as `AssetFormDialog` explains: the effect writes it on
 * every run, and a reactive flag it also reads is a dependency on its own write.
 */
let seededFor: string | null = null
$effect(() => {
  const key = open && action ? `${action}:${repair?.id ?? asset?.id ?? ''}` : null
  if (key === null) {
    seededFor = null
    return
  }
  if (seededFor === key) return
  seededFor = key
  fill()
})

/** Today, in the browser's own calendar — a date input takes `YYYY-MM-DD` and nothing else. */
const today = () => new Date().toISOString().slice(0, 10)

function fill() {
  summary = repair?.summary ?? ''
  detail = repair?.detail ?? ''
  vendor = repair?.vendor ?? ''
  sentOn = repair?.sentOn ?? today()
  returnedOn = repair?.returnedOn ?? today()
  // A cost with no currency inherits the asset's, which is what the server does when none arrives —
  // the form shows the same answer rather than leaving somebody to guess what will be stored.
  currency = repair?.currency ?? asset?.currency ?? ''
  // Seeded against that currency: how many decimal places the stored minor units carry is a fact
  // about the money, not a constant, and yen carries none.
  costText = formatPrice(repair?.costMinor, messageLocale(), currency || null)
}

const currencyCode = $derived(currency.trim().toUpperCase() || null)
const costResult = $derived(parsePrice(costText, messageLocale(), currencyCode))
const costError = $derived(
  costResult.ok
    ? null
    : t('price_invalid', isolated({ example: priceExample(messageLocale(), currencyCode) })),
)

const title = $derived(
  completing
    ? t('repair_complete_title', isolated({ name: asset?.name ?? '' }))
    : action === 'edit'
      ? t('repair_edit')
      : t('repair_new'),
)

const confirmLabel = $derived(
  completing ? t('repair_complete') : action === 'edit' ? t('common.save') : t('repair_new'),
)

/**
 * `disabled={mutation.isPending}` reaches the button one render later, and two quick clicks are one
 * render apart — so a double-click files two repairs, and the second one is refused by the unique
 * index with a conflict nobody caused. A plain flag set in the same tick as the click is the guard.
 */
let busy = $state(false)

const money = () => ({
  costMinor: costResult.ok ? costResult.minor : null,
  currency: currencyCode,
})

const save = createMutation(() => ({
  mutationFn: () => {
    if (!action) throw new Error('nothing to do')
    if (action === 'complete') {
      if (!repair) throw new Error('no repair to complete')
      return api.repairs.complete({ workspaceId, repairId: repair.id, returnedOn, ...money() })
    }
    const fields = {
      summary: summary.trim(),
      detail: detail.trim() || null,
      vendor: vendor.trim() || null,
      sentOn,
      ...money(),
    }
    if (action === 'edit') {
      if (!repair) throw new Error('no repair to edit')
      return api.repairs.update({ workspaceId, repairId: repair.id, ...fields })
    }
    if (!asset) throw new Error('no asset to repair')
    return api.repairs.create({ workspaceId, assetId: asset.id, ...fields })
  },
  onSuccess: () => {
    const name = asset?.name ?? ''
    toast.success(
      action === 'complete'
        ? t('repair_completed_toast', isolated({ name }))
        : action === 'edit'
          ? t('repair_saved_toast')
          : t('repair_logged_toast', isolated({ name })),
    )
    // Blunt on purpose: a repair moves the asset's status, the row, the list, the panel, the
    // timeline, the numbers and the dashboard card — and every one of those hangs off
    // `['inventory', …]`.
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    onclose()
  },
  // The server's sentences are the actionable ones — "This item is already away for repair" — and
  // they are English. `errors.ts` translates the reason token each of them carries, so a Persian
  // reader is told which of the four refusals they hit rather than being shown English prose.
  onError: (error: unknown) => toast.error(errorMessage(error, t)),
  onSettled: () => {
    busy = false
  },
}))

const canSubmit = $derived(open && costResult.ok && (completing || Boolean(summary.trim())))

function submit() {
  if (busy || !canSubmit) return
  busy = true
  save.mutate()
}

// The list and the empty option both live in `price.ts`: the asset form asks the same question,
// and two copies are two lists that gain a currency in one form and not the other.
const currencies = currencyOptions('—')
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
    {#if completing}
      <p class="body">{t('repair_complete_body')}</p>
      <Field label={t('repair_returned_on')} id="inv-repair-returned">
        {#snippet children(id)}
          <Input {id} type="date" bind:value={returnedOn} />
        {/snippet}
      </Field>
    {:else}
      <Field
        label={t('repair_summary')}
        id="inv-repair-summary"
        required
        hint={t('repair_summary_placeholder')}
      >
        {#snippet children(id)}
          <Input {id} bind:value={summary} maxlength={200} />
        {/snippet}
      </Field>
      <Field label={t('repair_detail')} id="inv-repair-detail">
        {#snippet children(id)}
          <Textarea {id} bind:value={detail} rows={2} />
        {/snippet}
      </Field>
      <div class="pair">
        <Field label={t('repair_vendor')} id="inv-repair-vendor" hint={t('repair_vendor_placeholder')}>
          {#snippet children(id)}
            <Input {id} bind:value={vendor} maxlength={200} />
          {/snippet}
        </Field>
        <Field label={t('repair_sent_on')} id="inv-repair-sent">
          {#snippet children(id)}
            <Input {id} type="date" bind:value={sentOn} />
          {/snippet}
        </Field>
      </div>
    {/if}

    <div class="cost">
      <!-- The error goes on the `Input`, not the `Field`: that is the half that sets
           `aria-invalid` and points `aria-describedby` at the message. -->
      <Field label={t('repair_cost')} id="inv-repair-cost">
        {#snippet children(id)}
          <Input {id} type="text" inputmode="decimal" bind:value={costText} error={costError} />
        {/snippet}
      </Field>
      <Field label={t('currency')} id="inv-repair-currency">
        {#snippet children(id)}
          <Select {id} bind:value={currency} options={currencies} />
        {/snippet}
      </Field>
    </div>
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
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .cost {
    display: grid;
    /* Room for «واحد پول» and "Para birimi" on one line: a wrapped two-word label beside a
       one-line one knocks the two controls out of alignment. */
    grid-template-columns: minmax(0, 1fr) 124px;
    gap: 8px;
    align-items: start;
  }
</style>
