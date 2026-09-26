<script setup lang="ts">
import { computed, nextTick, provide, ref, watch } from 'vue';
import { isListTruncatedWithTotal } from '@cpf23333-forgejo-toolkit/shared/limits';
import { useI18n } from 'vue-i18n';
import FileTreeNode from './FileTreeNode.vue';
import type { ForgejoChangedFile } from '../types/api';
import { fileTreeFocusedPathKey, type FileTreeNode as FileTreeNodeType } from '../types/fileTree';

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

/**
 * Identity of the files the tree was built from. Callers such as
 * `CommitDiffList` build their array inside their template, so a new array
 * holding the very same files arrives on every parent render; watching the
 * array itself rebuilt the tree (unchecking files, re-expanding collapsed
 * directories) whenever an unrelated part of the view re-rendered. Only a real
 * change to the files rebuilds it.
 *
 * The line stats are part of that identity because the rows render them
 * (`FileTreeNode` reads `additions`/`deletions` off the file object the tree
 * keeps): a refetch whose stats changed without any name or status change used
 * to leave stale +/− badges. Widening the signature means such a refetch now
 * rebuilds the tree, so {@link captureTreeState} / {@link restoreTreeState} keep
 * the user's per-path checked/expanded state across the rebuild.
 */
function filesSignature(files: ForgejoChangedFile[]): string {
  return files
    .map(
      (file) =>
        `${file.filename ?? ''}\u0000${file.status ?? ''}\u0000${file.previous_filename ?? ''}` +
        `\u0000${file.additions ?? ''}\u0000${file.deletions ?? ''}`,
    )
    .join('\u0001');
}

/**
 * Checked/expanded state of the tree the user is looking at, keyed by path.
 * `buildFileTree` sets every directory expanded and every checkbox unchecked, so
 * without this a rebuild would also discard the user's own state.
 */
function captureTreeState(
  nodes: FileTreeNodeType[],
  state = new Map<string, { checked: boolean; expanded: boolean }>(),
) {
  for (const node of nodes) {
    state.set(node.path, { checked: node.checked, expanded: node.expanded });
    if (node.type === 'dir') {
      captureTreeState(node.children, state);
    }
  }
  return state;
}

/** Re-applies captured state to the fresh tree, then re-derives directory state. */
function restoreTreeState(nodes: FileTreeNodeType[], state: Map<string, { checked: boolean; expanded: boolean }>) {
  for (const node of nodes) {
    const saved = state.get(node.path);
    if (saved) {
      if (node.type === 'file') {
        // Only files carry a user choice of their own; a directory's is derived
        // from its children below, so a stale value could never disagree with
        // them.
        node.checked = saved.checked;
        node.indeterminate = false;
      }
      node.expanded = saved.expanded;
    }
    if (node.type === 'dir') {
      restoreTreeState(node.children, state);
      node.checked = node.children.length > 0 && node.children.every((child) => child.checked);
      node.indeterminate = node.children.some((child) => child.checked || child.indeterminate);
    }
  }
}

watch(
  () => filesSignature(props.files),
  () => {
    const previous = captureTreeState(tree.value);
    const rebuilt = sortTreeRecursively(buildFileTree(props.files));
    restoreTreeState(rebuilt, previous);
    tree.value = rebuilt;
  },
  { immediate: true },
);

const fileCount = computed(() => props.files.length);
// The host caps a paged list at LIST_ITEM_LIMIT and reports no total, so the list
// says it may be incomplete instead of looking complete.
const listTruncated = computed(() => isListTruncatedWithTotal(props.files));

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

// --- Keyboard navigation ---------------------------------------------------
// Every row used to be a tab stop, which made a 500-file diff unusable with a
// keyboard: reaching the last file took 500 Tab presses. The tree now follows
// the conventional roving-tabindex pattern — one tab stop for the whole tree,
// arrow keys move inside it — like the repository file browser's `vscode-tree`.

const focusedPath = ref<string | null>(null);
provide(
  fileTreeFocusedPathKey,
  computed(() => focusedPath.value),
);

const treeRef = ref<HTMLElement | null>(null);

