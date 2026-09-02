<script lang="ts">
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  messageLocale,
  Select,
  type SelectOption,
  Switch,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { Asset, Category, CustomValues, FieldDef } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import { errorMessage } from '../errors.js'
import { t } from '../i18n.js'
import { canInventory } from '../permissions.js'
import { currencyOptions, formatPrice, parsePrice, priceExample } from '../price.js'
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
let categoryId = $state('')
let serialNumber = $state('')
let location = $state('')
let purchasedOn = $state('')
let purchasedFrom = $state('')
let priceText = $state('')
let currency = $state('')
let warrantyUntil = $state('')
/**
 * The workspace's own fields, keyed by field key, exactly as `assets.custom` holds them — a string
 * for text, date, url and one choice, a number for a number, a boolean for a checkbox, an array for
 * several choices. A number being typed is a string until it is sent; `customPatch` converts it.
 */
let custom = $state<Record<string, unknown>>({})

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

/**
 * What this asset can be filed under.
 *
 * Archived categories are asked for as well, so a row that already carries one keeps naming it —
 * the picker offers only live categories plus whichever this asset is already in. Without the
 * second half, opening the form on an asset in an archived category would silently show "no
 * category" and saving would move it out of one nobody meant to leave.
 *
 * `enabled` on `open` rather than always: this dialog is mounted by the list page for its whole
 * life, and a picker nobody has opened does not need a request. The key is the page's own, so when
 * it does fire the answer is usually already in the cache.
 */
const categoriesQuery = createQuery(() => ({
  queryKey: inventoryKeys.categories(workspaceId, true),
  queryFn: () => api.categories.list({ workspaceId, archived: true }),
  enabled: Boolean(workspaceId) && shown,
}))

const categoryOptions = $derived<SelectOption[]>([
  { value: '', label: t('category_none') },
  ...(categoriesQuery.data ?? [])
    .filter((row: Category) => !row.archivedAt || row.id === categoryId)
    .map((row: Category) => ({ value: row.id, label: row.name })),
])

function fill(row: Asset | null) {
  name = row?.name ?? ''
  description = row?.description ?? ''
  categoryId = row?.categoryId ?? ''
  serialNumber = row?.serialNumber ?? ''
  location = row?.location ?? ''
  purchasedOn = row?.purchasedOn ?? ''
  purchasedFrom = row?.purchasedFrom ?? ''
  currency = row?.currency ?? ''
  // Formatted for the reader's own locale *and this row's currency* — `parsePrice` reads back
  // exactly what this writes only if both halves agree on how many decimal places the money has.
  priceText = formatPrice(row?.priceMinor, messageLocale(), currency || null)
  warrantyUntil = row?.warrantyUntil ?? ''
  custom = { ...(row?.custom ?? {}) }
}

/**
 * The workspace's own fields, live ones only: an archived field is asked on no form.
 *
 * `enabled` on `shown` for the reason the categories query is — this dialog is mounted for the
 * page's whole life — and the answer is usually already cached by the detail panel.
 */
const fieldsQuery = createQuery(() => ({
  queryKey: inventoryKeys.fields(workspaceId),
  queryFn: () => api.fields.list({ workspaceId }),
  enabled: Boolean(workspaceId) && shown,
}))

/**
 * The fields this asset is asked about: the workspace-wide ones, plus those scoped to the category
 * **currently chosen in the picker** — so re-filing a laptop as furniture takes the MAC address
 * question off the form before anybody saves. A value typed under a field that then stops applying
 * is not sent, and not lost either: `custom` keeps it, and choosing the category back brings it
 * back with its value.
 */
const applicable = $derived<FieldDef[]>(
  (fieldsQuery.data ?? []).filter(
    (field: FieldDef) => field.categoryId === null || field.categoryId === categoryId,
  ),
)

/** One value as its control holds it: a string for anything typed, a list for several choices. */
const textOf = (key: string): string => {
  const value = custom[key]
  return value === null || value === undefined ? '' : String(value)
}
const listOf = (key: string): string[] => {
  const value = custom[key]
  return Array.isArray(value) ? value.map(String) : []
}

function setCustom(key: string, value: unknown) {
  custom[key] = value
}

