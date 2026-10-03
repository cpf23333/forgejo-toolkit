import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type RouteRecordRaw, type Router } from 'vue-router';
import { defineComponent, h, nextTick, onActivated } from 'vue';
import App from '../App.vue';
import { createTestI18n } from './helpers/test-utils';

/** How many times each stub view was created, to tell keep-alive reuse apart. */
const creations = { first: 0, second: 0 };
/** How many times each stub view was activated, to tell a remount from a re-entry. */
const activations = { first: 0, dashboard: 0 };

const FirstView = defineComponent({
  name: 'FirstView',
  setup() {
    creations.first += 1;
    onActivated(() => {
      activations.first += 1;
    });
    return () => h('div', { 'data-view': 'first' }, [h('h1', 'Repositories')]);
  },
});

const SecondView = defineComponent({
  name: 'SecondView',
  setup() {
    creations.second += 1;
    return () => h('div', [h('h2', 'Settings')]);
  },
});

// The dashboard renders no heading of its own, so nothing inside `<main>` can
// name the view a navigation just opened.
const HeadinglessView = defineComponent({
  name: 'HeadinglessView',
  setup() {
    onActivated(() => {
      activations.dashboard += 1;
    });
    return () => h('div', { 'data-view': 'dashboard' }, [h('p', 'Instances')]);
  },
});

// A view whose first heading is a section heading *inside* it — Settings opens
// with `<h2>Language</h2>` — so nothing inside names the view as a whole.
const SectionHeadingView = defineComponent({
  name: 'SectionHeadingView',
  setup: () => () => h('div', [h('h2', 'Language'), h('p', 'body')]),
});

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'first', component: FirstView },
  { path: '/second', name: 'second', component: SecondView },
  { path: '/dashboard', name: 'dashboard', component: HeadinglessView },
  { path: '/settings', name: 'settings', component: SectionHeadingView },
];

const wrappers: VueWrapper[] = [];

async function mountApp(routeRecords: RouteRecordRaw[] = routes): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: routeRecords,
  });
  const wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [router, createTestI18n('en')] },
  });
  wrappers.push(wrapper);
  await router.isReady();
  await flushPromises();
  return { wrapper, router };
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
  creations.first = 0;
  creations.second = 0;
  activations.first = 0;
  activations.dashboard = 0;
});

function announcement(wrapper: VueWrapper): string {
  return wrapper.get('[role="status"]').text();
}

/**
 * Every navigation used to unmount the control that had focus (a repository
 * row, an issue card, a search result) and leave focus on `<body>` with no
 * report of where the view had gone. The shell now moves focus into `<main>`
 * and announces the title the view renders for itself.
 */
