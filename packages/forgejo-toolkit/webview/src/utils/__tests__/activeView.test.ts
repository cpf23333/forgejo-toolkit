import { describe, expect, it } from 'vitest';
import { FORGEJO_ACTIVE_VIEWS, FORGEJO_NO_ACTIVE_VIEW } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { activeViewForRoute } from '../activeView';
import { routes } from '../../router';

/**
 * The view the sidebar reports to the host.
 *
 * The host contributes one `view/title` refresh command per target and gates it
 * on the context key it fills from this report, so the value has to be exactly
 * one of the names both sides agreed on (`FORGEJO_ACTIVE_VIEWS`) — or the
 * explicit "nothing to refresh" value, which no item tests.
 */
describe('the view the sidebar reports', () => {
  it('names the view each sidebar route shows', () => {
    for (const name of FORGEJO_ACTIVE_VIEWS) {
      expect(activeViewForRoute(name, 1), name).toBe(name);
    }
  });

  it('reports nothing to refresh for the first-run dashboard', () => {
    // No instance configured: the dashboard offers the setup guide instead of
    // data, so a refresh there would retrieve nothing. (The wizard itself is a
    // separate editor-area panel, with no view title bar at all.)
    expect(activeViewForRoute('dashboard', 0)).toBe(FORGEJO_NO_ACTIVE_VIEW);
    expect(activeViewForRoute('dashboard', 1)).toBe('dashboard');
  });

  it('reports no view while the router has not resolved one', () => {
    expect(activeViewForRoute(undefined, 3)).toBe(FORGEJO_NO_ACTIVE_VIEW);
    expect(activeViewForRoute(null, 3)).toBe(FORGEJO_NO_ACTIVE_VIEW);
    expect(activeViewForRoute('', 3)).toBe(FORGEJO_NO_ACTIVE_VIEW);
    expect(activeViewForRoute(Symbol('dashboard'), 3)).toBe(FORGEJO_NO_ACTIVE_VIEW);
  });

  it('reports no view for a route it does not know', () => {
    // A name the host contributes no item for would otherwise make the key hold
    // a value nothing can test, leaving every item hidden by accident rather than
    // on purpose. Reporting "nothing to refresh" is the same outcome, said
    // plainly.
    expect(activeViewForRoute('someFutureRoute', 3)).toBe(FORGEJO_NO_ACTIVE_VIEW);
  });

  it('agrees with the sidebar router', () => {
    // The vocabulary is the sidebar's own route table. A route added there
    // without the host agreeing on it would report no view (and silently lose its
    // refresh item), and a name here that no route uses would be dead.
    expect(routes.map((route) => route.name).sort()).toEqual([...FORGEJO_ACTIVE_VIEWS].sort());
  });
});
