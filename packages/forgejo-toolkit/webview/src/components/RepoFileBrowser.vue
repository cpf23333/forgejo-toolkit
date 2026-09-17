<script setup lang="ts">
import { ref, computed, watch, nextTick, onActivated, onDeactivated, onUnmounted } from 'vue';
import { useAppState, repoContentsKey, repoFileSearchKey } from '../composables/useAppState';
import FileTreeItem from './FileTreeItem.vue';
import RepoFileHistoryDialog from './RepoFileHistoryDialog.vue';
import { isImageFile } from '../utils/fileTypes';
import type { ForgejoContentEntry } from '../types/api';
import type { GitEntry } from '@cpf23333-forgejo-toolkit/api';

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
const searchQuery = ref('');
const searchInputRef = ref<HTMLInputElement>();
const historyEntry = ref<ForgejoContentEntry | undefined>(undefined);
const searchDebounceTimer = ref<ReturnType<typeof setTimeout> | undefined>(undefined);

// RepoFileBrowser lives inside RepoDetail, which App.vue renders under
// keep-alive, so it is deactivated rather than unmounted when navigating
// away. Props then track the global route; guard the debounced search on
// isActive and re-apply a dropped query on activation.
const isActive = ref(true);
const appliedSearchQuery = ref('');

const rootKey = computed(() => repoContentsKey(props.instanceId, props.owner, props.repo, selectedRef.value, ''));
const rootEntries = computed(() => state.repoContents.value.get(rootKey.value) ?? []);
const rootLoading = computed(() => state.loading.get(rootKey.value) ?? false);
const rootError = computed(() => state.errors.get(rootKey.value));

const searchKey = computed(() =>
  repoFileSearchKey(props.instanceId, props.owner, props.repo, selectedRef.value, searchQuery.value.trim()),
);
const searchResults = computed(() => state.repoFileSearchResults.value.get(searchKey.value) ?? []);
const searchLoading = computed(() => state.loading.get(searchKey.value) ?? false);
const searchError = computed(() => state.errors.get(searchKey.value));
const hasSearchQuery = computed(() => searchQuery.value.trim().length > 0);

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
  loadEntry({ path, type, name });
}

// vscode-tree expands a focused branch on ArrowRight without emitting
// vsc-tree-select, so keyboard expansion must load directory children here.
function onTreeKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowRight') {
    return;
  }
  const item = (event.target as HTMLElement | null)?.closest?.('vscode-tree-item');
  if (!item || (item as HTMLElement).dataset.type !== 'dir') {
    return;
  }
  const path = (item as HTMLElement).dataset.filePath ?? '';
  state.loadRepoContents(props.instanceId, props.owner, props.repo, path, selectedRef.value);
}

function runSearch() {
  const query = searchQuery.value.trim();
  appliedSearchQuery.value = query;
  if (query) {
    state.loadRepoFileSearch(props.instanceId, props.owner, props.repo, selectedRef.value, query);
  }
}

function scheduleSearch() {
  if (searchDebounceTimer.value) {
    clearTimeout(searchDebounceTimer.value);
  }
  searchDebounceTimer.value = setTimeout(() => {
    // The view may have been deactivated (route switched) during the debounce
    // window; firing then would send a request with the new route's params.
    // onActivated re-applies the dropped input.
    if (!isActive.value) {
      return;
    }
    runSearch();
  }, 300);
}

function clearSearch() {
  searchQuery.value = '';
  if (searchDebounceTimer.value) {
    clearTimeout(searchDebounceTimer.value);
    searchDebounceTimer.value = undefined;
  }
  searchInputRef.value?.focus();
}

function openSearchResult(file: GitEntry) {
  const path = file.path ?? '';
  if (!path) {
    return;
  }
  state.openRepoFile(props.instanceId, props.owner, props.repo, path, selectedRef.value);
}

function onShowHistory(entry: ForgejoContentEntry) {
  historyEntry.value = entry;
}

function onCloseHistory() {
  historyEntry.value = undefined;
}

function onOpenVersion(path: string, ref: string) {
  state.openRepoFile(props.instanceId, props.owner, props.repo, path, ref);
}

function onViewDiff(path: string, baseRef: string, headRef: string) {
  state.openRepoFileDiff(props.instanceId, props.owner, props.repo, path, baseRef, headRef);
}

function onBranchChange(event: Event) {
  const target = event.target as HTMLInputElement | null;
  const value = target?.value;
  if (value) {
    selectedRef.value = value;
  }
}

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
    await nextTick();
    const tree = treeRef.value;
    if (tree && 'updateHasBranchItemFlag' in tree) {
      (tree as unknown as { updateHasBranchItemFlag: () => void }).updateHasBranchItemFlag();
    }
  },
  { immediate: true },
);

watch(searchQuery, scheduleSearch);

