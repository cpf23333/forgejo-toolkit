<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ModalDialog from './ModalDialog.vue';
import { useAppState, fileHistoryKey } from '../composables/useAppState';
import type { ForgejoCommit } from '../types/api';

interface Props {
  open: boolean;
  instanceId: string;
  owner: string;
  repo: string;
  path: string;
  branchRef: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  viewDiff: [path: string, baseRef: string, headRef: string];
  openVersion: [path: string, ref: string];
}>();

const { t } = useI18n();
const state = useAppState();

const key = computed(() => fileHistoryKey(props.instanceId, props.owner, props.repo, props.path, props.branchRef));
const commits = computed(() => state.fileHistories.value.get(key.value) ?? []);
const loading = computed(() => state.loading.get(key.value) ?? false);
const error = computed(() => state.errors.get(key.value));

watch(
  () => props.open,
  (open) => {
    if (open) {
      state.loadFileHistory(props.instanceId, props.owner, props.repo, props.path, props.branchRef);
    }
  },
  { immediate: true },
);

function formatDate(dateString: string): string {
  if (!dateString) {
    return '';
  }
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return dateString;
  }
  return date.toLocaleString();
}

function truncateMessage(message: string): string {
  const firstLine = message.split('\n')[0] ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

function onItemClick(commit: ForgejoCommit) {
  const parentSha = commit.parents?.[0]?.sha;
  const fileChange = commit.files?.find((file) => file.filename === props.path);
  const status = fileChange?.status ?? '';

  if (status === 'added' || !parentSha) {
    emit('openVersion', props.path, commit.sha ?? '');
    return;
  }

  if (status === 'removed') {
    emit('openVersion', props.path, parentSha);
    return;
  }

  emit('viewDiff', props.path, parentSha, commit.sha ?? '');
}
</script>

<template>
  <ModalDialog :open="open" :title="t('dashboard.fileBrowser.historyTitle', { path })" @close="emit('close')">
    <div class="history-dialog">
      <div v-if="loading" class="history-status">{{ state.t('dashboard.loading') }}</div>
      <div v-else-if="error" class="history-status error">{{ error }}</div>
      <div v-else-if="!commits.length" class="history-status">
        {{ state.t('dashboard.fileBrowser.noHistory') }}
      </div>
      <ul v-else class="history-list">
        <li v-for="commit in commits" :key="commit.sha" class="history-item" @click="onItemClick(commit)">
          <div class="history-message" :title="commit.commit?.message">
            {{ truncateMessage(commit.commit?.message ?? '') }}
          </div>
          <div class="history-meta">
            <span class="history-author">{{ commit.commit?.author?.name }}</span>
            <span class="history-date">{{ formatDate(commit.commit?.author?.date ?? '') }}</span>
            <code class="history-sha">{{ commit.sha.slice(0, 7) }}</code>
          </div>
        </li>
      </ul>
    </div>
  </ModalDialog>
</template>

<style scoped>
.history-dialog {
  max-width: min(640px, calc(100vw - 32px));
}

.history-status {
  padding: 16px;
  color: var(--vscode-descriptionForeground);
  text-align: center;
}

.history-status.error {
  color: var(--vscode-testing-iconFailed);
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  max-height: 60vh;
  overflow: auto;
}

.history-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
  cursor: pointer;
}

.history-item:hover {
  background-color: var(--vscode-list-hoverBackground);
}

.history-item:last-child {
  border-bottom: none;
}

.history-message {
  font-weight: 500;
  word-break: break-word;
}

.history-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  flex-wrap: wrap;
}

.history-sha {
  font-family: var(--vscode-editor-font-family);
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  padding: 2px 6px;
  border-radius: 3px;
}

.history-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}
</style>
