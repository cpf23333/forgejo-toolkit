<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { FileTreeNode } from '../types/fileTree';

const { t } = useI18n();

interface Props {
  node: FileTreeNode;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  toggleExpand: [node: FileTreeNode];
  check: [node: FileTreeNode, checked: boolean];
  openDiff: [filename: string, status: string];
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
    emit('openDiff', props.node.file.filename, props.node.file.status ?? 'modified');
  }
}

function onRowClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (target.closest('.node-checkbox, .tree-expander, .view-diff-link')) {
    return;
  }
  if (isDir) {
    return;
  }
  openDiff();
}

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

function nodeIcon(): string {
  if (isDir) {
    return '📁';
  }
  const ext = props.node.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return '📘';
    case 'js':
    case 'jsx':
      return '📒';
    case 'vue':
      return '💚';
    case 'json':
      return '📋';
    case 'md':
      return '📝';
    case 'css':
    case 'scss':
    case 'less':
      return '🎨';
    case 'html':
      return '🌐';
    case 'yml':
    case 'yaml':
      return '⚙️';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
      return '🖼️';
    default:
      return '📄';
  }
}
</script>

<template>
  <li class="tree-node">
    <div class="tree-row" :class="{ 'is-file': !isDir }" @click="onRowClick">
      <input
        type="checkbox"
        class="node-checkbox"
        :checked="props.node.checked"
        :indeterminate="props.node.indeterminate"
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
      <span class="node-icon">{{ nodeIcon() }}</span>
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
    <ul v-if="isDir && props.node.expanded" class="file-tree-children">
      <FileTreeNode
        v-for="child in props.node.children"
        :key="child.path"
        :node="child"
        @toggle-expand="(childNode) => emit('toggleExpand', childNode)"
        @check="(childNode, checked) => emit('check', childNode, checked)"
        @open-diff="(filename, status) => emit('openDiff', filename, status)"
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

.tree-row.is-file {
  cursor: pointer;
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