/** Kept in the order the choices are offered, so the stored list reads the way the form does. */
function toggleChoice(field: FieldDef, option: string, on: boolean) {
  const chosen = new Set(listOf(field.key))
  if (on) chosen.add(option)
  else chosen.delete(option)
  custom[field.key] = field.options.filter((item) => chosen.has(item))
}

/**
 * The choices, plus the value already stored when it is no longer one of them — a choice somebody
 * renamed keeps the old word on every asset that chose it, and the picker has to be able to show
 * that word rather than silently showing nothing. The empty row is offered unless the field is
 * required; a required select with nothing chosen shows the placeholder instead.
 */
function choiceOptions(field: FieldDef): SelectOption[] {
  const current = textOf(field.key)
  const rows = [...field.options, ...(current && !field.options.includes(current) ? [current] : [])]
  return [
    ...(field.required ? [] : [{ value: '', label: '—' }]),
    ...rows.map((option) => ({ value: option, label: option })),
  ]
}

/**
 * What "nothing here" looks like from each control. A checkbox is never empty — off is an answer —
 * and it is sent as `false` when required, which is what makes a required checkbox saveable.
 */
const isEmpty = (field: FieldDef): boolean => {
  if (field.type === 'checkbox') return false
  const value = custom[field.key]
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'string' && value.trim() === ''
}

/**
 * Required fields still without a value. The server refuses the save too; a form should say so
 * before the button is pressed rather than after, and keep the button from being pressed.
 */
const missing = $derived(applicable.filter((field) => field.required && isEmpty(field)))
const missingNames = $derived(
  new Intl.ListFormat(messageLocale(), { style: 'long', type: 'conjunction' }).format(
    missing.map((field) => field.name),
  ),
)

/**
 * The values to send: only the keys of the fields on this form, `null` for one that was emptied.
 *
 * **A patch merges**, so a field that is not on the form — scoped to another category, or archived
 * — is never mentioned and never touched. `null` is sent only where the asset actually had a value:
 * clearing a field that was already empty is not a change, and mentioning it would write a diff
 * line for something that did not happen.
 */
