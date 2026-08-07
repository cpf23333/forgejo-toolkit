<script setup lang="ts">
import { ref } from 'vue';

interface Props {
  title: string;
  defaultExpanded?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  defaultExpanded: true,
});

const expanded = ref(props.defaultExpanded);

function toggle() {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div class="collapsible-section" :class="{ expanded }">
    <button type="button" class="collapsible-header" @click="toggle">
      <span class="collapsible-title">{{ title }}</span>
      <vscode-icon class="collapsible-icon" name="chevron-right" />
    </button>
    <div v-show="expanded" class="collapsible-content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.collapsible-section {
  border-bottom: 1px solid var(--vscode-panel-border);
  overflow-x: hidden;
}

.collapsible-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 0;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 0.9em;
  font-weight: 600;
  overflow: hidden;
}

.collapsible-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.collapsible-header:hover {
  color: var(--vscode-textLink-foreground);
}

.collapsible-icon {
  transition: transform 0.2s;
  flex-shrink: 0;
}

.collapsible-section.expanded .collapsible-icon {
  transform: rotate(90deg);
}

.collapsible-content {
  padding-bottom: 12px;
  min-width: 0;
}
</style>