describe('App navigation focus and announcement', () => {
  it('leaves focus alone on the initial load', async () => {
    const { wrapper } = await mountApp();
    await nextTick();

    expect(document.activeElement).not.toBe(wrapper.get('main').element);
    expect(announcement(wrapper)).toBe('');
  });

  it('focuses the view and announces its title after a navigation', async () => {
    const { wrapper, router } = await mountApp();

    await router.push('/second');
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get('main').element);
    expect(announcement(wrapper)).toBe('Settings');
  });

  it('focuses a cached view again when it is reactivated', async () => {
    const { wrapper, router } = await mountApp();

    await router.push('/second');
    await flushPromises();
    await router.push('/');
    await flushPromises();
    // The view swap and the focus it schedules settle over a tick each; the
    // assertion is about where the focus and the announcement ended up.
    await nextTick();
    await nextTick();

    // The view was re-activated, not re-created: keep-alive still has to move
    // focus back into it and announce it.
    expect(creations.first).toBe(1);
    expect(document.activeElement).toBe(wrapper.get('main').element);
    expect(announcement(wrapper)).toBe('Repositories');
  });

  it('announces the route title when the view renders no heading', async () => {
    const { wrapper, router } = await mountApp();

    await router.push('/dashboard');
    await flushPromises();

    // Nothing inside `<main>` can name this view, so the shell falls back to the
    // title the route is registered under instead of announcing nothing.
    expect(document.activeElement).toBe(wrapper.get('main').element);
    expect(announcement(wrapper)).toBe('Dashboard');
  });

  it('announces the route title when the first heading is a section heading', async () => {
    const { wrapper, router } = await mountApp();

    await router.push('/settings');
    await flushPromises();

    // Settings' first heading is `<h2>Language</h2>` — a section inside the view,
    // not its title — so the view used to be announced as "Language". The title
    // its route is registered under outranks a section heading.
    expect(document.activeElement).toBe(wrapper.get('main').element);
    expect(announcement(wrapper)).toBe('Settings');
  });

  it('prefers the view’s own title over the route title', async () => {
    // The same route name as the heading-less route, but this view names itself
    // with its own top-level heading: what the user is looking at wins over the
    // registered fallback.
    const OwnTitleView = defineComponent({
      name: 'OwnTitleView',
      setup: () => () => h('div', [h('h1', 'Instance list')]),
    });
    const { wrapper, router } = await mountApp([
      { path: '/', name: 'home', component: HeadinglessView },
      { path: '/dashboard', name: 'dashboard', component: OwnTitleView },
    ]);

    await router.push('/dashboard');
    await flushPromises();

    expect(announcement(wrapper)).toBe('Instance list');
  });

  /**
   * The host's "open dashboard" does not navigate: it remounts the view in place
   * (a keep-alive key bump), so the route watcher never ran and neither focus nor
   * the announcement moved. And a live region announces a *change* of its text,
   * so reopening a view whose title is the one already announced — the dashboard
   * one is on — said nothing at all.
   */
  it('focuses and re-announces the dashboard when the host reopens it in place', async () => {
    const { wrapper, router } = await mountApp();
    await router.push('/dashboard');
    await flushPromises();
    const region = wrapper.get('[role="status"]').element;
    const changes: string[] = [];
    const observer = new MutationObserver(() => {
      changes.push(region.textContent ?? '');
    });
    observer.observe(region, { characterData: true, childList: true, subtree: true });

    // Reopening the view the user is already on remounts it in place.
    window.dispatchEvent(new MessageEvent('message', { data: { command: 'openDashboard' } }));
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('main').element);
    expect(announcement(wrapper)).toBe('Dashboard');

    // The same title again: the region has to be emptied in between, or the
    // second open announces nothing.
    changes.length = 0;
    window.dispatchEvent(new MessageEvent('message', { data: { command: 'openDashboard' } }));
    await flushPromises();
    observer.disconnect();

    expect(document.activeElement).toBe(wrapper.get('main').element);
    expect(announcement(wrapper)).toBe('Dashboard');
    expect(changes).toContain('');
  });

  /**
   * Reopening the dashboard used to remount it by bumping a keep-alive key. The
   * entry that replaced was unreachable — nothing could navigate back to it — but
   * it still occupied one of the ten keep-alive slots, so enough presses evicted
   * live views to make room for views nobody could reach. Pressing the command
   * again now only moves focus and re-announces, leaving the cached view alone.
   */
  it('does not remount (or evict) the cached view when the host reopens the dashboard', async () => {
    const { wrapper, router } = await mountApp();

    await router.push('/dashboard');
    await flushPromises();
    expect(wrapper.findAll('[data-view]')).toHaveLength(1);
    expect(activations.dashboard).toBe(1);

    for (let press = 0; press < 5; press += 1) {
      window.dispatchEvent(new MessageEvent('message', { data: { command: 'openDashboard' } }));
      await flushPromises();
    }

    // The view the user is on was neither remounted nor multiplied: the cache
    // holds the one live copy it always did.
    expect(wrapper.findAll('[data-view]')).toHaveLength(1);
    expect(wrapper.find('[data-view="dashboard"]').exists()).toBe(true);
    expect(activations.dashboard).toBe(1);
    expect(document.activeElement).toBe(wrapper.get('main').element);
    expect(announcement(wrapper)).toBe('Dashboard');
  });

  it('leaves no stale copy of the view behind when the command also navigates', async () => {
    const { wrapper, router } = await mountApp();
    await router.push('/');
    await flushPromises();
    expect(wrapper.findAll('[data-view]')).toHaveLength(1);

    // The host's open-dashboard message reaches the whole page: the composable
    // behind `useAppState` navigates, and this shell's own handler asks for the
    // focus. Both land in the same dispatch.
    const onMessage = (event: MessageEvent) => {
      if (event.data?.command === 'openDashboard') {
        void router.push('/dashboard');
      }
    };
    window.addEventListener('message', onMessage);
    try {
      window.dispatchEvent(new MessageEvent('message', { data: { command: 'openDashboard' } }));
      await flushPromises();
    } finally {
      window.removeEventListener('message', onMessage);
    }

    expect(router.currentRoute.value.fullPath).toBe('/dashboard');
    expect(wrapper.findAll('[data-view]')).toHaveLength(1);
    expect(wrapper.get('[data-view]').text()).toContain('Instances');
    // Re-activating the cached first view would mean it is still in the tree.
    expect(activations.first).toBe(1);
  });

  /**
   * When the message also changes the route, the route watcher and the message
   * handler both wanted to move focus and refill the live region: the same title
   * was announced twice. Exactly one focus per open is what tells them apart —
   * both halves of the old pair called `main.focus()`.
   */
  it('focuses and announces the new view once when the command also navigates', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      const { wrapper, router } = await mountApp();
      await router.push('/');
      await flushPromises();
      await nextTick();
      await nextTick();
      focus.mockClear();

      // The host's message reaches the whole page: the composable behind
      // `useAppState` navigates, and this shell's own handler asks for the same
      // focus. Changing the route object directly reproduces the one thing that
      // matters here — both happen before the deferred focus tick runs, so both
      // would call `main.focus()` and refill the live region.
      const onMessage = (event: MessageEvent) => {
        if (event.data?.command === 'openDashboard') {
          // eslint-disable-next-line vue/no-mutating-props
          (router.currentRoute.value as { fullPath: string }).fullPath = '/dashboard';
        }
      };
      window.addEventListener('message', onMessage);
      try {
        window.dispatchEvent(new MessageEvent('message', { data: { command: 'openDashboard' } }));
        await flushPromises();
        await nextTick();
      } finally {
        window.removeEventListener('message', onMessage);
      }

      expect(focus).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(wrapper.get('main').element);
      // The region was filled, not left empty: exactly one run owns the
      // announcement, whether it read a heading from `<main>` or the route title.
      expect(announcement(wrapper)).not.toBe('');
    } finally {
      focus.mockRestore();
    }
  });
});

