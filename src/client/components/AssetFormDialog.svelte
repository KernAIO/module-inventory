<script lang="ts">
import { Button, Dialog, Field, Input, Select, Textarea, toast } from '@kernhq/ui'
import { createMutation, useQueryClient } from '@tanstack/svelte-query'
import { getInventoryApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canInventory } from '../permissions.js'

/**
 * Add an asset. The tag (`INV-…`) is the server's job — people never invent codes, they read them
 * off stickers — so this form asks only for what a human actually knows on day one.
 */
interface Props {
  open: boolean
  workspaceId: string
}
let { open = $bindable(false), workspaceId }: Props = $props()

const api = getInventoryApi()
const queryClient = useQueryClient()

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
let priceMinor = $state('')
let currency = $state('')
let warrantyUntil = $state('')

const close = () => {
  shown = false
  open = false
}

const reset = () => {
  name = ''
  description = ''
  serialNumber = ''
  location = ''
  purchasedOn = ''
  purchasedFrom = ''
  priceMinor = ''
  currency = ''
  warrantyUntil = ''
}

/** Minor units are the wire format; the form takes what somebody reads off the receipt. */
function toPrice(raw: string): number | null {
  if (!raw.trim()) return null
  const parsed = Number.parseFloat(raw.replace(',', '.'))
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null
}

const create = createMutation(() => ({
  mutationFn: () =>
    api.assets.create({
      workspaceId,
      name: name.trim(),
      description: description.trim(),
      serialNumber: serialNumber.trim() || null,
      location: location.trim() || null,
      purchasedFrom: purchasedFrom.trim() || null,
      purchasedOn: purchasedOn || null,
      warrantyUntil: warrantyUntil || null,
      priceMinor: toPrice(priceMinor),
      currency: currency.trim().toUpperCase() || null,
    }),
  onSuccess: () => {
    toast.success(t('new'))
    void queryClient.invalidateQueries({ queryKey: ['inventory', 'assets'] })
    reset()
    close()
  },
  onError: (error: Error) => toast.error(error.message),
}))

const canSubmit = $derived(Boolean(name.trim()) && canInventory('manage') && !create.isPending)
</script>

<Dialog
  bind:open={shown}
  title={t('new')}
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
        <Field label={t('price')} id="inv-price">
          {#snippet children(id)}
            <Input {id} type="text" inputmode="decimal" bind:value={priceMinor} />
          {/snippet}
        </Field>
        <Field label="ISO" id="inv-currency" hint="USD">
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
    <Button onclick={() => create.mutate()} disabled={!canSubmit} loading={create.isPending}>
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
    grid-template-columns: 1fr 90px;
    gap: 8px;
  }
</style>
