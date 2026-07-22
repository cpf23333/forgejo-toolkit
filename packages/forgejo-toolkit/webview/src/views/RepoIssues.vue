<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ForgejoIssue } from '../types/api';

const { t } = useI18n();

const props = defineProps<{
  instanceId: string;
  owner: string;
  repo: string;
  state: string;
  items: ForgejoIssue[];
  loading: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'openIssue', instanceId: string, owner: string, repo: string, index: number): void;
  (e: 'changeState', state: string): void;
  (e: 'openExternal', url: string): void;
}>();

const states = ['open', 'closed', 'all'];

const title = computed(() => `${props.owner}/${props.repo}`);

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

function openIssue(issue: ForgejoIssue) {
  emit('openIssue', props.instanceId, props.owner, props.repo, issue.number);
}
</script>

<template>
  <div class="repo-issues">
    <div class="list-header">
      <h2>{{ t('dashboard.repoIssues.title', { repo: title }) }}</h2>
      <div class="state-filter">
        <button
          v-for="s in states"
          :key="s"
          class="filter-button"
          :class="{ active: state === s }"
          @click="emit('changeState', s)"
        >
          {{ t(`dashboard.state.${s}`) }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="loading">{{ t('dashboard.loading') }}</div>
    <div v-else-if="error" class="error">{{ t('dashboard.error', { message: error }) }}</div>
    <div v-else-if="items.length" class="item-list">
      <div v-for="issue in items" :key="issue.id" class="item-card">
        <div class="item-title">
          <a href="#" @click.prevent="openIssue(issue)">#{{ issue.number }} {{ issue.title }}</a>
          <span class="issue-actions">
            <a href="#" :title="t('dashboard.actions.open')" @click.prevent="emit('openExternal', issue.html_url)">
              <svg class="icon-link" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path
                  d="M1.5 1.75a.25.25 0 0 1 .25-.25h6.5a.75.75 0 0 0 0-1.5h-6.5C.786 0 0 .784 0 1.75v12.5C0 15.216.784 16 1.75 16h12.5A1.75 1.75 0 0 0 16 14.25v-6.5a.75.75 0 0 0-1.5 0v6.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25V1.75zM12.5 0a.75.75 0 0 0 0 1.5h2.19L6.22 9.97a.75.75 0 1 0 1.06 1.06L15.5 2.56v2.19a.75.75 0 0 0 1.5 0v-3.5a.75.75 0 0 0-.75-.75h-3.5z"
                />
              </svg>
            </a>
          </span>
        </div>
        <div class="item-meta">
          <span :class="`state-${issue.state}`" class="state-badge">{{ issue.state }}</span>
          <img v-if="issue.user?.avatar_url" :src="issue.user.avatar_url" :alt="issue.user.login" class="user-avatar" />
          <span v-if="issue.user">{{ issue.user.login }}</span>
          <span>{{ formatDate(issue.updated_at) }}</span>
        </div>
      </div>
    </div>
    <div v-else class="empty-list">{{ t('dashboard.repoIssues.empty') }}</div>
  </div>
</template>

<style scoped>
.repo-issues {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.list-header h2 {
  margin: 0;
  font-size: 1.1rem;
}

.state-filter {
  display: flex;
  gap: 6px;
}

.filter-button {
  background: transparent;
  border: 1px solid var(--vscode-panel-border);
  color: var(--vscode-foreground);
  padding: 4px 10px;
  cursor: pointer;
  font-size: 0.85em;
  border-radius: 4px;
}

.filter-button:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
}

.filter-button.active {
  background-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}

.loading {
  color: var(--vscode-descriptionForeground);
}

.error {
  color: var(--vscode-testing-iconFailed);
}

.empty-list {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  padding: 12px 0;
}

.item-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.item-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  padding: 10px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.item-title {
  font-weight: 600;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.item-title a {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}

.item-title a:hover {
  text-decoration: underline;
}

.issue-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-left: auto;
}

.issue-actions a {
  color: var(--vscode-descriptionForeground);
  text-decoration: none;
  padding: 2px;
}

.issue-actions a:hover {
  color: var(--vscode-textLink-foreground);
}

.issue-actions a svg {
  width: 14px;
  height: 14px;
  display: block;
}

.item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.state-badge {
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 0.85em;
  font-weight: 600;
  text-transform: capitalize;
}

.state-open {
  background-color: var(--vscode-gitDecoration-untrackedResourceForeground, #28a745);
  color: #fff;
}

.state-closed {
  background-color: var(--vscode-gitDecoration-deletedResourceForeground, #d73a49);
  color: #fff;
}

.state-all {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.user-avatar {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  object-fit: cover;
}
</style>
