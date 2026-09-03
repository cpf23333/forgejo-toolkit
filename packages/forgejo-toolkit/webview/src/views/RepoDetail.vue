<script setup lang="ts">
import { computed, onActivated, onDeactivated, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAppState, repoBranchCommitsKey, repoDetailKey } from '../composables/useAppState';
import RepoActions from '../components/RepoActions.vue';
import RepoFileBrowser from '../components/RepoFileBrowser.vue';
import RepoRefs from '../components/RepoRefs.vue';
import ViewTabs from '../components/ViewTabs.vue';
import type { ForgejoCommit } from '../types/api';

const { t } = useI18n();
const route = useRoute();
const state = useAppState();

const instanceId = computed(() => String(route.params.instanceId));
const owner = computed(() => String(route.params.owner));
const repo = computed(() => String(route.params.repo));
const key = computed(() => repoDetailKey(instanceId.value, owner.value, repo.value));

const detail = computed(() => state.repoDetails.value.get(key.value));
const loading = computed(() => state.loading.get(key.value) ?? false);
const error = computed(() => state.errors.get(key.value));
const baseUrl = computed(() => state.instances.value.find((i) => i.id === instanceId.value)?.url);

// Under keep-alive this view is deactivated (not unmounted) when navigating
// away; `route.params` then tracks the global route, not this view's own
// route. Guard route-driven loading on isActive.
const isActive = ref(true);
onActivated(() => {
  isActive.value = true;
  // Params may have changed back before this hook ran; make sure data for the
  // current route is loaded (the loader dedups via its cache).
  state.loadRepoDetail(instanceId.value, owner.value, repo.value);
});
onDeactivated(() => {
  isActive.value = false;
});

watch(
  [instanceId, owner, repo],
  () => {
    if (!isActive.value) {
      return;
    }
    state.loadRepoDetail(instanceId.value, owner.value, repo.value);
  },
  { immediate: true },
);

const repoUrl = computed(() => detail.value?.repository.html_url ?? '');
const cloneUrl = computed(() => (repoUrl.value ? `${repoUrl.value}.git` : ''));
const hasIssues = computed(() => !detail.value?.repository.mirror && detail.value?.repository.has_issues !== false);
const hasPullRequests = computed(
  () => !detail.value?.repository.mirror && detail.value?.repository.has_pull_requests !== false,
);

const selectedBranch = ref(detail.value?.repository.default_branch ?? '');
const activeTab = ref<'overview' | 'files' | 'refs' | 'actions'>('overview');

watch(
  () => detail.value?.repository.default_branch,
  (defaultBranch) => {
    if (defaultBranch && !selectedBranch.value) {
      selectedBranch.value = defaultBranch;
    }
  },
);

const recentCommits = computed(() => {
  const key = repoBranchCommitsKey(instanceId.value, owner.value, repo.value, selectedBranch.value);
  return state.repoBranchCommits.value.get(key) ?? detail.value?.recentCommits ?? [];
});

const recentCommitsLoading = computed(() => {
  const key = repoBranchCommitsKey(instanceId.value, owner.value, repo.value, selectedBranch.value);
  return state.loading.get(key) ?? false;
});

function onBranchChange(event: Event) {
  const target = event.target as HTMLInputElement | null;
  const value = target?.value;
  if (value) {
    selectedBranch.value = value;
    state.loadRepoBranchCommits(instanceId.value, owner.value, repo.value, value);
  }
}

function onSelectBranch(branch: string) {
  selectedBranch.value = branch;
  activeTab.value = 'files';
  state.loadRepoBranchCommits(instanceId.value, owner.value, repo.value, branch);
}

function commitMessage(message: string): string {
  return message.split('\n')[0];
}

function formatDate(date: string): string {
  try {
    const d = new Date(date);
    const now = Date.now();
    const diff = now - d.getTime();
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const month = 30 * day;
    const year = 365 * day;

    if (diff < minute) {
      return t('dashboard.timeAgo.justNow');
    }
    if (diff < hour) {
      return t('dashboard.timeAgo.minutes', { count: Math.floor(diff / minute) });
    }
    if (diff < day) {
      return t('dashboard.timeAgo.hours', { count: Math.floor(diff / hour) });
    }
    if (diff < month) {
      return t('dashboard.timeAgo.days', { count: Math.floor(diff / day) });
    }
    if (diff < year) {
      return t('dashboard.timeAgo.months', { count: Math.floor(diff / month) });
    }
    return t('dashboard.timeAgo.years', { count: Math.floor(diff / year) });
  } catch {
    return date;
  }
}