onActivated(() => {
  isActive.value = true;
  // A debounced search dropped while deactivated (isActive guard above)
  // leaves the input ahead of the applied query; re-apply it so the results
  // match what the input still shows.
  if (searchQuery.value.trim() !== appliedSearchQuery.value) {
    if (searchDebounceTimer.value) {
      clearTimeout(searchDebounceTimer.value);
      searchDebounceTimer.value = undefined;
    }
    runSearch();
  }
});
onDeactivated(() => {
  isActive.value = false;
});

onUnmounted(() => {
  if (searchDebounceTimer.value) {
    clearTimeout(searchDebounceTimer.value);
  }
});
</script>

<template>
  <div class="file-browser">
    <div class="file-browser-toolbar">
      <vscode-single-select filter="fuzzy" :value="selectedRef" class="branch-select" @change="onBranchChange">
        <vscode-option v-for="branch in branches" :key="branch" :value="branch" :selected="branch === selectedRef">
          {{ branch }}
        </vscode-option>
      </vscode-single-select>
      <button
        class="refresh-button"
        :disabled="rootLoading"
        type="button"
        :title="state.t('dashboard.fileBrowser.refresh')"
        :aria-label="state.t('dashboard.fileBrowser.refresh')"
        @click="loadRoot(true)"
      >
        <i class="codicon codicon-refresh" :class="{ 'codicon-modifier-spin': rootLoading }"></i>
      </button>
    </div>

    <div class="file-search-bar">
      <vscode-textfield
        ref="searchInputRef"
        :value="searchQuery"
        @input="searchQuery = ($event.target as HTMLInputElement).value"
        class="search-input"
        :placeholder="state.t('dashboard.fileBrowser.searchPlaceholder')"
      />
      <button
        v-if="hasSearchQuery"
        class="search-clear"
        type="button"
        :title="state.t('dashboard.fileBrowser.clearSearch')"
        :aria-label="state.t('dashboard.fileBrowser.clearSearch')"
        @click="clearSearch"
      >
        <i class="codicon codicon-close"></i>
      </button>
    </div>

    <div class="file-browser-body">
      <div class="file-tree-panel">
        <template v-if="hasSearchQuery">
          <div v-if="searchLoading" class="tree-status">{{ state.t('dashboard.loading') }}</div>
          <div v-else-if="searchError" class="tree-status error">{{ searchError }}</div>
          <div v-else-if="!searchResults.length" class="tree-status">
            {{ state.t('dashboard.fileBrowser.searchNoResults') }}
          </div>
          <ul v-else class="search-results">
            <li
              v-for="file in searchResults"
              :key="file.sha ?? file.path"
              class="search-result-item"
              tabindex="0"
              @click="openSearchResult(file)"
              @keydown.enter="openSearchResult(file)"
              @keydown.space.prevent="openSearchResult(file)"
            >
              <i class="codicon" :class="isImageFile(file.path ?? '') ? 'codicon-file-media' : 'codicon-file'"></i>
              <span class="search-result-path">{{ file.path }}</span>
            </li>
          </ul>
        </template>
        <template v-else>
          <div v-if="rootLoading" class="tree-status">{{ state.t('dashboard.loading') }}</div>
          <div v-else-if="rootError" class="tree-status error">{{ rootError }}</div>
          <vscode-tree
            v-else-if="rootEntries.length"
            ref="treeRef"
            @vsc-tree-select="onTreeSelect"
            @keydown="onTreeKeydown"
          >
            <FileTreeItem
              v-for="entry in rootEntries"
              :key="entry.sha ?? entry.path ?? entry.name"
              :entry="entry"
              :instance-id="instanceId"
              :owner="owner"
              :repo="repo"
              :branch-ref="selectedRef"
              @show-history="onShowHistory"
            />
          </vscode-tree>
          <div v-else class="tree-status">{{ state.t('dashboard.fileBrowser.emptyDirectory') }}</div>
        </template>
      </div>
    </div>

    <RepoFileHistoryDialog
      v-if="historyEntry"
      :open="!!historyEntry"
      :instance-id="instanceId"
      :owner="owner"
      :repo="repo"
      :path="historyEntry.path ?? ''"
      :branch-ref="selectedRef"
      @close="onCloseHistory"
      @open-version="onOpenVersion"
      @view-diff="onViewDiff"
    />
  </div>
</template>

<style scoped>
.file-browser {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
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

.file-search-bar {
  position: relative;
  display: flex;
  align-items: center;
}

.search-input {
  flex: 1;
}

.search-clear {
  position: absolute;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
}

.search-clear:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.file-browser-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.file-tree-panel {
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background-color: var(--vscode-sideBar-background);
  flex: 1;
  min-height: 0;
}

.tree-status {
  padding: 8px;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}

.tree-status.error {
  color: var(--vscode-testing-iconFailed);
}

.search-results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.search-result-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 0.95em;
}

.search-result-item:hover {
  background-color: var(--vscode-list-hoverBackground);
}

.search-result-path {
  word-break: break-all;
}
</style>
