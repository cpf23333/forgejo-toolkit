import { inject, type InjectionKey } from 'vue';
import type { Router } from 'vue-router';

/**
 * The dashboard's router, or `undefined` on a surface that has none.
 *
 * The dashboard entry provides the real router (`src/main.ts`); the two
 * standalone panels provide nothing and therefore get `undefined` — the same
 * answer vue-router's own `useRouter()` gives them, but without importing the
 * router *implementation*. That import is what used to pull vue-router into
 * every surface, because `useAppState` is shared by the dashboard and both
 * panels. `Router` is a type-only import here, so nothing of vue-router
 * survives into a panel's entry bundle.
 */
export const appRouterKey: InjectionKey<Router> = Symbol('forgejoToolkit.router');

/**
 * Typed like vue-router's `useRouter()`, which is also declared `Router` while
 * answering `undefined` (with a warning) when no router was installed. The two
 * standalone panels are that case: they never call a router method —
 * `useAppState` guards its one hook with `?.` — and the default value here keeps
 * even that warning out of their console.
 */
export function useAppRouter(): Router {
  return inject(appRouterKey, undefined) as Router;
}
