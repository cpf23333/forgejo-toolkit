<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const canGoBack = computed(() => route.path !== '/');
const backLabel = computed(() => t('app.back'));
const cacheKey = ref(0);

function back() {
  router.back();
}

function handleMessage(event: MessageEvent) {
  if (event.data?.command === 'openDashboard') {
    nextTick(() => {
      cacheKey.value++;
    });
  }
}

onMounted(() => {
  window.addEventListener('message', handleMessage);
});

onUnmounted(() => {
  window.removeEventListener('message', handleMessage);
});
</script>

<template>
  <div class="app">
    <header v-if="canGoBack" class="app-header">
      <a href="#" class="back-link" @click.prevent="back">
        {{ backLabel }}
      </a>
    </header>
    <main>
      <router-view v-slot="{ Component, route }">
        <keep-alive :max="10">
          <component :is="Component" :key="`${route.path}-${cacheKey}`" />
        </keep-alive>
      </router-view>
    </main>
  </div>
</template>

<style>
.app {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  overflow: hidden;
  box-sizing: border-box;
  padding: 16px;
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
</style>
