<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const canGoBack = computed(() => route.path !== '/');
const backLabel = computed(() => t('app.back'));

function back() {
  router.back();
}
</script>

<template>
  <div class="app">
    <header v-if="canGoBack" class="app-header">
      <a href="#" class="back-link" @click.prevent="back">
        {{ backLabel }}
      </a>
    </header>
    <main>
      <router-view />
    </main>
  </div>
</template>

<style>
.app {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100vh;
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
}
</style>
