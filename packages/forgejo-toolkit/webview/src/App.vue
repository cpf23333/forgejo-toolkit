<script setup lang="ts">
import { computed } from 'vue';
import { useAppState, repoDetailKey } from './composables/useAppState';
import Dashboard from './views/Dashboard.vue';
import RepoDetail from './views/RepoDetail.vue';
import Settings from './views/Settings.vue';

const state = useAppState();

const selectedRepoDetail = computed(() =>
  state.selectedRepo.value
    ? state.repoDetails.value.get(
        repoDetailKey(
          state.selectedRepo.value.instanceId,
          state.selectedRepo.value.owner,
          state.selectedRepo.value.repo,
        ),
      )
    : undefined,
);
const selectedRepoLoading = computed(() =>
  state.selectedRepo.value
    ? (state.loading.value.get(
        repoDetailKey(
          state.selectedRepo.value.instanceId,
          state.selectedRepo.value.owner,
          state.selectedRepo.value.repo,
        ),
      ) ?? false)
    : false,
);
const selectedRepoError = computed(() =>
  state.selectedRepo.value
    ? state.errors.value.get(
        repoDetailKey(
          state.selectedRepo.value.instanceId,
          state.selectedRepo.value.owner,
          state.selectedRepo.value.repo,
        ),
      )
    : undefined,
);
</script>

<template>
  <div class="app">
    <header class="app-header">
      <a
        v-if="state.currentPage.value !== 'dashboard'"
        href="#"
        class="back-link"
        @click.prevent="state.backToDashboard"
      >
        {{ state.t('settings.backToDashboard') }}
      </a>
    </header>
    <main>
      <Dashboard
        v-if="state.currentPage.value === 'dashboard'"
        :instances="state.instances.value"
        :repositories="state.repositories.value"
        :my-issues="state.myIssues.value"
        :my-pull-requests="state.myPullRequests.value"
        :loading="state.loading.value"
        :errors="state.errors.value"
        @open-external="state.openExternal"
        @copy-to-clipboard="state.copyToClipboard"
        @open-repo="state.openRepoDetail"
        @load-repositories="state.loadRepositories"
        @load-my-issues="state.loadMyIssues"
        @load-my-pull-requests="state.loadMyPullRequests"
      />
      <RepoDetail
        v-else-if="state.currentPage.value === 'repoDetail' && state.selectedRepo.value"
        :instance-id="state.selectedRepo.value.instanceId"
        :owner="state.selectedRepo.value.owner"
        :repo="state.selectedRepo.value.repo"
        :detail="selectedRepoDetail"
        :loading="selectedRepoLoading"
        :error="selectedRepoError"
        @open-external="state.openExternal"
        @copy-to-clipboard="state.copyToClipboard"
        @preview-readme="state.previewReadme"
      />
      <Settings
        v-else
        :instances="state.instances.value"
        :locale="state.locale.value"
        :debug="state.debug.value"
        @test="state.testConnection"
        @save="state.saveInstance"
        @remove="state.removeInstance"
        @change-locale="state.changeLocale"
        @change-debug="state.changeDebug"
      />
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
