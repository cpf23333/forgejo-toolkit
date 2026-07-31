<script setup lang="ts">
import { computed } from 'vue';
import { useAppState, repoContentsKey } from '../composables/useAppState';
import type { ForgejoContentEntry } from '../types/api';

const props = defineProps<{
  entry: ForgejoContentEntry;
  instanceId: string;
  owner: string;
  repo: string;
  branchRef: string;
  level?: number;
}>();

const emit = defineEmits<{
  showHistory: [entry: ForgejoContentEntry];
}>();

const state = useAppState();

const isDir = computed(() => props.entry.type === 'dir');
const contentsKey = computed(() =>
  repoContentsKey(props.instanceId, props.owner, props.repo, props.branchRef, props.entry.path ?? ''),
);
const children = computed(() => state.repoContents.value.get(contentsKey.value));
const loading = computed(() => state.loading.get(contentsKey.value) ?? false);
const error = computed(() => state.errors.get(contentsKey.value));

function onHistoryClick(event: Event) {
  event.stopPropagation();
  emit('showHistory', props.entry);
}
</script>

<template>
  <vscode-tree-item
    :branch="isDir || undefined"
    :level="level ?? 0"
    :data-file-path="entry.path"
    :data-type="entry.type"
    :data-size="entry.size"
  >
    <span class="tree-label">{{ entry.name }}</span>
    <span v-if="!isDir && error" class="tree-status error" :title="error">{{ error }}</span>
    <span v-if="!isDir" slot="actions">
      <button class="tree-action" :title="state.t('dashboard.fileBrowser.history')" @click="onHistoryClick">
        <i class="codicon codicon-history"></i>
      </button>
    </span>
    <template v-if="isDir">
      <vscode-tree-item v-if="loading && children === undefined" :level="(level ?? 0) + 1" :branch="false">
        <span class="tree-status">{{ state.t('dashboard.loading') }}</span>
      </vscode-tree-item>
      <vscode-tree-item v-else-if="error" :level="(level ?? 0) + 1" :branch="false">
        <span class="tree-status error" :title="error">{{ error }}</span>
      </vscode-tree-item>
      <FileTreeItem
        v-for="child in children"
        v-else
        :key="child.sha ?? child.path ?? child.name"
        :entry="child"
        :instance-id="instanceId"
        :owner="owner"
        :repo="repo"
        :branch-ref="branchRef"
        :level="(level ?? 0) + 1"
        @show-history="emit('showHistory', $event)"
      />
    </template>
  </vscode-tree-item>
</template>

<style scoped>
.tree-label {
  cursor: pointer;
}

.tree-status {
  margin-left: 8px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.tree-status.error {
  color: var(--vscode-testing-iconFailed);
}

.tree-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: 4px;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  opacity: 0.7;
}

.tree-action:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
  opacity: 1;
}
</style>
