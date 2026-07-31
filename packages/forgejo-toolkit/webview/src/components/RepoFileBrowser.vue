<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useAppState, repoContentsKey } from '../composables/useAppState';
import FileTreeItem from './FileTreeItem.vue';
import type { ForgejoContentEntry } from '../types/api';

const props = defineProps<{
  instanceId: string;
  owner: string;
  repo: string;
  branches: string[];
  defaultBranch: string;
  branch?: string;
}>();

const state = useAppState();

const selectedRef = ref(props.defaultBranch);
const treeRef = ref<HTMLElement>();

const rootKey = computed(() => repoContentsKey(props.instanceId, props.owner, props.repo, selectedRef.value, ''));
const rootEntries = computed(() => state.repoContents.value.get(rootKey.value) ?? []);
const rootLoading = computed(() => state.loading.value.get(rootKey.value) ?? false);
const rootError = computed(() => state.errors.value.get(rootKey.value));

function loadRoot(force = false) {
  state.loadRepoContents(props.instanceId, props.owner, props.repo, '', selectedRef.value, force);
}

function loadEntry(entry: ForgejoContentEntry) {
  if (entry.type === 'dir') {
    state.loadRepoContents(props.instanceId, props.owner, props.repo, entry.path ?? '', selectedRef.value);
    return;
  }

  if (entry.type === 'file') {
    state.openRepoFile(props.instanceId, props.owner, props.repo, entry.path ?? '', selectedRef.value);
  }
}

function onTreeSelect(event: Event) {
  const customEvent = event as CustomEvent<HTMLElement[]>;
  const items = customEvent.detail ?? [];
  const element = items[0];
  if (!element) {
    return;
  }
  const path = element.dataset.filePath ?? '';
  const type = element.dataset.type ?? '';
  const name = element.querySelector('.tree-label')?.textContent ?? '';
  // eslint-disable-next-line no-console
  console.log('[RepoFileBrowser] onTreeSelect', { path, type, name, element });
  loadEntry({ path, type, name });
}

// eslint-disable-next-line no-console
console.log('[RepoFileBrowser] rootEntries', rootEntries.value);

watch(
  () => props.defaultBranch,
  (branch) => {
    if (branch && !selectedRef.value) {
      selectedRef.value = branch;
    }
  },
);

watch(
  () => props.branch,
  (branch) => {
    if (branch && branch !== selectedRef.value) {
      selectedRef.value = branch;
    }
  },
  { immediate: true },
);

watch(
  () => [props.instanceId, props.owner, props.repo, selectedRef.value],
  () => {
    loadRoot();
  },
  { immediate: true },
);

watch(
  () => rootEntries.value,
  async (entries) => {
    // eslint-disable-next-line no-console
    console.log('[RepoFileBrowser] rootEntries updated', entries);
    await nextTick();
    const tree = treeRef.value;
    if (tree && 'updateHasBranchItemFlag' in tree) {
      (tree as unknown as { updateHasBranchItemFlag: () => void }).updateHasBranchItemFlag();
    }
  },
  { immediate: true },
);

function onBranchChange(event: Event) {
  const target = event.target as HTMLInputElement | null;
  const value = target?.value;
  if (value) {
    selectedRef.value = value;
  }
}
</script>

<template>
  <div class="file-browser">
    <div class="file-browser-toolbar">
      <vscode-single-select filter :value="selectedRef" class="branch-select" @change="onBranchChange">
        <vscode-option v-for="branch in branches" :key="branch" :value="branch" :selected="branch === selectedRef">
          {{ branch }}
        </vscode-option>
      </vscode-single-select>
      <button
        class="refresh-button"
        :disabled="rootLoading"
        :title="state.t('dashboard.fileBrowser.refresh')"
        @click="loadRoot(true)"
      >
        <i class="fa fa-refresh" :class="{ 'fa-spin': rootLoading }"></i>
      </button>
    </div>

    <div class="file-tree-panel">
      <div v-if="rootLoading" class="tree-status">{{ state.t('dashboard.loading') }}</div>
      <div v-else-if="rootError" class="tree-status error">{{ rootError }}</div>
      <vscode-tree v-else-if="rootEntries.length" ref="treeRef" @vsc-tree-select="onTreeSelect">
        <FileTreeItem
          v-for="entry in rootEntries"
          :key="entry.sha ?? entry.path ?? entry.name"
          :entry="entry"
          :instance-id="instanceId"
          :owner="owner"
          :repo="repo"
          :branch-ref="selectedRef"
        />
      </vscode-tree>
      <div v-else class="tree-status">{{ state.t('dashboard.fileBrowser.emptyDirectory') }}</div>
    </div>
  </div>
</template>

<style scoped>
.file-browser {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 400px;
}

.file-browser-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.branch-select {
  flex: 1;
  min-width: 160px;
}

.refresh-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  padding: 0;
  cursor: pointer;
  font-size: 1em;
}

.refresh-button:hover {
  background-color: var(--vscode-button-hoverBackground);
}

.refresh-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.file-tree-panel {
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background-color: var(--vscode-sideBar-background);
}

.tree-status {
  padding: 8px;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}

.tree-status.error {
  color: var(--vscode-testing-iconFailed);
}
</style>
