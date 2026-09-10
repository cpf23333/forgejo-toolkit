<script setup lang="ts" generic="T extends string">
export interface TabItem {
  key: string;
  label: string;
}

interface Props {
  tabs: TabItem[];
  modelValue: T;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'update:modelValue', key: T): void;
}>();

function selectTab(key: string) {
  emit('update:modelValue', key as T);
}

// ARIA tabs keyboard pattern: Left/Right moves focus and activates the tab
// (automatic activation); only the active tab stays in the tab order.
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
    return;
  }
  event.preventDefault();
  const keys = props.tabs.map((tab) => tab.key);
  const current = keys.indexOf(props.modelValue);
  const delta = event.key === 'ArrowRight' ? 1 : -1;
  const next = (current + delta + keys.length) % keys.length;
  emit('update:modelValue', keys[next] as T);
  const buttons = (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('.tab-button');
  buttons[next]?.focus();
}
</script>

<template>
  <div class="view-tabs" role="tablist" @keydown="onKeydown">
    <button
      v-for="tab in props.tabs"
      :key="tab.key"
      class="tab-button"
      :class="{ active: props.modelValue === tab.key }"
      role="tab"
      :aria-selected="props.modelValue === tab.key"
      :tabindex="props.modelValue === tab.key ? 0 : -1"
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
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.view-tabs::-webkit-scrollbar {
  display: none;
}

.tab-button {
  flex: 0 0 auto;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 6px 12px;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 0.9em;
  white-space: nowrap;
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
