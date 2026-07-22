<script setup lang="ts">
import { computed } from 'vue';
import {
  useAppState,
  repoDetailKey,
  issueDetailKey,
  pullRequestDetailKey,
  repoIssuesKey,
  repoPullRequestsKey,
} from './composables/useAppState';
import Dashboard from './views/Dashboard.vue';
import RepoDetail from './views/RepoDetail.vue';
import RepoIssues from './views/RepoIssues.vue';
import RepoPullRequests from './views/RepoPullRequests.vue';
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
const selectedIssueBaseUrl = computed(() => {
  if (!state.selectedIssue.value) {
    return undefined;
  }
  return state.instances.value.find((i) => i.id === state.selectedIssue.value!.instanceId)?.url;
});

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
const selectedPullRequestBaseUrl = computed(() => {
  if (!state.selectedPullRequest.value) {
    return undefined;
  }
  return state.instances.value.find((i) => i.id === state.selectedPullRequest.value!.instanceId)?.url;
});
const repoDetailPages = ['repoDetail', 'repoIssues', 'repoPullRequests'];

const isRepoContext = computed(() => repoDetailPages.includes(state.currentPage.value));

const backLabel = computed(() =>
  isRepoContext.value ? state.t('settings.backToRepoDetail') : state.t('settings.backToDashboard'),
);

function renderIssueMarkdown(text: string, context: string): Promise<string> {
  if (!state.selectedIssue.value) {
    return Promise.reject(new Error('No issue selected'));
  }
  return state.renderMarkdown(state.selectedIssue.value.instanceId, text, context);
}

function renderPullRequestMarkdown(text: string, context: string): Promise<string> {
  if (!state.selectedPullRequest.value) {
    return Promise.reject(new Error('No pull request selected'));
  }
  return state.renderMarkdown(state.selectedPullRequest.value.instanceId, text, context);
}

function back() {
  if (isRepoContext.value) {
    state.backToRepoDetail();
  } else {
    state.backToDashboard();
  }
}

const selectedRepoIssues = computed(() =>
  state.selectedRepoIssues.value
    ? state.repoIssues.value.get(
        repoIssuesKey(
          state.selectedRepoIssues.value.instanceId,
          state.selectedRepoIssues.value.owner,
          state.selectedRepoIssues.value.repo,
          state.selectedRepoIssues.value.state,
        ),
      )
    : undefined,
);
const selectedRepoIssuesLoading = computed(() =>
  state.selectedRepoIssues.value
    ? (state.loading.value.get(
        repoIssuesKey(
          state.selectedRepoIssues.value.instanceId,
          state.selectedRepoIssues.value.owner,
          state.selectedRepoIssues.value.repo,
          state.selectedRepoIssues.value.state,
        ),
      ) ?? false)
    : false,
);
const selectedRepoIssuesError = computed(() =>
  state.selectedRepoIssues.value
    ? state.errors.value.get(
        repoIssuesKey(
          state.selectedRepoIssues.value.instanceId,
          state.selectedRepoIssues.value.owner,
          state.selectedRepoIssues.value.repo,
          state.selectedRepoIssues.value.state,
        ),
      )
    : undefined,
);

const selectedRepoPullRequests = computed(() =>
  state.selectedRepoPullRequests.value
    ? state.repoPullRequests.value.get(
        repoPullRequestsKey(
          state.selectedRepoPullRequests.value.instanceId,
          state.selectedRepoPullRequests.value.owner,
          state.selectedRepoPullRequests.value.repo,
          state.selectedRepoPullRequests.value.state,
        ),
      )
    : undefined,
);
const selectedRepoPullRequestsLoading = computed(() =>
  state.selectedRepoPullRequests.value
    ? (state.loading.value.get(
        repoPullRequestsKey(
          state.selectedRepoPullRequests.value.instanceId,
          state.selectedRepoPullRequests.value.owner,
          state.selectedRepoPullRequests.value.repo,
          state.selectedRepoPullRequests.value.state,
        ),
      ) ?? false)
    : false,
);
const selectedRepoPullRequestsError = computed(() =>
  state.selectedRepoPullRequests.value
    ? state.errors.value.get(
        repoPullRequestsKey(
          state.selectedRepoPullRequests.value.instanceId,
          state.selectedRepoPullRequests.value.owner,
          state.selectedRepoPullRequests.value.repo,
          state.selectedRepoPullRequests.value.state,
        ),
      )
    : undefined,
);
</script>

<template>
  <div class="app">
    <header class="app-header">
      <a v-if="state.currentPage.value !== 'dashboard'" href="#" class="back-link" @click.prevent="back">
        {{ backLabel }}
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
        @open-repo-issues="state.openRepoIssues"
        @open-repo-pull-requests="state.openRepoPullRequests"
      />
      <RepoIssues
        v-else-if="state.currentPage.value === 'repoIssues' && state.selectedRepoIssues.value"
        :instance-id="state.selectedRepoIssues.value.instanceId"
        :owner="state.selectedRepoIssues.value.owner"
        :repo="state.selectedRepoIssues.value.repo"
        :state="state.selectedRepoIssues.value.state"
        :items="selectedRepoIssues ?? []"
        :loading="selectedRepoIssuesLoading"
        :error="selectedRepoIssuesError"
        @open-issue="state.openIssueDetail"
        @change-state="state.changeRepoIssuesState"
        @open-external="state.openExternal"
      />
      <RepoPullRequests
        v-else-if="state.currentPage.value === 'repoPullRequests' && state.selectedRepoPullRequests.value"
        :instance-id="state.selectedRepoPullRequests.value.instanceId"
        :owner="state.selectedRepoPullRequests.value.owner"
        :repo="state.selectedRepoPullRequests.value.repo"
        :state="state.selectedRepoPullRequests.value.state"
        :items="selectedRepoPullRequests ?? []"
        :loading="selectedRepoPullRequestsLoading"
        :error="selectedRepoPullRequestsError"
        @open-pull-request="state.openPullRequestDetail"
        @change-state="state.changeRepoPullRequestsState"
        @open-external="state.openExternal"
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
        :base-url="selectedIssueBaseUrl"
        :render-markdown-fn="renderIssueMarkdown"
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
        :base-url="selectedPullRequestBaseUrl"
        :render-markdown-fn="renderPullRequestMarkdown"
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
