/**
 * The inventory permission matrix, blessed rather than assumed.
 *
 * Defaults are declared one permission at a time, which makes the whole picture — which built-in
 * role ends up holding what — impossible to read from any single line. This writes it out in full
 * and compares it against what the module declares. Rows list the *effective* grants, cascade
 * included: the kernel expands declared `defaultRoles` upward through guest ⊆ member ⊆ admin ⊆
 * owner, and `permissionMatrixDiff` applies the same expansion.
 *
 * Changing a default is meant to be deliberate: edit `defaultRoles` → this fails naming every row
 * that moved → confirm that is what you meant → update `BLESSED` in the same commit.
 */
import { permissionMatrixDiff } from '@kernhq/testing'
import { describe, expect, it } from 'vitest'
import { inventoryPermissions } from './permissions.js'

/** Every built-in role that holds the permission by default, lowest role first. */
const BLESSED: Record<string, readonly string[]> = {
  'inventory.asset.view': ['guest', 'member', 'admin', 'owner'],
  'inventory.asset.manage': ['member', 'admin', 'owner'],
  'inventory.custody.manage': ['member', 'admin', 'owner'],
  'inventory.repair.manage': ['member', 'admin', 'owner'],
  'inventory.category.manage': ['admin', 'owner'],
  'inventory.field.manage': ['admin', 'owner'],
}

/**
 * None. Archiving and retiring ask first and are undone by restore and reinstate; nothing here
 * deletes a row or reaches outside the workspace.
 */
const DANGEROUS: string[] = []

describe('inventory permissions', () => {
  it('grants each permission to exactly the blessed roles', () => {
    expect(permissionMatrixDiff(inventoryPermissions, BLESSED)).toEqual([])
  })

  it('namespaces every key under the module id and declares it once', () => {
    const keys = inventoryPermissions.map((p) => p.key)
    expect(keys.filter((key) => !key.startsWith('inventory.'))).toEqual([])
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([])
  })

  it('marks exactly the destructive permissions dangerous', () => {
    const flagged = inventoryPermissions.filter((p) => p.dangerous).map((p) => p.key)
    expect(flagged.toSorted()).toEqual(DANGEROUS.toSorted())
  })
})
