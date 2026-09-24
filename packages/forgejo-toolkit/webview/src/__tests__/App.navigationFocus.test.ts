import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type RouteRecordRaw, type Router } from 'vue-router';
import { defineComponent, h, nextTick } from 'vue';
import App from '../App.vue';
import { createTestI18n } from './helpers/test-utils';

/** How many times each stub view was created, to tell keep-alive reuse apart. */
const creations = { first: 0, second: 0 };

const FirstView = defineComponent({
  name: 'FirstView',
  setup() {
    creations.first += 1;
    return () => h('div', [h('h1', 'Repositories')]);
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
  setup: () => () => h('div', [h('p', 'Instances')]),
});

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'first', component: FirstView },
  { path: '/second', name: 'second', component: SecondView },
  { path: '/dashboard', name: 'dashboard', component: HeadinglessView },
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

  it('prefers the heading the view renders over the route title', async () => {
    // The same route name as the heading-less route, but this view names itself:
    // what the user is looking at wins over the registered fallback.
    const HeadingView = defineComponent({
      name: 'HeadingView',
      setup: () => () => h('div', [h('h2', 'Instance list')]),
    });
    const { wrapper, router } = await mountApp([
      { path: '/', name: 'home', component: HeadinglessView },
      { path: '/dashboard', name: 'dashboard', component: HeadingView },
    ]);

    await router.push('/dashboard');
    await flushPromises();

    expect(announcement(wrapper)).toBe('Instance list');
  });
});