function customPatch(): CustomValues {
  const patch: Record<string, unknown> = {}
  const before = asset?.custom ?? {}
  for (const field of applicable) {
    const raw = custom[field.key]
    let value: unknown
    switch (field.type) {
      case 'number': {
        const text = textOf(field.key).trim()
        const parsed = Number(text)
        value = text === '' || !Number.isFinite(parsed) ? null : parsed
        break
      }
      case 'checkbox':
        value = raw === undefined ? (field.required ? false : undefined) : raw === true
        break
      case 'multiselect':
        value = listOf(field.key).length ? listOf(field.key) : null
        break
      default:
        value = textOf(field.key).trim() || null
    }
    if (value === undefined) continue
    if (value === null && before[field.key] === undefined) continue
    patch[field.key] = value
  }
  return patch
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
 *
 * The **currency** is a dependency of the parse, not decoration beside it: yen has no minor unit
 * and the dinar has three, so the same keystrokes mean different money in different currencies.
 * Switching the picker re-parses what is already typed, which is what makes `1000` in a yen field
 * ¥1000 rather than ¥10 — and `19.99` there an error rather than a silent ¥20.
 */
const currencyCode = $derived(currency.trim().toUpperCase() || null)
const priceResult = $derived(parsePrice(priceText, messageLocale(), currencyCode))
const priceError = $derived(
  priceResult.ok
    ? null
    : t('price_invalid', isolated({ example: priceExample(messageLocale(), currencyCode) })),
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
  // `null`, never `''`: the contract takes a uuid or nothing, and an empty string is neither.
  categoryId: categoryId || null,
  serialNumber: serialNumber.trim() || null,
  location: location.trim() || null,
  purchasedFrom: purchasedFrom.trim() || null,
  purchasedOn: purchasedOn || null,
  warrantyUntil: warrantyUntil || null,
  priceMinor: priceResult.ok ? priceResult.minor : null,
  currency: currencyCode,
  custom: customPatch(),
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
    toast.success(t(editing ? 'updated_toast' : 'created_toast', isolated({ name: saved.name })))
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    close()
  },
  // Translated rather than the server's English prose: see `errors.ts`.
  onError: (error: unknown) => toast.error(errorMessage(error, t)),
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
const canSubmit = $derived(
  Boolean(name.trim()) && priceResult.ok && missing.length === 0 && canInventory('manage'),
)

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

    <Field label={t('category')} id="inv-category">
      {#snippet children(id)}
        <Select {id} bind:value={categoryId} options={categoryOptions} ariaLabel={t('category')} />
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
            <!-- The list lives in `price.ts`: the repair form asks the same question, and two
                 copies are two lists that gain a currency in one form and not the other. -->
            <Select {id} bind:value={currency} options={currencyOptions('—')} />
          {/snippet}
        </Field>
      </div>
    </div>

    <!--
      The workspace's own fields, under the built-in ones and only when at least one applies — a
      workspace that defines none, or none for this category, sees no heading over nothing.
      One control per type; the value is read from `custom` and written back by the handler rather
      than bound, because the keys are only known at render time.
    -->
    {#if applicable.length}
      <h3 class="group-title">{t('custom_fields')}</h3>
      {#each applicable as field (field.id)}
        {#if field.type === 'multiselect'}
          <fieldset class="choices">
            <legend class="legend">
              {field.name}{#if field.required}<span class="req" aria-hidden="true">*</span>{/if}
            </legend>
            {#if field.description}<p class="msg">{field.description}</p>{/if}
            <div class="choice-list">
              {#each field.options as option (option)}
                <Checkbox
                  label={option}
                  checked={listOf(field.key).includes(option)}
                  onCheckedChange={(on) => toggleChoice(field, option, on)}
                />
              {/each}
            </div>
          </fieldset>
        {:else if field.type === 'checkbox'}
          <Switch
            label={field.name}
            description={field.description ?? undefined}
            checked={custom[field.key] === true}
            onCheckedChange={(on) => setCustom(field.key, on)}
          />
        {:else}
          <Field
            label={field.name}
            id={`inv-custom-${field.key}`}
            required={field.required}
            hint={field.description ?? undefined}
          >
            {#snippet children(id)}
              {#if field.type === 'select'}
                <Select
                  {id}
                  value={textOf(field.key)}
                  options={choiceOptions(field)}
                  placeholder="—"
                  ariaLabel={field.name}
                  onValueChange={(next) => setCustom(field.key, next)}
                />
              {:else if field.type === 'number'}
                <Input
                  {id}
                  type="number"
                  inputmode="decimal"
                  step="any"
                  value={textOf(field.key)}
                  oninput={(event) => setCustom(field.key, event.currentTarget.value)}
                />
              {:else if field.type === 'date'}
                <Input
                  {id}
                  type="date"
                  value={textOf(field.key)}
                  oninput={(event) => setCustom(field.key, event.currentTarget.value)}
                />
              {:else if field.type === 'url'}
                <!-- A link is read left to right whatever the interface language, like a tag. -->
                <Input
                  {id}
                  type="url"
                  inputmode="url"
                  dir="ltr"
                  autocapitalize="off"
                  spellcheck={false}
                  value={textOf(field.key)}
                  oninput={(event) => setCustom(field.key, event.currentTarget.value)}
                />
              {:else}
                <Input
                  {id}
                  maxlength={4000}
                  value={textOf(field.key)}
                  oninput={(event) => setCustom(field.key, event.currentTarget.value)}
                />
              {/if}
            {/snippet}
          </Field>
        {/if}
      {/each}
      {#if missing.length}
        <p class="missing" aria-live="polite">
          {t('custom_missing_required', isolated({ field: missingNames }))}
        </p>
      {/if}
    {/if}
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
  .group-title {
    margin: 6px 0 -4px;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--kern-ink-500);
  }
  /* Drawn like `Field` and `Label`, which wrap one control and cannot wrap a group of boxes. */
  .choices {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  .legend {
    padding: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--kern-ink-650);
    unicode-bidi: plaintext;
  }
  .req {
    color: var(--kern-danger);
    margin-inline-start: 3px;
  }
  .msg {
    margin: 0;
    font-size: 12px;
    color: var(--kern-ink-350);
  }
  .choice-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .missing {
    margin: -4px 0 0;
    font-size: 12.5px;
    line-height: 1.5;
    /* A colour, not opacity — and not the danger red: nothing is wrong yet, something is missing. */
    color: var(--kern-ink-600);
  }
</style>
