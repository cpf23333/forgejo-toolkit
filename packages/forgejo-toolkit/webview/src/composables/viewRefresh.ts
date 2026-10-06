import { ref, watch } from 'vue';

/**
 * The sidebar's "re-read yourself" signal.
 *
 * The host's view-title refresh posts one `refreshData` message and does not say
 * what to re-read: only the webview knows which of its routes is on screen (see
 * `refreshActiveView` in `useAppState`). The composable cannot refresh those
 * views itself either — a repository's selected branch, an action run's expanded
 * job logs and the notification filters on screen are view-local — so the press
 * is handed over here: the composable raises the signal and the view on screen
 * re-issues the loads it owns.
 *
 * The counter lives in its own module rather than in the shared state object
 * because it is a handover, not data any view renders: every view that answers it
 * does so through `useViewRefresh` below, which is also where the "is this view
 * the one on screen" rule and its reasoning are written once instead of in each
 * view. A counter rather than a boolean, for the same reason
 * `settingsRefreshTick` is one: every press has to be a new value.
 */
const refreshTick = ref(0);

/** Asks the sidebar view that is on screen to re-read the data it owns. */
export function requestViewRefresh(): void {
  refreshTick.value += 1;
}

/**
 * Re-reads this view's own data whenever the host refreshes the sidebar, while
 * this view is the one on screen.
 *
 * `route` is the view's own route object (all this needs from it is its `name`,
 * which is why the parameter is structural) and `routeName` the route this view
 * belongs to. The guard is that route rather than an activation flag:
 * `<keep-alive>` keeps **one** instance of a route component (the cache is keyed
 * by the component), so this view is on screen exactly when the current route is
 * its own — and reading the route is synchronous, which a lifecycle flag is not.
 * `onDeactivated` has not run yet in the pre-flush pass of the very navigation
 * that hides this view, so a flag read there would still say `true` and a refresh
 * landing in that pass would re-read a page the user has just left.
 *
 * This module deliberately imports nothing from `vue-router`: `useAppState`
 * imports it and every standalone panel imports `useAppState`, and a panel must
 * not ship the router at all (the same reason `useAppRouter`'s one vue-router
 * import is a type). The route therefore comes from the view, which already has
 * one.
 */
export function useViewRefresh(route: { name: unknown }, routeName: string, reload: () => void): void {
  watch(refreshTick, () => {
    if (route.name !== routeName) {
      return;
    }
    reload();
  });
}
