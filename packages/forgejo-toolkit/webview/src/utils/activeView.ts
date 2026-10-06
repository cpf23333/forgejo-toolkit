import {
  FORGEJO_ACTIVE_VIEWS,
  FORGEJO_NO_ACTIVE_VIEW,
  type ForgejoActiveView,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/** The value the sidebar reports for the view it is showing. */
export type ReportedActiveView = ForgejoActiveView | typeof FORGEJO_NO_ACTIVE_VIEW;

/**
 * The view the sidebar is showing, as the host's refresh items need it.
 *
 * The host contributes one `view/title` command per refresh target and cannot
 * evaluate a `when` clause against anything it cannot see, so the sidebar — the
 * only side that knows its route — names it and the host stores the answer under
 * `forgejoToolkit.activeView`.
 *
 * Two answers are deliberate:
 *
 * - A route the sidebar does not know (no router yet, a name this build does not
 *   contribute) reports `FORGEJO_NO_ACTIVE_VIEW`, so no item is visible: an item
 *   whose press could not be routed to a page is worse than no item.
 * - The **dashboard of an installation with no instance** reports the same value.
 *   That is the sidebar's first-run state: it offers the setup guide rather than
 *   data, so a refresh there would retrieve nothing, and the icon stays away
 *   (the first-run wizard itself is a separate editor-area panel with no view
 *   title bar at all).
 *
 * The route vocabulary is shared with the host (`FORGEJO_ACTIVE_VIEWS`), so a
 * route the sidebar grows without the host agreeing on it reports no view rather
 * than a value no `when` clause can test.
 */
export function activeViewForRoute(routeName: unknown, configuredInstances: number): ReportedActiveView {
  if (typeof routeName !== 'string' || !(FORGEJO_ACTIVE_VIEWS as readonly string[]).includes(routeName)) {
    return FORGEJO_NO_ACTIVE_VIEW;
  }
  if (routeName === 'dashboard' && configuredInstances === 0) {
    return FORGEJO_NO_ACTIVE_VIEW;
  }
  return routeName as ForgejoActiveView;
}
