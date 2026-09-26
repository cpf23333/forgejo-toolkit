<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const canGoBack = computed(() => route.path !== '/');
const backLabel = computed(() => t('app.back'));

const mainRef = ref<HTMLElement | null>(null);
// What the status region announces: the title the view that just opened renders
// itself. The region is in the DOM (empty) from the first render, so the
// assistive technology has already observed it when a navigation fills it.
const viewAnnouncement = ref('');
// The router's own initial resolution is the load, not a navigation the user
// asked for: focusing there would move focus — and announce a view — before the
// user did anything. Everything after that resolution is a navigation.
let viewFocusArmed = false;

// A view that renders no heading of its own would leave the live region empty.
// The title its route is registered under fills that gap; a view that renders a
// real title of its own still wins, because that is what the user is looking at.
const viewTitleKeys: Record<string, string> = {
  dashboard: 'app.viewTitleDashboard',
  settings: 'app.viewTitleSettings',
};

function routeTitle(): string {
  const name = typeof route.name === 'string' ? route.name : '';
  const key = viewTitleKeys[name];
  return key ? t(key) : '';
}

/**
 * What the live region announces for the view now inside `<main>`.
 *
 * A view's own top-level heading (`<h1>`, or an explicit heading role) names it.
 * An `<h2>`/`<h3>` is as likely to be a section heading *inside* the view:
 * Settings' first heading is `<h2>Language</h2>`, so reading it announced the
 * whole view as "Language". A registered route title therefore outranks one, and
 * a view with neither falls back to its first heading — which is what
 * `RepoIssues` ("Issues in <repo>") and `RepoDetail` rely on.
 */
function viewTitle(main: HTMLElement): string {
  const ownHeading = (main.querySelector('h1, [role="heading"]')?.textContent ?? '').trim();
  return ownHeading || routeTitle() || (main.querySelector('h2, h3')?.textContent ?? '').trim();
}

/**
 * Moves focus into the view a navigation just activated and names it.
 *
 * Activating a repository row, an issue card or a search result unmounts the
 * control that had focus, so it fell to `<body>` and nothing reported the new
 * view. Focus goes to `<main>`, the container every view renders into, and the
 * view's own first heading names it in the live region — or, when the view renders
 * none (the dashboard), the title its route is registered under. `<keep-alive>`
 * needs no special case: a re-activated view is inside `main` again, so the
 * heading found here is the one the user is now looking at.
 */
async function focusActiveView() {
  const main = mainRef.value;
  if (!main) {
    return;
  }
  main.focus();
  // A live region announces a *change* of its text, so re-entering a view whose
  // title is the one already announced — coming back to the same repository, or
  // reopening the settings view — said nothing at all. Clearing it (and letting
  // the DOM see the empty text) makes the same title announce again.
  viewAnnouncement.value = '';
  await nextTick();
  viewAnnouncement.value = viewTitle(main);
}

/**
 * Schedules one focus-and-announce for the view the route now points at.
 *
 * The route watcher below and `handleMessage` both go through here, and both can
 * fire for the same open: the host's "open dashboard" changes the route while
 * this shell's own handler asks for the focus. Two scheduled focus runs would
 * empty and refill the live region twice and announce the same title twice.
 *
 * The token is what collapses them. Scheduling bumps it; a run that finds it
 * bumped waits one more tick instead of acting, so only the last schedule for a
 * settled route moves the focus and fills the region. A route change made while
 * that extra tick is pending bumps it again, and the waiting run picks up the
 * view that actually arrived — the title read is never the one the user has left.
 */
let viewFocusToken = 0;

function scheduleViewFocus() {
  if (!viewFocusArmed) {
    return;
  }
  viewFocusToken += 1;
  const run = viewFocusToken;
  void (async () => {
    do {
      await nextTick();
    } while (run !== viewFocusToken);
    await focusActiveView();
  })();
}

watch(() => route.fullPath, scheduleViewFocus);

function back() {
  router.back();
}

function handleMessage(event: MessageEvent) {
  if (event.data?.command === 'openDashboard') {
    // The host's "open dashboard" is a re-open of the view the user is already
    // on: the route does not change, so the watcher above never runs and neither
    // focus nor the announcement moved. Doing it here is what makes pressing the
    // command again re-focus the view and re-announce its title.
    //
    // The view is deliberately *not* remounted for this. A bumped keep-alive key
    // did remount it, but the entry it replaced became unreachable while still
    // occupying one of the ten keep-alive slots — after enough presses live views
    // were evicted in favour of views nobody could navigate back to.
    //
    // When the message does change the route (the user is in Settings and the
    // host opens the dashboard), the watcher schedules the same focus; the token
    // in `scheduleViewFocus` collapses the two into one.
    scheduleViewFocus();
  }
}

onMounted(async () => {
  window.addEventListener('message', handleMessage);
  // Armed only once the initial navigation has settled (see viewFocusArmed).
  await router.isReady();
  viewFocusArmed = true;
});

onUnmounted(() => {
  window.removeEventListener('message', handleMessage);
});
</script>

<template>
  <div class="app">
    <header v-if="canGoBack" class="app-header">
      <button type="button" class="back-link link-button" @click="back">
        {{ backLabel }}
      </button>
    </header>
    <main ref="mainRef" tabindex="-1">
      <router-view v-slot="{ Component }">
        <keep-alive :max="10">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </main>
    <p class="view-announcement" role="status" aria-live="polite">{{ viewAnnouncement }}</p>
  </div>
</template>

<style>
.app {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow: hidden;
  box-sizing: border-box;
  padding: 12px;
}

html,
body,
#app {
  height: 100%;
}

body {
  margin: 0;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.back-link {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  font-size: 0.9em;
}

.back-link:hover {
  text-decoration: underline;
}

main {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* The view announcement is for assistive technology only. Out of the flow so it
   adds nothing to the shell's layout, and kept in the DOM (unlike a region that
   appears together with its text) so a navigation only changes its content,
   which is what a live region is announced for. */
.view-announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