function committerAvatar(commit: ForgejoCommit): string | undefined {
  return commit.committer?.avatar_url ?? commit.author?.avatar_url;
}

function committerName(commit: ForgejoCommit): string {
  return commit.committer?.login ?? commit.author?.login ?? commit.commit.author.name;
}

function reloadRepo() {
  state.repoDetails.value.delete(key.value);
  state.loadRepoDetail(instanceId.value, owner.value, repo.value);
}
</script>

<template>
  <div class="repo-detail">
    <div v-if="loading" class="loading-state">
      <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
    </div>
    <div v-else-if="error" class="error-state">
      <span>{{ t('dashboard.error', { message: error }) }}</span>
      <vscode-button icon="refresh" @click="reloadRepo" secondary>
        {{ t('dashboard.retry') }}
      </vscode-button>
    </div>
    <div v-else-if="detail" class="detail-content">
      <div class="repo-header">
        <h2>{{ detail.repository.full_name }}</h2>
        <p v-if="detail.repository.description" class="description">{{ detail.repository.description }}</p>
        <div class="meta">
          <span class="meta-item" :title="t('dashboard.owner')">
            <vscode-icon name="account" class="meta-icon" />
            {{ detail.repository.owner.login }}
          </span>
          <span class="meta-item" :title="t('dashboard.branch')">
            <vscode-icon name="git-branch" class="meta-icon" />
            {{ detail.repository.default_branch }}
          </span>
          <span class="meta-item" :title="t('dashboard.stars')">
            <vscode-icon name="star-full" class="meta-icon" />
            {{ detail.repository.stars_count }}
          </span>
          <span class="meta-item" :title="t('dashboard.forks')">
            <vscode-icon name="repo-forked" class="meta-icon" />
            {{ detail.repository.forks_count }}
          </span>
          <button
            v-if="hasIssues"
            type="button"
            class="meta-item meta-link link-button"
            :title="t('dashboard.openIssues')"
            @click="state.openRepoIssues(instanceId, owner, repo)"
          >
            <vscode-icon name="issues" class="meta-icon" />
            {{ detail.repository.open_issues_count }}
          </button>
          <button
            v-if="hasPullRequests"
            type="button"
            class="meta-item meta-link link-button"
            :title="t('dashboard.openPullRequests')"
            @click="state.openRepoPullRequests(instanceId, owner, repo)"
          >
            <vscode-icon name="git-pull-request" class="meta-icon" />
            {{ detail.repository.open_pr_counter ?? 0 }}
          </button>
        </div>
        <div class="actions">
          <div class="action-group primary-actions">
            <vscode-button icon="link-external" @click="state.openExternal(repoUrl)" secondary>
              {{ t('dashboard.actions.open') }}
            </vscode-button>
            <vscode-button
              v-if="detail.readme"
              icon="preview"
              @click="state.previewReadme(owner, repo, detail.readme)"
              secondary
            >
              {{ t('dashboard.actions.previewReadme') }}
            </vscode-button>
          </div>
          <div class="action-group secondary-actions">
            <vscode-button
              icon="copy"
              :title="t('dashboard.actions.copyClone')"
              :aria-label="t('dashboard.actions.copyClone')"
              @click="state.copyToClipboard(cloneUrl)"
              icon-only
            />
            <vscode-button
              icon="link"
              :title="t('dashboard.actions.copyUrl')"
              :aria-label="t('dashboard.actions.copyUrl')"
              @click="state.copyToClipboard(repoUrl)"
              icon-only
            />
          </div>
        </div>
      </div>

      <ViewTabs
        v-model="activeTab"
        :tabs="[
          { key: 'overview', label: t('dashboard.overview') },
          { key: 'files', label: t('dashboard.files') },
          { key: 'refs', label: t('dashboard.refs') },
          { key: 'actions', label: t('dashboard.tabs.actions') },
        ]"
      />

      <div class="tab-content">
        <div v-if="activeTab === 'overview'" class="tab-pane overview-pane">
          <section v-if="detail.empty" class="section">
            <div class="empty-repo">
              <p>{{ t('dashboard.emptyRepository') }}</p>
              <vscode-button icon="link-external" @click="state.openExternal(repoUrl)" secondary>
                {{ t('dashboard.actions.open') }}
              </vscode-button>
            </div>
          </section>

          <section v-if="detail.branches.length" class="section">
            <h3>{{ t('dashboard.branches') }}</h3>
            <vscode-single-select filter="fuzzy" :value="selectedBranch" class="branch-select" @change="onBranchChange">
              <vscode-option
                v-for="branch in detail.branches"
                :key="branch"
                :value="branch"
                :selected="branch === detail.repository.default_branch"
              >
                {{ branch }}
                <span v-if="branch === detail.repository.default_branch" class="default-badge">
                  {{ t('dashboard.defaultBranch') }}
                </span>
              </vscode-option>
            </vscode-single-select>
          </section>

          <section v-if="recentCommits.length || recentCommitsLoading" class="section">
            <h3>{{ t('dashboard.recentCommits') }}</h3>
            <div v-if="recentCommitsLoading" class="loading">{{ t('dashboard.loading') }}</div>
            <div v-else class="commit-list">
              <div v-for="commit in recentCommits" :key="commit.sha" class="commit-item">
                <span class="commit-message">{{ commitMessage(commit.commit.message) }}</span>
                <span class="commit-info">
                  <img
                    v-if="committerAvatar(commit)"
                    :src="committerAvatar(commit)"
                    :alt="committerName(commit)"
                    class="commit-avatar"
                  />
                  <span class="commit-author">{{ committerName(commit) }}</span>
                  <span class="commit-date">{{ formatDate(commit.commit.author.date) }}</span>
                </span>
                <button type="button" class="commit-sha link-button" @click="state.openExternal(commit.html_url)">
                  {{ commit.sha.slice(0, 7) }}
                </button>
              </div>
            </div>
          </section>
        </div>

        <div v-if="activeTab === 'files'" class="tab-pane files-tab">
          <RepoFileBrowser
            :instance-id="instanceId"
            :owner="owner"
            :repo="repo"
            :branches="detail.branches"
            :default-branch="detail.repository.default_branch"
            :branch="selectedBranch"
          />
        </div>

        <div v-if="activeTab === 'refs'" class="tab-pane refs-tab">
          <RepoRefs
            :instance-id="instanceId"
            :owner="owner"
            :repo="repo"
            :default-branch="detail.repository.default_branch"
            @select-branch="onSelectBranch"
          />
        </div>

        <div v-if="activeTab === 'actions'" class="tab-pane actions-tab">
          <RepoActions
            :instance-id="instanceId"
            :owner="owner"
            :repo="repo"
            :default-branch="detail.repository.default_branch"
            :branches="detail.branches"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.repo-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  overflow: hidden;
}

