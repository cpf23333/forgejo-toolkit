import {
  FORGEJO_ACTIVE_VIEWS,
  FORGEJO_NO_ACTIVE_VIEW,
  type ForgejoActiveView,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The context key the sidebar's view-title actions are gated on.
 *
 * A `view/title` item's `when` clause is evaluated by VS Code, which cannot see
 * which route the sidebar's webview is on; the webview reports that
 * (`setActiveView`) and the host stores the answer here, so exactly one refresh
 * item matches the page the reader is looking at. The key is namespaced to this
 * extension because a context key is global to the window.
 */
export const ACTIVE_VIEW_CONTEXT_KEY = 'forgejoToolkit.activeView';

/**
 * The reported view, or `undefined` when the report is not one of the values
 * this build knows.
 *
 * The webview is untrusted, so its report is validated rather than stored: an
 * unrecognised value hides every item instead of letting a forged one make an
 * action visible for a page it is not showing. `FORGEJO_NO_ACTIVE_VIEW` is a
 * value the webview is entitled to report (a view with nothing to retrieve) and
 * is passed through as itself — no item tests it either, and keeping it makes
 * the context key hold exactly what was reported.
 */
export function parseActiveView(value: unknown): ForgejoActiveView | typeof FORGEJO_NO_ACTIVE_VIEW | undefined {
  if (value === FORGEJO_NO_ACTIVE_VIEW) {
    return FORGEJO_NO_ACTIVE_VIEW;
  }
  return typeof value === 'string' && (FORGEJO_ACTIVE_VIEWS as readonly string[]).includes(value)
    ? (value as ForgejoActiveView)
    : undefined;
}

/**
 * The refresh commands, one per view-title item.
 *
 * They share one icon and one handler (`ForgejoToolkitViewProvider.refresh`,
 * registered in `commands/index.ts`) and differ only in the `when` clause that
 * makes exactly one of them visible; the ids are named here so the registration
 * and the manifest-wide test that reads `package.json` work off one list. They
 * are deliberately **not** one command with a dynamic title: a command's title
 * in a menu is static, so the tooltip that names the true target has to come
 * from a separate command per target.
 */
export const REFRESH_VIEW_COMMANDS = [
  'forgejoToolkit.refreshInstances',
  'forgejoToolkit.refreshRepository',
  'forgejoToolkit.refreshIssue',
  'forgejoToolkit.refreshPullRequest',
  'forgejoToolkit.refreshNotifications',
] as const;
