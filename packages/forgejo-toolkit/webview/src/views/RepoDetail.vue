<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ForgejoRepoDetail } from '../types/api';
import { repoDetailKey } from '../composables/useAppState';

const { t } = useI18n();

const props = defineProps<{
  instanceId: string;
  owner: string;
  repo: string;
  detail?: ForgejoRepoDetail;
  loading: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'openExternal', url: string): void;
  (e: 'copyToClipboard', text: string): void;
}>();

const repoUrl = computed(() => props.detail?.repository.html_url ?? '');
const cloneUrl = computed(() => (repoUrl.value ? `${repoUrl.value}.git` : ''));

function commitMessage(message: string): string {
  return message.split('\n')[0];
}

function formatDate(date: string): string {
  try {
    return new Date(date).toLocaleString();
  } catch {
    return date;
  }
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
          <vscode-button variant="secondary" @click="emit('openExternal', repoUrl)">{{
            t('dashboard.actions.open')
          }}</vscode-button>
          <vscode-button variant="secondary" @click="emit('copyToClipboard', cloneUrl)">{{
            t('dashboard.actions.copyClone')
          }}</vscode-button>
          <vscode-button variant="secondary" @click="emit('copyToClipboard', repoUrl)">{{
            t('dashboard.actions.copyUrl')
          }}</vscode-button>
        </div>
      </div>

      <section v-if="detail.branches.length" class="section">
        <h3>{{ t('dashboard.branches') }}</h3>
        <div class="tag-list">
          <span v-for="branch in detail.branches" :key="branch" class="tag">{{ branch }}</span>
        </div>
      </section>

      <section v-if="detail.recentCommits.length" class="section">
        <h3>{{ t('dashboard.recentCommits') }}</h3>
        <div class="commit-list">
          <div v-for="commit in detail.recentCommits" :key="commit.sha" class="commit-item">
            <a href="#" @click.prevent="emit('openExternal', commit.html_url)">{{ commit.sha.slice(0, 7) }}</a>
            <span class="commit-message">{{ commitMessage(commit.commit.message) }}</span>
            <span class="commit-author">{{ commit.commit.author.name }}</span>
            <span class="commit-date">{{ formatDate(commit.commit.author.date) }}</span>
          </div>
        </div>
      </section>

      <section v-if="detail.readme" class="section">
        <h3>{{ t('dashboard.readme') }}</h3>
        <pre class="readme">{{ detail.readme }}</pre>
      </section>
      <div v-else class="no-readme">{{ t('dashboard.noReadme') }}</div>
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

.commit-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.commit-item {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 0.85em;
  flex-wrap: wrap;
}

.commit-item a {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}

.commit-message {
  flex: 1;
  min-width: 120px;
}

.commit-author {
  color: var(--vscode-descriptionForeground);
}

.commit-date {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.readme {
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  padding: 12px;
  border-radius: 4px;
  overflow: auto;
  font-size: 0.85em;
  line-height: 1.5;
}

.no-readme {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}
</style>
