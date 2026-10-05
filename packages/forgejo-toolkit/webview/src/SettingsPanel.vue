<script setup lang="ts">
import Settings from './views/Settings.vue';
</script>

<!--
  The settings tab's own root (`settings.html`), the way `OnboardingPanel.vue` is
  the wizard panel's.

  It exists for one reason and carries no state of its own: the tab is a
  **panel** surface, and a panel must not reach the dashboard shell — `App.vue`,
  the router and `vue-router` (`webview/vite.config.mts` and
  `src/__tests__/entryGraph.test.ts` both assert it). `Settings.vue` therefore
  stopped importing `vue-router` and this root gives it the document it needs
  (`docs/design/settings-page.md` §9.3, the implementation note).

  The page fills the editor area instead of sitting in a fixed-width column the
  way the wizard does: a settings tab in VS Code is a wide, two-column form, and
  the width is what decides which of the two navigation shapes the page uses
  (§9.3). The only thing this root decides is that the page — not the tab —
  scrolls, so the page's own sticky bars stick to the tab's top edge.
-->
<template>
  <div class="settings-panel">
    <Settings />
  </div>
</template>

<style>
/*
 * Unscoped on purpose: this surface's document is only ever this component's
 * (`settings.html` mounts `SettingsPanel.vue` and nothing else), and the height
 * chain has to start at the document element for the page's
 * `height: 100%; overflow: auto` scroll container to have a definite height.
 * The dashboard's `App.vue` states the same three rules for its own document.
 */
html,
body,
#app {
  height: 100%;
}
</style>

<style scoped>
.settings-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* The page's own padding: a tab has no frame of its own, and text that runs to
     the very edge of the editor area reads as if it were cut off. */
  padding: 16px 20px;
  box-sizing: border-box;
}

/* The page is the scrolling element, so it gets the height and a floor of zero
   (`min-height: 0` is what lets it shrink below its content and scroll at all). */
.settings-panel > * {
  flex: 1 1 auto;
  min-height: 0;
}
</style>
