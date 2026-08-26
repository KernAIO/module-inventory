<script lang="ts">
import { Button, Dialog, Field, Input, messageLocale, Select, Textarea, toast } from '@kernhq/ui'
import { createMutation, useQueryClient } from '@tanstack/svelte-query'
import type { Asset } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canInventory } from '../permissions.js'
import { formatPrice, parsePrice } from '../price.js'
import { inventoryKeys } from '../query.js'

/**
 * Add or change an asset.
 *
 * One dialog for both, because they ask for exactly the same nine things and a second component
 * would be nine fields to keep in step. `asset` is what decides which: null creates, a row edits.
 * `assets.update` had no entry point anywhere in the module before this — the procedure existed,
 * was tested, and no screen could reach it.
 *
 * The tag (`INV-…`) is the server's job — people never invent codes, they read them off stickers —
 * so this form asks only for what a human actually knows.
 */
interface Props {
  open: boolean
  workspaceId: string
  /** The row being changed, or null to add one. */
  asset?: Asset | null
}
let { open = $bindable(false), workspaceId, asset = null }: Props = $props()

const api = getInventoryApi()
const queryClient = useQueryClient()

const editing = $derived(asset !== null)

let shown = $state(false)
$effect(() => {
  if (open) shown = true
})

let name = $state('')
let description = $state('')
let serialNumber = $state('')
let location = $state('')
let purchasedOn = $state('')
let purchasedFrom = $state('')
let priceText = $state('')
let currency = $state('')
let warrantyUntil = $state('')

/**
 * What the form was last filled from, so opening it on a different row re-seeds it.
 *
 * A plain variable rather than `$state`: the effect below writes it on every run, and a reactive
 * flag it also reads is a dependency on its own write.
 */
let seededFrom: string | null = null

$effect(() => {
  const key = open ? (asset?.id ?? 'new') : null
  if (key === null) {
    seededFrom = null
    return
  }
  if (seededFrom === key) return
  seededFrom = key
  fill(asset)
})

function fill(row: Asset | null) {
  name = row?.name ?? ''
  description = row?.description ?? ''
  serialNumber = row?.serialNumber ?? ''
  location = row?.location ?? ''
  purchasedOn = row?.purchasedOn ?? ''
  purchasedFrom = row?.purchasedFrom ?? ''
  // Formatted for the reader's own locale, and `parsePrice` reads back exactly what this writes.
  priceText = formatPrice(row?.priceMinor, messageLocale())
  currency = row?.currency ?? ''
  warrantyUntil = row?.warrantyUntil ?? ''
}

const close = () => {
  shown = false
  open = false
}

/**
 * The price, parsed the way the reader's own language writes one.
 *
 * `Number.parseFloat(raw.replace(',', '.'))` replaced the first comma only, so `1.234,56` — German,
 * Turkish and Persian for twelve hundred — was stored as €1.23, and `abc` and `-5` were stored as
 * no price at all. Neither said anything. Now an amount this locale cannot read is an error on the
 * field, and there is no path where a wrong number is saved quietly.
 */
const priceResult = $derived(parsePrice(priceText, messageLocale()))
const priceError = $derived(
  priceResult.ok ? null : t('price_invalid', { example: formatPrice(123456, messageLocale()) }),
)

/**
 * `disabled={save.isPending}` does not stop the second click.
 *
 * The attribute reaches the button on the next render and two quick clicks are one render apart, so
 * a double-click files two assets — two rows, two tags, one of them a duplicate somebody has to go
 * and find. A plain flag set in the same tick as the click is what actually guards it.
 */
let submitting = $state(false)

/** What both procedures take; `update` adds the id and takes it as a patch. */
const fields = () => ({
  name: name.trim(),
  description: description.trim(),
  serialNumber: serialNumber.trim() || null,
  location: location.trim() || null,
  purchasedFrom: purchasedFrom.trim() || null,
  purchasedOn: purchasedOn || null,
  warrantyUntil: warrantyUntil || null,
  priceMinor: priceResult.ok ? priceResult.minor : null,
  currency: currency.trim().toUpperCase() || null,
})

