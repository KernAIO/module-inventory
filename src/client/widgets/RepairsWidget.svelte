<script lang="ts">
import { formatDate, type WidgetProps, WidgetState } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import type { RepairListItem } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import { t } from '../i18n.js'
import { assetHref } from '../links.js'
import { inventoryKeys } from '../query.js'

/**
 * What is away being fixed, right now.
 *
 * A second card rather than a `view` setting on the first one, because this one is **behind a
 * capability**: `capability: 'repairs'` in `module.ts` means the shell does not offer it at all to a
 * workspace that does not record repairs, where an option inside a settings dropdown would offer
 * the question and then answer it with an empty card. That is the whole difference between a switch
 * that means something and a switch that does not.
 *
 * It asks `repairs.list` at workspace scope — the one question a per-asset list cannot answer — and
 * the asset's tag and name arrive joined, so nothing here has to look an id up.
 *
 * A row opens the **asset**, not the repair: a repair has no screen of its own, and the panel's
 * Repairs tab is where somebody logs it back in — which is the thing anybody reading "away since
 * 3 March" actually wants to do next. `WidgetProps` is what carries the `workspaceSlug` that link
 * needs; this file declared two props by hand and could therefore not build one.
 */
const { workspaceId, workspaceSlug, settings }: WidgetProps = $props()

const limit = $derived(Number(settings?.limit ?? 5))
const api = getInventoryApi()

const filters = $derived({ open: true, limit })

const repairs = createQuery(() => ({
  queryKey: inventoryKeys.repairs(workspaceId, filters),
  queryFn: () => api.repairs.list({ workspaceId, ...filters }),
  enabled: Boolean(workspaceId),
}))

const items = $derived<readonly RepairListItem[]>(repairs.data?.items ?? [])
</script>

<WidgetState
  pending={repairs.isPending}
  error={repairs.error}
  empty={!items.length}
  emptyTitle={t('widget_repairs_empty')}
  emptyIcon="wrench"
  onRetry={() => repairs.refetch()}
>
  <ul>
    {#each items as repair (repair.id)}
      <li>
        <!-- An anchor, so the keyboard route and the pointer route are one route. -->
        <a class="row" href={assetHref(workspaceSlug, repair.assetId)}
          aria-label={t('open_asset', isolated({ name: repair.assetName }))}>
          <span class="code">{repair.assetCode}</span>
          <span class="name">{repair.assetName}</span>
          <span class="since">
            {t('repair_away_since', isolated({ date: formatDate(repair.sentOn) }))}
          </span>
        </a>
      </li>
    {/each}
  </ul>
</WidgetState>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 13px;
    min-width: 0;
    color: inherit;
    text-decoration: none;
    /* Ten vertical pixels take the row past the 24px WCAG 2.5.8 target height; the inline padding
       is given back by an equal negative margin, so the card's own gutter is unchanged. */
    padding-block: 5px;
    padding-inline: 6px;
    margin-inline: -6px;
    border-radius: var(--kern-r-sm);
  }
  .row:hover {
    background: var(--kern-surface-hover);
  }
  .code {
    font-size: 11px;
    color: var(--kern-ink-500);
    font-variant-numeric: tabular-nums;
    min-width: 64px;
    /* A tag is read character by character off a sticker, so it stays left-to-right inside a
       Persian or Arabic card and the bidi algorithm does not reorder its digits. */
    direction: ltr;
    unicode-bidi: isolate;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--kern-ink-900);
    /* A value somebody typed decides its own direction: `plaintext` takes it from the value's
       first strong character, so a Latin name inside a Persian screen reads left to right and
       keeps its own trailing punctuation instead of donating it to the paragraph. */
    unicode-bidi: plaintext;
  }
  .since {
    flex: none;
    font-size: 11px;
    /* Muted with a colour, never opacity: a faded line is unreadable whatever its token says. */
    color: var(--kern-ink-500);
  }
</style>
