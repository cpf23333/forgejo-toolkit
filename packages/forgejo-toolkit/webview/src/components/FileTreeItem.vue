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

const state = useAppState();

const isDir = computed(() => props.entry.type === 'dir');
const contentsKey = computed(() =>
  repoContentsKey(props.instanceId, props.owner, props.repo, props.branchRef, props.entry.path ?? ''),
);
const children = computed(() => state.repoContents.value.get(contentsKey.value));
const loading = computed(() => state.loading.value.get(contentsKey.value) ?? false);
const error = computed(() => state.errors.value.get(contentsKey.value));
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
    <span v-if="loading" class="tree-status">{{ state.t('dashboard.loading') }}</span>
    <span v-else-if="error" class="tree-status error" :title="error">{{ error }}</span>
    <template v-if="isDir && children">
      <FileTreeItem
        v-for="child in children"
        :key="child.sha ?? child.path ?? child.name"
        :entry="child"
        :instance-id="instanceId"
        :owner="owner"
        :repo="repo"
        :branch-ref="branchRef"
        :level="(level ?? 0) + 1"
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
</style>