const save = createMutation(() => ({
  mutationFn: () => {
    const row = asset
    return row
      ? api.assets.update({ workspaceId, assetId: row.id, ...fields() })
      : api.assets.create({ workspaceId, ...fields() })
  },
  onSuccess: (saved: Asset) => {
    // Not `t('new')`: that is the label on the button that opened this, so the toast used to
    // congratulate somebody on the words "New asset" rather than telling them what happened.
    toast.success(t(editing ? 'updated_toast' : 'created_toast', { name: saved.name }))
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    close()
  },
  onError: (error: Error) => toast.error(error.message || t('common.error')),
  onSettled: () => {
    submitting = false
  },
}))

/**
 * `submitting` is deliberately **not** in here.
 *
 * It is the guard `submit()` checks, and putting it in the disabled expression as well disables the
 * button under the finger of whoever just pressed it — the browser blurs a focused element the
 * moment it becomes disabled and hands focus nowhere, so a keyboard user loses their place on the
 * page mid-save. `loading={submitting}` says the same thing to a screen reader through `aria-busy`
 * and moves nothing.
 */
const canSubmit = $derived(Boolean(name.trim()) && priceResult.ok && canInventory('manage'))

function submit() {
  if (submitting || !canSubmit) return
  submitting = true
  save.mutate()
}
</script>

<Dialog
  bind:open={shown}
  title={editing ? t('edit') : t('new')}
  onOpenChange={(next) => {
    if (!next) close()
  }}
>
  <div class="form">
    <Field label={t('name')} id="inv-name" required hint={t('name_placeholder')}>
      {#snippet children(id)}
        <Input {id} bind:value={name} />
      {/snippet}
    </Field>
    <Field label={t('description')} id="inv-desc">
      {#snippet children(id)}
        <Textarea {id} bind:value={description} rows={2} />
      {/snippet}
    </Field>

    <div class="pair">
      <Field label={t('serial_number')} id="inv-serial">
        {#snippet children(id)}
          <Input {id} bind:value={serialNumber} />
        {/snippet}
      </Field>
      <Field label={t('location')} id="inv-location">
        {#snippet children(id)}
          <Input {id} bind:value={location} />
        {/snippet}
      </Field>
    </div>

    <div class="pair">
      <Field label={t('purchased_on')} id="inv-purchased-on">
        {#snippet children(id)}
          <Input {id} type="date" bind:value={purchasedOn} />
        {/snippet}
      </Field>
      <Field label={t('warranty_until')} id="inv-warranty">
        {#snippet children(id)}
          <Input {id} type="date" bind:value={warrantyUntil} />
        {/snippet}
      </Field>
    </div>

    <div class="pair">
      <Field label={t('purchased_from')} id="inv-vendor">
        {#snippet children(id)}
          <Input {id} bind:value={purchasedFrom} />
        {/snippet}
      </Field>
      <div class="price">
        <!-- The error goes on the `Input`, not the `Field`: it is the half that also sets
             `aria-invalid` and points `aria-describedby` at the message, and putting it on both
             would print the sentence twice. -->
        <Field label={t('price')} id="inv-price">
          {#snippet children(id)}
            <Input {id} type="text" inputmode="decimal" bind:value={priceText} error={priceError} />
          {/snippet}
        </Field>
        <!-- Was `label="ISO" hint="USD"`: an untranslated abbreviation labelling a control on a
             Persian, Arabic, German or Turkish form, explained by an example that is not a hint. -->
        <Field label={t('currency')} id="inv-currency">
          {#snippet children(id)}
            <Select
              {id}
              bind:value={currency}
              options={[
                { value: '', label: '—' },
                { value: 'USD', label: 'USD' },
                { value: 'EUR', label: 'EUR' },
                { value: 'IRR', label: 'IRR' },
                { value: 'AED', label: 'AED' },
              ]}
            />
          {/snippet}
        </Field>
      </div>
    </div>
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={close}>{t('common.cancel')}</Button>
    <Button onclick={submit} disabled={!canSubmit} loading={submitting}>
      {t('common.save')}
    </Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: grid;
    gap: 14px;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .price {
    display: grid;
    /* 90px fitted "ISO" and nothing else — "Para birimi" and «واحد پول» need room to sit on one
       line, and a wrapped two-word label beside a one-line one knocks the two controls out of
       alignment. */
    grid-template-columns: minmax(0, 1fr) 124px;
    gap: 8px;
    align-items: start;
  }
</style>
