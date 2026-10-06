import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { useRoute, type RouteLocationRaw } from 'vue-router';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import { requestViewRefresh, useViewRefresh } from '../viewRefresh';

/**
 * The refresh handover: the composable raises one signal for the sidebar, and
 * only the view whose route is the one on screen re-reads itself.
 *
 * A probe component stands in for a page, because that is all the contract is —
 * a route and a reload — and the reasoning it encodes (keep-alive keeps one
 * instance per route component, so the current route is the activeness test) is
 * the part worth pinning here.
 */
function probe(routeName: string, reload: () => void) {
  return {
    template: '<div></div>',
    setup() {
      useViewRefresh(useRoute(), routeName, reload);
    },
  };
}

async function mountProbe(route: RouteLocationRaw, routeName: string) {
  const reload = vi.fn();
  const router = createTestRouter();
  const wrapper = mount(probe(routeName, reload), {
    global: { plugins: [router, createTestI18n()] },
  });
  await router.push(route);
  await flushPromises();
  return { reload, router, wrapper };
}

const issueRoute: RouteLocationRaw = {
  name: 'issueDetail',
  params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: '5' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the sidebar refresh handover', () => {
  it('re-reads the view whose route is on screen', async () => {
    const { reload } = await mountProbe(issueRoute, 'issueDetail');

    requestViewRefresh();
    await flushPromises();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not re-read a view the reader has left', async () => {
    const { reload, router } = await mountProbe(issueRoute, 'issueDetail');

    // The keep-alive instance stays mounted while the reader is elsewhere; a
    // refresh that landed here would re-read a page nobody is looking at.
    await router.push({ name: 'notifications', params: {} });
    requestViewRefresh();
    await flushPromises();

    expect(reload).not.toHaveBeenCalled();
  });

  it('re-reads again on every press', async () => {
    const { reload } = await mountProbe(issueRoute, 'issueDetail');

    requestViewRefresh();
    await flushPromises();
    requestViewRefresh();
    await flushPromises();

    // A counter, not a flag: a second press has to be a second reload, and a
    // boolean would have to be cleared by a second message to allow it.
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