.loading-state,
.error-state {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-descriptionForeground);
}

.error-state {
  flex-wrap: wrap;
}

.detail-content {
  display: flex;
  flex-direction: column;
  gap: 24px;
  height: 100%;
  overflow: hidden;
}

.repo-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.repo-header h2 {
  margin: 0;
  font-size: 1.1rem;
}

.description {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.meta-icon {
  color: var(--vscode-foreground);
}

.meta-link {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  cursor: pointer;
}

.meta-link:hover {
  text-decoration: underline;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}

.action-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.secondary-actions {
  gap: 4px;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section h3 {
  margin: 0;
  font-size: 1rem;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 0.8em;
}

.tag-primary {
  background-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.default-badge {
  margin-left: 4px;
  padding: 0 4px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 0.75em;
  opacity: 0.9;
}

.commit-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.commit-item {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  font-size: 0.85em;
  overflow: hidden;
  padding: 4px 6px;
  border-radius: 4px;
  transition: background-color 0.1s;
}

.commit-item:hover {
  background-color: var(--vscode-list-hoverBackground);
}

.commit-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-info {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 0;
  color: var(--vscode-descriptionForeground);
}

.commit-avatar {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.commit-author {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100px;
}

.commit-date {
  font-size: 0.9em;
  flex-shrink: 0;
}

.commit-sha {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  font-family: var(--vscode-editor-font-family), monospace;
  font-size: 0.85em;
  flex-shrink: 0;
}

.commit-sha:hover {
  text-decoration: underline;
}

.empty-repo {
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  padding: 12px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
}

.empty-repo p {
  margin: 0;
}

.branch-select {
  width: 100%;
}

.detail-loading-ring {
  width: 16px;
  height: 16px;
  vertical-align: middle;
}

.tab-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.tab-pane {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.files-tab {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.refs-tab {
  min-height: 0;
  overflow: auto;
}

.actions-tab {
  min-height: 0;
  overflow: auto;
}
</style>
