<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import DiffFileList from './DiffFileList.vue';
import type { ForgejoPullRequestCommit, ForgejoChangedFile } from '../types/api';

const { t } = useI18n();

interface Props {
  commits: ForgejoPullRequestCommit[];
  supportsMultiDiff?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  openDiff: [
    payload: { filename: string; status: string; previousFilename?: string; baseSha: string; headSha: string },
  ];
  openSelectedDiffs: [
    payload: {
      files: { filename: string; status: string; previous_filename?: string }[];
      baseSha: string;
      headSha: string;
    },
  ];
}>();

const expanded = ref<Set<string>>(new Set());

function firstLine(message?: string): string {
  if (!message) {
    return '';
  }
  return message.split('\n')[0];
}

function shortSha(sha?: string): string {
  return sha?.slice(0, 7) ?? '';
}

function commitFiles(commit: ForgejoPullRequestCommit): ForgejoChangedFile[] {
  return (commit.files ?? []).map((file) => ({
    filename: file.filename ?? '',
    status: file.status ?? 'modified',
    previous_filename: file.previous_filename,
  }));
}

function toggleCommit(sha: string) {
  const next = new Set(expanded.value);
  if (next.has(sha)) {
    next.delete(sha);
  } else {
    next.add(sha);
  }
  expanded.value = next;
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

function handleOpenDiff(commit: ForgejoPullRequestCommit, filename: string, status: string, previousFilename?: string) {
  const baseSha = commit.parents?.[0]?.sha ?? '';
  const headSha = commit.sha ?? '';
  emit('openDiff', { filename, status, previousFilename, baseSha, headSha });
}

function handleOpenSelectedDiffs(
  commit: ForgejoPullRequestCommit,
  files: { filename: string; status: string; previous_filename?: string }[],
) {
  const baseSha = commit.parents?.[0]?.sha ?? '';
  const headSha = commit.sha ?? '';
  emit('openSelectedDiffs', { files, baseSha, headSha });
}
</script>

<template>
  <div class="commit-diff-list">
    <div v-if="commits.length === 0" class="empty">{{ t('dashboard.detail.noChangedFiles') }}</div>
    <div v-for="commit in commits" :key="commit.sha" class="commit-item">
      <div
        class="commit-header"
        tabindex="0"
        @click="toggleCommit(commit.sha ?? '')"
        @keydown.enter="toggleCommit(commit.sha ?? '')"
        @keydown.space.prevent="toggleCommit(commit.sha ?? '')"
      >
        <span class="commit-toggle">{{ expanded.has(commit.sha ?? '') ? '▼' : '▶' }}</span>
        <span class="commit-message">{{ firstLine(commit.commit?.message) }}</span>
        <span class="commit-sha">{{ shortSha(commit.sha) }}</span>
        <span v-if="commit.author" class="commit-author">{{ commit.author.login }}</span>
        <span v-if="commit.created" class="commit-date">{{ formatDate(commit.created) }}</span>
      </div>
      <div v-if="expanded.has(commit.sha ?? '')" class="commit-files">
        <DiffFileList
          :files="commitFiles(commit)"
          :supports-multi-diff="props.supportsMultiDiff"
          @open-diff="
            (filename, status, previousFilename) => handleOpenDiff(commit, filename, status, previousFilename)
          "
          @open-selected-diffs="(files) => handleOpenSelectedDiffs(commit, files)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.commit-diff-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.empty {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.commit-item {
  display: flex;
  flex-direction: column;
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  overflow: hidden;
}

.commit-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  font-size: 0.9em;
  flex-wrap: wrap;
}

.commit-header:hover {
  background-color: var(--vscode-list-hoverBackground);
}

.commit-toggle {
  color: var(--vscode-descriptionForeground);
  font-size: 0.75em;
  width: 14px;
  text-align: center;
}

.commit-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vscode-foreground);
}

.commit-sha {
  font-family: var(--vscode-editor-font-family), monospace;
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
}

.commit-author {
  color: var(--vscode-foreground);
  font-weight: 500;
  font-size: 0.85em;
}

.commit-date {
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
}

.commit-files {
  padding: 0 10px 10px 32px;
}
</style>