/**
 * `<main>` takes focus on every navigation so a screen reader starts reading the
 * view that just opened — it is a programmatic destination, not a control, and it
 * used to be drawn with the browser's own `:focus-visible` ring (`auto 1px` in the
 * focus-ring colour, which is the yellow a theme keeps for warnings) around the
 * whole panel.
 *
 * jsdom computes no cascade, so the ring's absence is a stylesheet guard — the
 * same kind `Settings.instanceEditorLayout.test.ts` uses. The source is read
 * through Vite's glob because the webview tests run without Node types.
 */
const appSources = import.meta.glob('../App.vue', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const appSource = Object.values(appSources)[0] ?? '';

/** Every `selector { body }` of the component's stylesheet, comments removed. */
function appStyleRules(): Array<{ selectors: string; body: string }> {
  const css = appSource.slice(appSource.indexOf('<style>')).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].trim(),
    body: match[2],
  }));
}

describe('App shell focus styling', () => {
  it('reads the component stylesheet it is meant to guard', () => {
    expect(appSource).toContain('main:focus-visible');
  });

  it('states no outline on the shell’s programmatic focus destination', () => {
    const rules = appStyleRules();
    expect(rules.length).toBeGreaterThan(3);
    const destination = rules.find((rule) => rule.selectors.includes('main:focus'));
    expect(destination, 'the rule for the shell’s focus destination').toBeTruthy();
    // Both focus states, so neither the browser's ring nor a later author rule can
    // draw a border around the panel.
    expect(destination!.selectors).toContain('main:focus');
    expect(destination!.selectors).toContain('main:focus-visible');
    expect(destination!.body).toContain('outline: none');
    expect(destination!.body).not.toContain('outline-offset');
    // It is the only outline this file states, so nothing here can paint a ring
    // around the panel…
    const outlineRules = rules.filter((rule) => /(^|[;\s])outline\s*:/.test(rule.body));
    expect(outlineRules).toHaveLength(1);
    // …and nothing here suppresses one for a control. The shell's own control is
    // the back button, a plain `<button>` that keeps the browser's ring (measured
    // in the panel: `auto 1px` while focused); the views' controls keep the rings
    // their components draw.
    for (const rule of outlineRules) {
      expect(rule.selectors).not.toMatch(/button|back-link|link-button/);
    }
  });
});
