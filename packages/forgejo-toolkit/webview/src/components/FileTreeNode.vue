<script setup lang="ts">
import { computed, inject, provide, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { fileTreeFocusedPathKey, type FileTreeNode } from '../types/fileTree';

const { t } = useI18n();

/**
 * Roving tabindex: only one row of the tree is a tab stop at a time, so a
 * 500-file diff is reachable with Tab + arrow keys instead of 500 tab presses.
 * The tree owner (`DiffFileList`) provides the path of the focused row, and each
 * row passes it on to its children, so one state drives every nested row.
 */
interface Props {
  node: FileTreeNode;
  /** Path of the row that owns the tree's single tab stop (absent outside a tree). */
  focusPath?: string | null;
  /** Depth in the tree, announced by screen readers as the row's level. */
  level?: number;
}

const props = withDefaults(defineProps<Props>(), { level: 1 });

// `null` means "no row chosen yet"; the first row then carries the tab stop.
const inheritedPath = inject<ComputedRef<string | null> | null>(fileTreeFocusedPathKey, null);
const focusedPath = computed(() => (props.focusPath === undefined ? inheritedPath?.value : props.focusPath));
const isTabbable = computed(() => {
  const path = focusedPath.value;
  return path === null || path === undefined ? true : path === props.node.path;
});

provide(
  fileTreeFocusedPathKey,
  computed(() => props.node.path),
);

const emit = defineEmits<{
  toggleExpand: [node: FileTreeNode];
  check: [node: FileTreeNode, checked: boolean];
  openDiff: [filename: string, status: string, previousFilename?: string];
}>();

const isDir = props.node.type === 'dir';
const hasChildren = isDir && props.node.children.length > 0;

function onCheck(event: Event) {
  emit('check', props.node, (event.target as HTMLInputElement).checked);
}

function onToggleExpand() {
  if (hasChildren) {
    emit('toggleExpand', props.node);
  }
}

function openDiff() {
  if (props.node.file?.filename) {
    emit('openDiff', props.node.file.filename, props.node.file.status ?? 'modified', props.node.file.previous_filename);
  }
}

function onRowClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (target.closest('.node-checkbox, .tree-expander, .view-diff-link')) {
    return;
  }
  if (isDir) {
    onToggleExpand();
    return;
  }
  openDiff();
}

function onRowKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    // Arrow keys are tree navigation; the tree owner (`DiffFileList`) resolves
    // them from the keydown that bubbles up from this row.
    return;
  }
  // Keydown bubbles from focused inner controls; like onRowClick, leave the
  // checkbox's own Space/Enter activation (and other inner targets) alone
  // instead of stealing the key for expand/openDiff.
  const target = event.target as HTMLElement;
  if (target.closest('.node-checkbox, .tree-expander, .view-diff-link')) {
    return;
  }
  event.preventDefault();
  // Space is the row's selection key (the checkbox it stands for is not a tab
  // stop of its own), Enter opens the diff.
  if (event.key === ' ') {
    emit('check', props.node, !props.node.checked);
    return;
  }
  if (isDir) {
    onToggleExpand();
  } else {
    openDiff();
  }
}

// The checkbox is the row's selection control and needs a name of its own: the
// visible text sits outside it, so screen readers would announce a bare
// "checkbox" for every changed file.
const checkboxLabel = computed(() => {
  if (isDir) {
    return props.node.name;
  }
  return t('dashboard.detail.selectFile', { name: props.node.name, status: statusText(props.node.file?.status) });
});

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

// Codicon names (AGENTS.md prefers Codicons over emoji for file-type icons).
function nodeIcon(): string {
  if (isDir) {
    return 'folder';
  }
  const ext = props.node.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'vue':
    case 'css':
    case 'scss':
    case 'less':
    case 'html':
    case 'yml':
    case 'yaml':
      return 'file-code';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
      return 'file-media';
    default:
      return 'file';
  }
}
</script>

