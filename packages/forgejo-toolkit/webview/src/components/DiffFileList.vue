<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ForgejoChangedFile } from '../types/api';

const { t } = useI18n();

interface Props {
  files: ForgejoChangedFile[];
  loading?: boolean;
  error?: string;
  supportsMultiDiff?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  openDiff: [filename: string];
  openAllDiffs: [];
}>();

function statusClass(status?: string): string {
  switch (status) {
    case 'added':
      return 'status-added';
    case 'removed':
      return 'status-removed';
    case 'renamed':
      return 'status-renamed';
    case 'modified':
    default:
      return 'status-modified';
  }
}

function statusText(status?: string): string {
  switch (status) {
    case 'added':
      return t('dashboard.detail.fileStatus.added');
    case 'removed':
      return t('dashboard.detail.fileStatus.removed');
    case 'renamed':
      return t('dashboard.detail.fileStatus.renamed');
    case 'modified':
    default:
      return t('dashboard.detail.fileStatus.modified');
  }
}

function displayName(file: ForgejoChangedFile): string {
  return file.filename ?? file.previous_filename ?? '';
}

function openDiff(filename?: string) {
  if (!filename) {
    return;
  }
  emit('openDiff', filename);
}

function openAllDiffs() {
  emit('openAllDiffs');
}
</script>

<template>
  <div class="diff-file-list">
    <div v-if="loading" class="loading">{{ t('dashboard.loading') }}</div>
    <div v-else-if="error" class="error">{{ t('dashboard.error', { message: error }) }}</div>
    <div v-else-if="props.files.length === 0" class="empty">
      {{ t('dashboard.detail.noChangedFiles') }}
    </div>
    <div v-else>
      <div v-if="props.supportsMultiDiff" class="file-list-actions">
        <a href="#" class="view-all-link" @click.prevent="openAllDiffs">
          {{ t('dashboard.detail.viewAllDiffs') }}
        </a>
      </div>
      <ul class="file-list">
        <li v-for="file in props.files" :key="file.filename ?? file.previous_filename" class="file-item">
          <span class="file-name">
            {{ displayName(file) }}
            <span v-if="file.previous_filename && file.filename" class="rename-arrow">←</span>
          </span>
          <span class="file-status" :class="statusClass(file.status)">{{ statusText(file.status) }}</span>
          <span v-if="file.additions !== undefined || file.deletions !== undefined" class="file-stats">
            <span v-if="file.additions" class="additions">+{{ file.additions }}</span>
            <span v-if="file.deletions" class="deletions">−{{ file.deletions }}</span>
          </span>
          <a href="#" class="view-diff-link" @click.prevent="openDiff(file.filename)">
            {{ t('dashboard.detail.viewDiff') }}
          </a>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.diff-file-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.loading,
.empty {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
}

.file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
  font-size: 0.9em;
  flex-wrap: wrap;
}

.file-name {
  flex: 1 1 auto;
  word-break: break-all;
  color: var(--vscode-foreground);
}

.rename-arrow {
  color: var(--vscode-descriptionForeground);
  margin-left: 4px;
}

.file-status {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 0.75em;
  text-transform: capitalize;
  font-weight: 500;
}

.status-added {
  background-color: var(--vscode-gitDecoration-addedResourceForeground, #28a745);
  color: #fff;
}

.status-removed {
  background-color: var(--vscode-gitDecoration-deletedResourceForeground, #d73a49);
  color: #fff;
}

.status-modified {
  background-color: var(--vscode-gitDecoration-modifiedResourceForeground, #d7ba7d);
  color: #000;
}

.status-renamed {
  background-color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991);
  color: #000;
}

.file-stats {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  font-size: 0.85em;
}

.additions {
  color: var(--vscode-gitDecoration-addedResourceForeground, #28a745);
}

.deletions {
  color: var(--vscode-gitDecoration-deletedResourceForeground, #d73a49);
}

.file-list-actions {
  display: flex;
  justify-content: flex-end;
}

.view-all-link {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  font-size: 0.85em;
}

.view-all-link:hover {
  text-decoration: underline;
}

.view-diff-link {
  flex-shrink: 0;
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  font-size: 0.85em;
}

.view-diff-link:hover {
  text-decoration: underline;
}
</style>
