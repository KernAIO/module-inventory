<script lang="ts">
import { Badge, messageLocale, type WidgetProps, WidgetState } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import { t } from '../i18n.js'
import { assetHref } from '../links.js'
import { inventoryKeys } from '../query.js'
import { statusTone } from '../status.js'

/**
 * A dashboard card.
 *
 * `WidgetState` draws loading, failed and empty so every card on the board reports those three the
 * same way — and so a module does not have to translate "Retry" to show a widget that failed.
 *
 * `WidgetProps` rather than a hand-written pair, and that is what makes the rows work: the shell
 * passes `workspaceSlug`, which is the half a link to another screen cannot be built without.
 * Declaring two of the eight props by hand is how a card ends up unable to act on anything.
 *
 * `kern-widget` §3 also says to hide row actions while `editing`, and there is nothing to hide
 * here: the action *is* the row, and `WidgetFrame` drags from its grip button rather than from the
 * card's body — so an anchor in the body is never what somebody is holding.
 */
const { workspaceId, workspaceSlug, settings }: WidgetProps = $props()

const limit = $derived(Number(settings?.limit ?? 5))
const api = getInventoryApi()

/**
 * The card asks for exactly what it shows.
 *
 * It used to fetch the default page and then drop archived rows and slice — so a workspace whose
 * last twenty assets were all archived rendered an empty card that was not empty. The server knows
 * how to exclude them and how many to send.
 */
const filters = $derived({ archived: false, limit })

const assets = createQuery(() => ({
  queryKey: inventoryKeys.assets(workspaceId, filters),
  queryFn: () => api.assets.list({ workspaceId, ...filters }),
  enabled: Boolean(workspaceId),
}))

const items = $derived(assets.data?.items ?? [])

/**
 * The three numbers that make this card worth a place on a dashboard.
 *
 * A list of five recent rows says what somebody added last week, which is rarely the question. How
 * many things there are, how many are sitting unclaimed, and how many are away being fixed is the
 * question — and one request answers all three, so the strip costs a query rather than a screen.
 *
 * It fails **soft**: the card is a list of recent assets first, and a numbers strip that could not
 * be loaded simply is not drawn. A dashboard where one card reports an error because a secondary
 * query failed is a worse dashboard than one where a strip is missing.
 */
const stats = createQuery(() => ({
  queryKey: inventoryKeys.stats(workspaceId),
  queryFn: () => api.stats.summary({ workspaceId }),
  enabled: Boolean(workspaceId),
}))

/**
 * `outForRepair` is null for a workspace that does not track repairs — not zero, which would be a
 * claim it has not made. A null tile is simply absent.
 */
const tiles = $derived(
  stats.data
    ? [
        { label: t('stats_total'), value: stats.data.total },
        { label: t('stats_unassigned'), value: stats.data.unassigned },
        ...(stats.data.outForRepair !== null
          ? [{ label: t('stats_out_for_repair'), value: stats.data.outForRepair }]
          : []),
      ]
    : [],
)

/**
 * A count in the reader's own digits — «۱۲» in Persian, not "12".
 *
 * Not `formatCount`, which caps at "99+": that is a badge helper, and a workspace with 214 assets
 * would be told it has 99+ of them on the line whose job is to be the number.
 */
const number = (n: number) => new Intl.NumberFormat(messageLocale()).format(n)
</script>

<WidgetState
  pending={assets.isPending}
  error={assets.error}
  empty={!items.length}
  emptyTitle={t('empty')}
  emptyIcon="briefcase"
  onRetry={() => assets.refetch()}
>
  {#if tiles.length}
    <dl class="stats">
      {#each tiles as tile (tile.label)}
        <div class="stat">
          <dt>{tile.label}</dt>
          <dd>{number(tile.value)}</dd>
        </div>
      {/each}
    </dl>
  {/if}
  <ul>
    {#each items as asset (asset.id)}
      <li>
        <!--
          The row *is* the action. `kern-widget` §3: a card that only shows rows is a table of
          contents, and this one showed five assets with nothing to do about any of them. An anchor
          rather than a click handler, so the keyboard route is the same route — Tab reaches it,
          Enter follows it, and the browser offers "open in a new tab" for free. It lands on the
          list with the asset's own panel open, which is exactly where clicking the row on that
          screen puts somebody.
        -->
        <a class="row" href={assetHref(workspaceSlug, asset.id)}
          aria-label={t('open_asset', isolated({ name: asset.name }))}>
          <span class="code">{asset.code}</span>
          <span class="name">{asset.name}</span>
          <Badge tone={statusTone(asset.status)}>{t(`status_${asset.status}`)}</Badge>
        </a>
      </li>
    {/each}
  </ul>
</WidgetState>

<style>
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    margin: 0 0 12px;
    padding: 0 0 12px;
    border-bottom: 1px solid var(--kern-border-hairline);
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  dt {
    font-size: 11px;
    /* Muted with a colour rather than opacity, which fades the label against the card. */
    color: var(--kern-ink-500);
  }
  dd {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    line-height: 1.15;
    letter-spacing: -0.02em;
    color: var(--kern-ink-900);
    font-variant-numeric: tabular-nums;
  }
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
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: inherit;
    text-decoration: none;
    /* Logical, so the row's breathing room is on the reading-start edge in Persian too. Six
       vertical pixels take the row past the 24px WCAG 2.5.8 target height on its own. */
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
       Persian or Arabic card and the bidi algorithm does not reorder its digits — the same rule
       the repairs card next to it already follows. */
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
</style>
