<script setup lang="ts">
export interface TabItem {
  key: string;
  label: string;
}

interface Props {
  tabs: TabItem[];
  modelValue: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'update:modelValue', key: string): void;
}>();

function selectTab(key: string) {
  emit('update:modelValue', key);
}
</script>

<template>
  <div class="view-tabs" role="tablist">
    <button
      v-for="tab in props.tabs"
      :key="tab.key"
      class="tab-button"
      :class="{ active: props.modelValue === tab.key }"
      role="tab"
      :aria-selected="props.modelValue === tab.key"
      @click="selectTab(tab.key)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<style scoped>
.view-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.tab-button {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 6px 12px;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 0.9em;
}

.tab-button:hover {
  background-color: var(--vscode-list-hoverBackground);
}

.tab-button.active {
  border-bottom-color: var(--vscode-focusBorder);
  font-weight: 600;
}

.tab-button:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -2px;
}
</style>
