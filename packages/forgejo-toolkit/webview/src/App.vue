<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { VscodeButton } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';
import { vscode } from './composables/vscode';

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

function openOnboarding() {
  vscode.postMessage({ command: 'openOnboardingPanel' });
}

const repoContextNames = ['repoDetail', 'repoIssues', 'repoPullRequests'];

const isRepoContext = computed(() => repoContextNames.includes(String(route.name)));
const isOnboarding = computed(() => false);
const canGoBack = computed(() => route.path !== '/');
const backLabel = computed(() =>
  isRepoContext.value ? t('settings.backToRepoDetail') : t('settings.backToDashboard'),
);

function back() {
  router.back();
}
</script>

<template>
  <div class="app">
    <header class="app-header">
      <a v-if="canGoBack" href="#" class="back-link" @click.prevent="back">
        {{ backLabel }}
      </a>
      <VscodeButton
        v-if="!isOnboarding"
        class="onboarding-button"
        variant="icon"
        :title="t('app.openOnboarding')"
        @click="openOnboarding"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path
            d="M8.5 2.687c.654-.689 1.782-.886 3.112-.752 1.234.124 2.503.523 3.388.893v9.923c-.918-.35-2.107-.692-3.287-.81-1.094-.111-2.278-.039-3.213.492V2.687zM8 1.783C7.015.936 5.587.81 4.287.94c-1.514.153-3.042.672-3.994 1.105A.5.5 0 0 0 0 2.5v11a.5.5 0 0 0 .707.455c.882-.4 2.303-.88 3.68-1.02 1.409-.142 2.59.087 3.223.877a.5.5 0 0 0 .78 0c.633-.79 1.814-1.019 3.222-.877 1.378.14 2.8.62 3.681 1.02A.5.5 0 0 0 16 13.5v-11a.5.5 0 0 0-.293-.455c-.952-.433-2.48-.952-3.994-1.105C10.413.809 8.985.936 8 1.783z"
          />
        </svg>
      </VscodeButton>
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
  justify-content: space-between;
  gap: 8px;
}

.onboarding-button svg {
  width: 16px;
  height: 16px;
  display: block;
}

.app-header h1 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
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
