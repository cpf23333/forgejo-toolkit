<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { isListTruncated } from '@cpf23333-forgejo-toolkit/shared/limits';
import { useI18n } from 'vue-i18n';
import FileTreeNode from './FileTreeNode.vue';
import type { ForgejoChangedFile } from '../types/api';
import type { FileTreeNode as FileTreeNodeType } from '../types/fileTree';

const { t } = useI18n();

interface Props {
  files: ForgejoChangedFile[];
  loading?: boolean;
  error?: string;
  supportsMultiDiff?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  openDiff: [filename: string, status: string, previousFilename?: string];
  openSelectedDiffs: [files: { filename: string; status: string; previous_filename?: string }[]];
}>();

function buildFileTree(files: ForgejoChangedFile[]): FileTreeNodeType[] {
  const root: FileTreeNodeType = {
    name: '',
    path: '',
    type: 'dir',
    children: [],
    expanded: true,
    checked: false,
    indeterminate: false,
  };
  for (const file of files) {
    const filename = file.filename ?? file.previous_filename ?? '';
    if (!filename) {
      continue;
    }
    const parts = filename.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');
      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path,
          type: isFile ? 'file' : 'dir',
          children: [],
          expanded: true,
          checked: false,
          indeterminate: false,
        };
        if (isFile) {
          child.file = file;
        }
        current.children.push(child);
      }
      current = child;
    }
  }
  return root.children;
}

function sortTree(nodes: FileTreeNodeType[]): FileTreeNodeType[] {
  return nodes.sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name);
    }
    return a.type === 'dir' ? -1 : 1;
  });
}

function sortTreeRecursively(nodes: FileTreeNodeType[]): FileTreeNodeType[] {
  const sorted = sortTree(nodes);
  for (const node of sorted) {
    if (node.type === 'dir') {
      node.children = sortTreeRecursively(node.children);
    }
  }
  return sorted;
}

const tree = ref<FileTreeNodeType[]>([]);

watch(
  () => props.files,
  (files) => {
    tree.value = sortTreeRecursively(buildFileTree(files));
  },
  { immediate: true },
);

const fileCount = computed(() => props.files.length);
// The host caps a paged list at LIST_ITEM_LIMIT and reports no total, so the list
// says it may be incomplete instead of looking complete.
const listTruncated = computed(() => isListTruncated(props.files));

const selectedFiles = computed(() => {
  const result: { filename: string; status: string; previous_filename?: string }[] = [];
  function collect(nodes: FileTreeNodeType[]) {
    for (const node of nodes) {
      if (node.type === 'file' && node.checked && node.file?.filename) {
        result.push({
          filename: node.file.filename,
          status: node.file.status ?? 'modified',
          previous_filename: node.file.previous_filename,
        });
      }
      if (node.type === 'dir') {
        collect(node.children);
      }
    }
  }
  collect(tree.value);
  return result;
});

const allSelected = computed(() => {
  if (fileCount.value === 0) {
    return false;
  }
  return selectedFiles.value.length === fileCount.value;
});

const someSelected = computed(() => {
  return selectedFiles.value.length > 0 && selectedFiles.value.length < fileCount.value;
});

function updateNodeAndDescendants(node: FileTreeNodeType, checked: boolean) {
  node.checked = checked;
  node.indeterminate = false;
  for (const child of node.children) {
    updateNodeAndDescendants(child, checked);
  }
}

function updateAncestors(nodes: FileTreeNodeType[], path: string) {
  function findAndUpdate(nodes: FileTreeNodeType[], path: string): boolean {
    for (const node of nodes) {
      if (node.path === path) {
        return true;
      }
      if (node.type === 'dir' && path.startsWith(node.path + '/')) {
        if (findAndUpdate(node.children, path)) {
          const allChecked = node.children.length > 0 && node.children.every((c) => c.checked);
          const someChecked = node.children.some((c) => c.checked || c.indeterminate);
          node.checked = allChecked;
          node.indeterminate = !allChecked && someChecked;
          return true;
        }
      }
    }
    return false;
  }
  findAndUpdate(nodes, path);
}

function onNodeCheck(node: FileTreeNodeType, checked: boolean) {
  updateNodeAndDescendants(node, checked);
  updateAncestors(tree.value, node.path);
}

function toggleExpand(node: FileTreeNodeType) {
  if (node.type === 'dir') {
    node.expanded = !node.expanded;
  }
}

function selectAll(checked: boolean) {
  for (const node of tree.value) {
    updateNodeAndDescendants(node, checked);
  }
}

function expandAll(expanded: boolean) {
  function walk(nodes: FileTreeNodeType[]) {
    for (const node of nodes) {
      if (node.type === 'dir') {
        node.expanded = expanded;
        walk(node.children);
      }
    }
  }
  walk(tree.value);
}

function openDiff(filename: string, status: string, previousFilename?: string) {
  emit('openDiff', filename, status, previousFilename);
}

function openSelectedDiffs() {
  if (selectedFiles.value.length === 0) {
    return;
  }
  emit('openSelectedDiffs', selectedFiles.value);
}
</script>

<template>
  <div v-if="listTruncated" class="list-truncated">
    {{ t('dashboard.detail.filesTruncated') }}
  </div>
  <div class="diff-file-list">
    <div v-if="loading" class="loading">
      <vscode-progress-ring class="diff-loading-ring" /> {{ t('dashboard.loading') }}
    </div>
    <div v-else-if="error" class="error">{{ t('dashboard.error', { message: error }) }}</div>
    <div v-else-if="props.files.length === 0" class="empty">
      {{ t('dashboard.detail.noChangedFiles') }}
    </div>
    <div v-else class="file-tree-container">
      <div class="file-tree-toolbar">
        <label class="toolbar-checkbox">
          <input
            type="checkbox"
            :checked="allSelected"
            :indeterminate="someSelected"
            @change="selectAll(!allSelected)"
          />
          <span>{{ t('dashboard.detail.selectAll') }}</span>
        </label>
        <div class="toolbar-actions">
          <button type="button" class="toolbar-link link-button" @click="expandAll(true)">
            {{ t('dashboard.detail.expandAll') }}
          </button>
          <button type="button" class="toolbar-link link-button" @click="expandAll(false)">
            {{ t('dashboard.detail.collapseAll') }}
          </button>
          <button
            v-if="props.supportsMultiDiff"
            type="button"
            class="toolbar-link view-selected-link link-button"
            :class="{ disabled: selectedFiles.length === 0 }"
            :disabled="selectedFiles.length === 0"
            @click="openSelectedDiffs"
          >
            {{ t('dashboard.detail.viewSelectedDiffs', { count: selectedFiles.length }) }}
          </button>
        </div>
      </div>
      <ul class="file-tree">
        <FileTreeNode
          v-for="node in tree"
          :key="node.path"
          :node="node"
          @toggle-expand="toggleExpand"
          @check="onNodeCheck"
          @open-diff="openDiff"
        />
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

.diff-loading-ring {
  width: 14px;
  height: 14px;
  vertical-align: middle;
}

.error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
}

.file-tree-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.file-tree-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 8px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
  font-size: 0.85em;
  flex-wrap: wrap;
}

.toolbar-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--vscode-foreground);
}

.toolbar-checkbox input {
  flex-shrink: 0;
  margin: 0;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar-link {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}

.toolbar-link:hover {
  text-decoration: underline;
}

.toolbar-link.disabled {
  color: var(--vscode-descriptionForeground);
  pointer-events: none;
  text-decoration: none;
}

.view-selected-link {
  font-weight: 500;
}

.file-tree {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
