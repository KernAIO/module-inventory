import { createModuleClient, type KernClientOptions } from '@kernhq/sdk'
import type { ContractRouterClient } from '@orpc/contract'
import type { InventoryContract } from '../contract/index.js'

/** The typed client, derived from the contract — no hand-written method list to drift. */
export type InventoryApi = ContractRouterClient<InventoryContract>

export function createInventoryClient(opts: KernClientOptions): InventoryApi {
  return createModuleClient<InventoryApi>(opts, 'inventory')
}
