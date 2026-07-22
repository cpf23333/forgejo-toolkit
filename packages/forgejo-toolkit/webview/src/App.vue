<script setup lang="ts">
import { computed } from 'vue';
import { useAppState, repoDetailKey, issueDetailKey, pullRequestDetailKey } from './composables/useAppState';
import Dashboard from './views/Dashboard.vue';
import RepoDetail from './views/RepoDetail.vue';
import IssueDetail from './views/IssueDetail.vue';
import PullRequestDetail from './views/PullRequestDetail.vue';
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

const selectedIssueDetail = computed(() =>
  state.selectedIssue.value
    ? state.issueDetails.value.get(
        issueDetailKey(
          state.selectedIssue.value.instanceId,
          state.selectedIssue.value.owner,
          state.selectedIssue.value.repo,
          state.selectedIssue.value.index,
        ),
      )
    : undefined,
);
const selectedIssueLoading = computed(() =>
  state.selectedIssue.value
    ? (state.loading.value.get(
        issueDetailKey(
          state.selectedIssue.value.instanceId,
          state.selectedIssue.value.owner,
          state.selectedIssue.value.repo,
          state.selectedIssue.value.index,
        ),
      ) ?? false)
    : false,
);
const selectedIssueError = computed(() =>
  state.selectedIssue.value
    ? state.errors.value.get(
        issueDetailKey(
          state.selectedIssue.value.instanceId,
          state.selectedIssue.value.owner,
          state.selectedIssue.value.repo,
          state.selectedIssue.value.index,
        ),
      )
    : undefined,
);

const selectedPullRequestDetail = computed(() =>
  state.selectedPullRequest.value
    ? state.pullRequestDetails.value.get(
        pullRequestDetailKey(
          state.selectedPullRequest.value.instanceId,
          state.selectedPullRequest.value.owner,
          state.selectedPullRequest.value.repo,
          state.selectedPullRequest.value.index,
        ),
      )
    : undefined,
);
const selectedPullRequestLoading = computed(() =>
  state.selectedPullRequest.value
    ? (state.loading.value.get(
        pullRequestDetailKey(
          state.selectedPullRequest.value.instanceId,
          state.selectedPullRequest.value.owner,
          state.selectedPullRequest.value.repo,
          state.selectedPullRequest.value.index,
        ),
      ) ?? false)
    : false,
);
const selectedPullRequestError = computed(() =>
  state.selectedPullRequest.value
    ? state.errors.value.get(
        pullRequestDetailKey(
          state.selectedPullRequest.value.instanceId,
          state.selectedPullRequest.value.owner,
          state.selectedPullRequest.value.repo,
          state.selectedPullRequest.value.index,
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
        @open-issue="state.openIssueDetail"
        @open-pull-request="state.openPullRequestDetail"
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
      <IssueDetail
        v-else-if="state.currentPage.value === 'issueDetail' && state.selectedIssue.value"
        :instance-id="state.selectedIssue.value.instanceId"
        :owner="state.selectedIssue.value.owner"
        :repo="state.selectedIssue.value.repo"
        :index="state.selectedIssue.value.index"
        :detail="selectedIssueDetail"
        :loading="selectedIssueLoading"
        :error="selectedIssueError"
        @open-external="state.openExternal"
        @copy-to-clipboard="state.copyToClipboard"
      />
      <PullRequestDetail
        v-else-if="state.currentPage.value === 'pullRequestDetail' && state.selectedPullRequest.value"
        :instance-id="state.selectedPullRequest.value.instanceId"
        :owner="state.selectedPullRequest.value.owner"
        :repo="state.selectedPullRequest.value.repo"
        :index="state.selectedPullRequest.value.index"
        :detail="selectedPullRequestDetail"
        :loading="selectedPullRequestLoading"
        :error="selectedPullRequestError"
        @open-external="state.openExternal"
        @copy-to-clipboard="state.copyToClipboard"
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
