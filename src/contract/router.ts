import { baseContract, PageInput, page } from '@kernhq/contracts'
import { z } from 'zod'
import { Asset, AssetCreateInput, AssetPatchInput, AssetSort, AssetStatus, ws } from './models.js'

const t = ['inventory'] as const

export const inventoryContract = {
  assets: {
    list: baseContract
      .route({ method: 'GET', path: '/assets', tags: t })
      .input(
        ws.extend({
          ...PageInput.shape,
          q: z.string().max(200).optional(),
          categoryId: z.uuid().optional(),
          status: AssetStatus.optional(),
          custodianUserId: z.uuid().optional(),
          /**
           * Archived rows are excluded unless asked for. The page used to filter them in the
           * browser, which is wrong the moment there is more than one page of them: the first
           * twenty rows come back, half are dropped, and the list looks short rather than paged.
           */
          archived: z.boolean().default(false),
          sort: AssetSort.default('recent'),
        }),
      )
      .output(page(Asset)),
    get: baseContract
      .route({ method: 'GET', path: '/assets/{assetId}', tags: t })
      .input(ws.extend({ assetId: z.uuid() }))
      .output(Asset),
    create: baseContract
      .route({ method: 'POST', path: '/assets', tags: t })
      .input(ws.extend(AssetCreateInput.shape))
      .output(Asset),
    update: baseContract
      .route({ method: 'PATCH', path: '/assets/{assetId}', tags: t })
      .input(ws.extend({ assetId: z.uuid(), ...AssetPatchInput.shape }))
      .output(Asset),
    archive: baseContract
      .route({ method: 'POST', path: '/assets/{assetId}/archive', tags: t })
      .input(ws.extend({ assetId: z.uuid(), archived: z.boolean().default(true) }))
      .output(Asset),
  },
}
export type InventoryContract = typeof inventoryContract
