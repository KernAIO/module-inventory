import type { Asset } from '../contract.js'

/**
 * The in-memory implementation of this module's API.
 *
 * It satisfies the same contract types as the real client, so no screen has a second code path for
 * demos and end-to-end tests. The shell reports demo mode through `getHost().isMock` — a module
 * never checks an env var itself.
 *
 * Keep it in step with the contract. A module whose mock is missing a procedure has a working page
 * and a broken demo, in exactly the environment used to show the product.
 */
interface MockAsset extends Asset {}

export function createMockInventoryApi() {
  let counter = 2
  const assets: MockAsset[] = [
    seed('01920000-0000-7000-8000-000000000001', 'INV-0001', 'MacBook Pro 14"', 'assigned'),
  ]

  function seed(id: string, code: string, name: string, status: Asset['status']): MockAsset {
    const now = new Date().toISOString()
    return {
      id,
      workspaceId: '' as Asset['workspaceId'],
      code,
      name,
      description: '',
      categoryId: null,
      status,
      custodianUserId: null,
      custodySince: null,
      serialNumber: null,
      location: null,
      purchasedOn: null,
      purchasedFrom: null,
      priceMinor: null,
      currency: null,
      warrantyUntil: null,
      photoFileId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
  }

  return {
    assets: {
      list: async ({ workspaceId, q }: { workspaceId: string; q?: string }) => ({
        items: assets
          .filter((a) => !q || a.name.includes(q) || a.code.includes(q) || (a.serialNumber ?? '').includes(q))
          .map((a) => ({ ...a, workspaceId })),
        nextCursor: null,
      }),
      get: async ({ assetId }: { assetId: string }) => {
        const asset = assets.find((a) => a.id === assetId)
        if (!asset) throw new Error('Asset not found')
        return { ...asset }
      },
      create: async ({ workspaceId, ...rest }: { workspaceId: string } & Record<string, unknown>) => {
        const asset: MockAsset = {
          ...seed(
            crypto.randomUUID(),
            `INV-${String(counter++).padStart(4, '0')}`,
            String(rest.name),
            'in_stock',
          ),
          workspaceId: workspaceId as Asset['workspaceId'],
          description: String(rest.description ?? ''),
          serialNumber: (rest.serialNumber as string | undefined) ?? null,
          location: (rest.location as string | undefined) ?? null,
          purchasedFrom: (rest.purchasedFrom as string | undefined) ?? null,
          purchasedOn: (rest.purchasedOn as string | undefined) ?? null,
          warrantyUntil: (rest.warrantyUntil as string | undefined) ?? null,
          priceMinor: (rest.priceMinor as number | undefined) ?? null,
          currency: (rest.currency as string | undefined) ?? null,
        }
        assets.unshift(asset)
        return { ...asset }
      },
      update: async ({ assetId, ...rest }: { assetId: string } & Record<string, unknown>) => {
        const asset = assets.find((a) => a.id === assetId)
        if (!asset) throw new Error('Asset not found')
        Object.assign(asset, rest)
        return { ...asset }
      },
      archive: async ({ assetId, archived }: { assetId: string; archived?: boolean }) => {
        const asset = assets.find((a) => a.id === assetId)
        if (!asset) throw new Error('Asset not found')
        asset.archivedAt = archived === false ? null : new Date().toISOString()
        return { ...asset }
      },
    },
  }
}
