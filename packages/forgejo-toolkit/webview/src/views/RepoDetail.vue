<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { VscodeButton } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';
import { useAppState, repoDetailKey } from '../composables/useAppState';
import type { ForgejoCommit } from '../types/api';

const { t } = useI18n();
const route = useRoute();
const state = useAppState();

const instanceId = computed(() => String(route.params.instanceId));
const owner = computed(() => String(route.params.owner));
const repo = computed(() => String(route.params.repo));
const key = computed(() => repoDetailKey(instanceId.value, owner.value, repo.value));

const detail = computed(() => state.repoDetails.value.get(key.value));
const loading = computed(() => state.loading.value.get(key.value) ?? false);
const error = computed(() => state.errors.value.get(key.value));

watch(
  [instanceId, owner, repo],
  () => {
    state.openRepoDetail(instanceId.value, owner.value, repo.value);
  },
  { immediate: true },
);

const repoUrl = computed(() => detail.value?.repository.html_url ?? '');
const cloneUrl = computed(() => (repoUrl.value ? `${repoUrl.value}.git` : ''));

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
</script>

<template>
  <div class="repo-detail">
    <div v-if="loading" class="loading">{{ t('dashboard.loading') }}</div>
    <div v-else-if="error" class="error">{{ t('dashboard.error', { message: error }) }}</div>
    <div v-else-if="detail" class="detail-content">
      <div class="repo-header">
        <h2>{{ detail.repository.full_name }}</h2>
        <p v-if="detail.repository.description" class="description">{{ detail.repository.description }}</p>
        <div class="meta">
          <span>{{ t('dashboard.owner') }}: {{ detail.repository.owner.login }}</span>
          <span>{{ t('dashboard.branch') }}: {{ detail.repository.default_branch }}</span>
          <span>{{ t('dashboard.stars') }}: {{ detail.repository.stars_count }}</span>
          <span>{{ t('dashboard.forks') }}: {{ detail.repository.forks_count }}</span>
          <span>{{ t('dashboard.openIssues') }}: {{ detail.repository.open_issues_count }}</span>
        </div>
        <div class="actions">
          <VscodeButton variant="secondary" @click="state.openExternal(repoUrl)">{{
            t('dashboard.actions.open')
          }}</VscodeButton>
          <VscodeButton variant="secondary" @click="state.copyToClipboard(cloneUrl)">{{
            t('dashboard.actions.copyClone')
          }}</VscodeButton>
          <VscodeButton variant="secondary" @click="state.copyToClipboard(repoUrl)">{{
            t('dashboard.actions.copyUrl')
          }}</VscodeButton>
          <VscodeButton variant="secondary" @click="state.openRepoIssues(instanceId, owner, repo)"
            >{{ t('dashboard.openIssues') }} ({{ detail.repository.open_issues_count }})</VscodeButton
          >
          <VscodeButton variant="secondary" @click="state.openRepoPullRequests(instanceId, owner, repo)"
            >{{ t('dashboard.openPullRequests') }} ({{ detail.repository.open_pr_counter ?? 0 }})</VscodeButton
          >
          <VscodeButton
            v-if="detail.readme"
            variant="secondary"
            @click="state.previewReadme(owner, repo, detail.readme)"
            >{{ t('dashboard.actions.previewReadme') }}</VscodeButton
          >
        </div>
      </div>

      <section v-if="detail.empty" class="section">
        <div class="empty-repo">{{ t('dashboard.emptyRepository') }}</div>
      </section>

      <section v-if="detail.branches.length" class="section">
        <h3>{{ t('dashboard.branches') }}</h3>
        <div class="tag-list">
          <span
            v-for="branch in detail.branches"
            :key="branch"
            class="tag"
            :class="{ 'tag-primary': branch === detail.repository.default_branch }"
          >
            {{ branch }}
            <span v-if="branch === detail.repository.default_branch" class="default-badge">
              {{ t('dashboard.defaultBranch') }}
            </span>
          </span>
        </div>
      </section>

      <section v-if="detail.recentCommits.length" class="section">
        <h3>{{ t('dashboard.recentCommits') }}</h3>
        <div class="commit-list">
          <div v-for="commit in detail.recentCommits" :key="commit.sha" class="commit-item">
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
            <a href="#" class="commit-sha" @click.prevent="state.openExternal(commit.html_url)">{{
              commit.sha.slice(0, 7)
            }}</a>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.repo-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.loading {
  color: var(--vscode-descriptionForeground);
}

.error {
  color: var(--vscode-testing-iconFailed);
}

.detail-content {
  display: flex;
  flex-direction: column;
  gap: 24px;
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

.actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
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
  gap: 12px;
  align-items: center;
  font-size: 0.85em;
  white-space: nowrap;
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
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  padding: 12px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
}
</style>