<template>
  <!-- The `<li>` carries the treeitem role: a `role="treeitem"` wrapped in a
       plain `<li>` (or on a `<div>` inside one) breaks the required parent/child
       chain `tree > treeitem > group > treeitem`, and the nested list below must
       be exposed as the children's group. The `<div>` stays the row element
       because it holds the focus and the class the styles target. -->
  <li
    class="tree-node"
    role="treeitem"
    :aria-level="props.level"
    :aria-expanded="hasChildren ? props.node.expanded : undefined"
    :aria-selected="props.node.checked"
  >
    <div
      class="tree-row"
      :class="{ 'is-file': !isDir, 'is-dir': isDir }"
      v-bind="{ 'data-path': props.node.path }"
      :tabindex="isTabbable ? 0 : -1"
      @click="onRowClick"
      @keydown="onRowKeydown"
    >
      <input
        type="checkbox"
        class="node-checkbox"
        :checked="props.node.checked"
        :indeterminate="props.node.indeterminate"
        :aria-label="checkboxLabel"
        tabindex="-1"
        @change="onCheck"
      />
      <span
        class="tree-expander"
        :class="{
          expanded: hasChildren && props.node.expanded,
          collapsed: hasChildren && !props.node.expanded,
          leaf: !hasChildren,
        }"
        @click="onToggleExpand"
      />
      <span class="node-icon"><vscode-icon :name="nodeIcon()" /></span>
      <span class="node-name">{{ props.node.name }}</span>
      <span v-if="!isDir && props.node.file" class="node-status" :class="statusClass(props.node.file.status)">
        {{ statusText(props.node.file.status) }}
      </span>
      <span
        v-if="!isDir && props.node.file && (props.node.file.additions || props.node.file.deletions)"
        class="node-stats"
      >
        <span v-if="props.node.file.additions" class="additions">+{{ props.node.file.additions }}</span>
        <span v-if="props.node.file.deletions" class="deletions">−{{ props.node.file.deletions }}</span>
      </span>
    </div>
    <ul v-if="isDir && props.node.expanded" class="file-tree-children" role="group">
      <!-- `aria-level` on the child row is not `level + 1` of the DOM depth:
           `role="group"` is not a treeitem, so the level stays the child's own
           depth (the owner passes it down). -->
      <FileTreeNode
        v-for="child in props.node.children"
        :key="child.path"
        :node="child"
        :focus-path="focusedPath"
        :level="props.level + 1"
        @toggle-expand="(childNode) => emit('toggleExpand', childNode)"
        @check="(childNode, checked) => emit('check', childNode, checked)"
        @open-diff="(filename, status, previousFilename) => emit('openDiff', filename, status, previousFilename)"
      />
    </ul>
  </li>
</template>

<style scoped>
.tree-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 0.9em;
  flex-wrap: wrap;
}

.tree-row:hover {
  background-color: var(--vscode-list-hoverBackground);
}

.tree-row.is-file,
.tree-row.is-dir {
  cursor: pointer;
}

.tree-row:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.node-checkbox {
  flex-shrink: 0;
  margin: 0;
}

.tree-expander {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--vscode-descriptionForeground);
  font-size: 0.75em;
}

.tree-expander.expanded::before {
  content: '▼';
}

.tree-expander.collapsed::before {
  content: '▶';
}

.tree-expander.leaf {
  cursor: default;
}

.tree-expander.leaf::before {
  content: '';
}

.node-icon {
  flex-shrink: 0;
  font-size: 0.95em;
}

.node-name {
  flex: 1 1 auto;
  word-break: break-all;
  color: var(--vscode-foreground);
}

.node-status {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 0.75em;
  text-transform: capitalize;
  font-weight: 500;
}

.status-added {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-gitDecoration-addedResourceForeground, #28a745);
}

.status-removed {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-gitDecoration-deletedResourceForeground, #d73a49);
}

.status-modified {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-gitDecoration-modifiedResourceForeground, #d7ba7d);
}

.status-renamed {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-gitDecoration-renamedResourceForeground, #73c991);
}

.node-stats {
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

.file-tree-children {
  list-style: none;
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
