import { defineClientModule } from '@kernhq/ui'
import { inventoryMessageBundles, t } from './i18n.js'
import { INVENTORY_PERMISSIONS } from './permissions.js'

/**
 * This module as the shell sees it.
 *
 * Everything the interface offers is declared here — navigation, routes, commands, widgets,
 * settings pages, sidebars, presenters — and the shell renders whatever it finds. There are no
 * route files in the app to keep in step: deleting this package removes the feature completely,
 * which is the test of whether something is a module at all.
 *
 * Labels are **getters** because a module is defined once at import time while the interface
 * language can change afterwards. Reading them on render keeps the rail in the language chosen.
 */
export const inventoryClientModule = defineClientModule({
  id: 'inventory',
  name: 'Inventory',
  icon: 'briefcase',
  messages: inventoryMessageBundles,

  nav: [
    {
      id: 'inventory',
      get label() {
        return t('nav')
      },
      icon: 'briefcase',
      href: '/inventory',
      order: 55,
      permission: INVENTORY_PERMISSIONS.view,
    },
  ],

  /**
   * Routes are declarations, not files. `:name` matches one segment and reaches the component as
   * `params.name`; specificity decides ties, literal segments first.
   */
  routes: [
    {
      path: '/inventory',
      component: () => import('./pages/AssetsPage.svelte'),
      get title() {
        return t('title')
      },
      permission: INVENTORY_PERMISSIONS.view,
    },
  ],

  commands: [
    {
      id: 'inventory.open',
      get label() {
        return t('nav')
      },
      icon: 'briefcase',
      permission: INVENTORY_PERMISSIONS.view,
      run: (ctx) => ctx.navigate('/inventory'),
    },
  ],

  widgets: [
    {
      id: 'inventory.recent',
      get title() {
        return t('widget_title')
      },
      get description() {
        return t('widget_desc')
      },
      icon: 'briefcase',
      permission: INVENTORY_PERMISSIONS.view,
      sizes: ['m', 'l'],
      defaultSize: 'm',
      order: 55,
      settings: [
        {
          kind: 'number',
          key: 'limit',
          get label() {
            return t('common.setting_rows')
          },
          default: 5,
          min: 3,
          max: 20,
        },
      ],
      component: () => import('./widgets/OverviewWidget.svelte'),
    },
  ],

  /**
   * A settings page's `id` is its URL: the shell mounts it at `/<ws>/settings/inventory/<id>`.
   *
   * This was `[]` while the server enforced `assetCodePrefix` and `assetCodePad` on every asset it
   * created — two settings nobody, at any permission level, could change. `core.modules.manage`
   * rather than an inventory permission, because that is what core gates
   * `workspaces.modules.updateSettings` on: offering the page on a wider permission shows somebody
   * a form the server then refuses on save.
   */
  settingsPages: [
    {
      id: 'general',
      get label() {
        return t('settings_general')
      },
      icon: 'sliders-vertical',
      scope: 'workspace',
      permission: 'core.modules.manage',
      order: 1,
      component: () => import('./settings/GeneralSettings.svelte'),
    },
  ],
})

export default inventoryClientModule
