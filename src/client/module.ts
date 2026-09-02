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
  /**
   * A getter, for the reason every label below is one — and now that this field is rendered too, the
   * reason reaches it.
   *
   * `name` was the last string in this file left as an English literal, on the grounds that a
   * manifest name is data an operator greps rather than a string a reader sees. That stopped being
   * true: the dashboard's widget picker heads this module's group with `mod.name` directly, so a
   * Persian reader was shown "Inventory" as a section label in an otherwise Persian panel, and the
   * shell's settings rail falls back to it for any module whose navigation it cannot read.
   *
   * `name` is typed as a plain `string` on `ClientModule`, and a getter satisfies that exactly as
   * `get label()` does for a nav item. Nothing snapshots it: `defineClientModule` returns the object
   * unchanged, `registerModule` pushes that same object into an array, and every reader goes through
   * the property — so the language it resolves in is the one on screen rather than the one that
   * happened to be loaded at import time.
   */
  get name() {
    return t('nav')
  },
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
    {
      /**
       * A second card rather than a `view` option on the first, because this one is gated.
       *
       * `capability` is what the shell filters the dashboard by, so a workspace that does not
       * record repairs is never offered this card at all. An option inside the other card's
       * settings would offer the question and then answer it with an empty card — which is exactly
       * the "a switch that changes nothing" failure the capability mechanism exists to avoid.
       */
      id: 'inventory.repairs',
      get title() {
        return t('widget_repairs_title')
      },
      get description() {
        return t('widget_repairs_desc')
      },
      icon: 'wrench',
      permission: INVENTORY_PERMISSIONS.view,
      capability: 'repairs',
      sizes: ['m', 'l'],
      defaultSize: 'm',
      order: 56,
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
      component: () => import('./widgets/RepairsWidget.svelte'),
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
    {
      /**
       * Categories are this module's own data rather than core's, so this one is gated on this
       * module's own key — `inventory.category.manage`, which is exactly what `categories.create`,
       * `.update` and `.archive` require on the server. General above is gated on
       * `core.modules.manage` because *that* page writes through core's settings procedure; the two
       * pages sit side by side and are deliberately not gated the same way.
       */
      id: 'categories',
      get label() {
        return t('settings_categories')
      },
      icon: 'tag',
      scope: 'workspace',
      permission: INVENTORY_PERMISSIONS.categories,
      order: 2,
      component: () => import('./settings/CategoriesSettings.svelte'),
    },
    {
      /**
       * The workspace's own fields, gated the way categories are and for the same reason: they are
       * this module's data, and `inventory.field.manage` is exactly what `fields.create`, `.update`,
       * `.archive` and `.reorder` require on the server.
       */
      id: 'fields',
      get label() {
        return t('settings_fields')
      },
      icon: 'list-checks',
      scope: 'workspace',
      permission: INVENTORY_PERMISSIONS.fields,
      order: 3,
      component: () => import('./settings/FieldsSettings.svelte'),
    },
  ],
})

export default inventoryClientModule