/** Visible rows in tree order: a collapsed directory's children are skipped. */
function visibleRows(): FileTreeNodeType[] {
  const rows: FileTreeNodeType[] = [];
  function walk(nodes: FileTreeNodeType[]) {
    for (const node of nodes) {
      rows.push(node);
      if (node.type === 'dir' && node.expanded) {
        walk(node.children);
      }
    }
  }
  walk(tree.value);
  return rows;
}

function findParentPath(path: string): string | null {
  let parent: string | null = null;
  function walk(nodes: FileTreeNodeType[], parentPath: string | null) {
    for (const node of nodes) {
      if (node.path === path) {
        parent = parentPath;
        return;
      }
      if (node.type === 'dir') {
        walk(node.children, node.path);
      }
    }
  }
  walk(tree.value, null);
  return parent;
}

function focusRow(path: string | null) {
  focusedPath.value = path;
  void nextTick(() => {
    if (path === null) {
      return;
    }
    // The focus target is found in the DOM instead of through a child ref:
    // nested rows are rendered recursively, so only the row itself knows its
    // element.
    const row = treeRef.value?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    row?.focus();
  });
}

function onTreeKeydown(event: KeyboardEvent) {
  const key = event.key;
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'ArrowLeft' && key !== 'ArrowRight') {
    return;
  }
  const rows = visibleRows();
  if (rows.length === 0) {
    return;
  }
  const current = focusedPath.value;
  if (current === null) {
    focusRow(rows[0].path);
    return;
  }
  const position = rows.findIndex((row) => row.path === current);
  if (position < 0) {
    focusRow(rows[0].path);
    return;
  }
  const row = rows[position];
  if (key === 'ArrowDown') {
    if (position < rows.length - 1) {
      focusRow(rows[position + 1].path);
    }
    return;
  }
  if (key === 'ArrowUp') {
    if (position > 0) {
      focusRow(rows[position - 1].path);
    }
    return;
  }
  if (key === 'ArrowRight') {
    if (row.type !== 'dir' || row.children.length === 0) {
      return;
    }
    // The treeitem contract for ArrowRight: a collapsed directory expands, an
    // expanded one steps into its first child. The row itself only handles
    // Enter/Space, so without the expand branch the key did nothing on a
    // collapsed directory (the row never expanded it).
    if (!row.expanded) {
      toggleExpand(row);
      return;
    }
    focusRow(row.children[0].path);
    return;
  }
  // ArrowLeft: a row whose subtree is already collapsed moves to its parent.
  if (row.type === 'dir' && row.expanded) {
    toggleExpand(row);
    return;
  }
  focusRow(findParentPath(current));
}

// Tabbing into the tree lands on whichever row was focused last, but a user can
// also arrive with the browser's own focus (a click before the roving state was
// set, a restored focus). Track it so the next arrow key moves from the row the
// user is actually on.
function onTreeFocusIn(event: FocusEvent) {
  const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-path]');
  const path = row?.dataset.path;
  if (path !== undefined && path !== focusedPath.value) {
    focusedPath.value = path;
  }
}

watch(
  tree,
  (nodes) => {
    // Keep the tab stop on a row that still exists, and give an unvisited tree
    // one tabbable row so the whole list is reachable with Tab.
    const rows = visibleRows();
    if (focusedPath.value !== null && rows.some((row) => row.path === focusedPath.value)) {
      return;
    }
    focusedPath.value = nodes.length > 0 ? nodes[0].path : null;
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="listTruncated" class="list-truncated">
    {{ t('dashboard.detail.filesTruncated') }}
  </div>
  <div class="diff-file-list">
    <div v-if="loading" class="loading">
      <vscode-progress-ring class="diff-loading-ring" :aria-label="t('dashboard.loading')" />
      {{ t('dashboard.loading') }}
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
      <ul ref="treeRef" class="file-tree" role="tree" @keydown="onTreeKeydown" @focusin="onTreeFocusIn">
        <FileTreeNode
          v-for="node in tree"
          :key="node.path"
          :node="node"
          :focus-path="focusedPath"
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
