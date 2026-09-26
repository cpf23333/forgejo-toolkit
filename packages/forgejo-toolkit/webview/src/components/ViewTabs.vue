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

// Arrow-key navigation: Left/Right moves focus and activates the tab
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
// A group of toggle buttons, not an ARIA tab widget.
//
// It carried `role="tablist"`/`role="tab"` with `aria-selected` but rendered no
// `role="tabpanel"` and no `aria-controls` anywhere: the views that use it
// (Dashboard, GlobalSearch, RepoDetail) own the panel themselves and swap it by
// `v-if`, so there was no element for a tab to point at. A tab that controls
// nothing is worse than a button, because assistive technology then announces a
// widget contract — arrow keys, `aria-controls`-driven panel switching — that
// the markup does not keep.
//
// The buttons stay buttons, and `aria-pressed` carries the chosen state the way
// any toggle button does. Arrow-key navigation and the roving `tabindex` stay:
// they are a deliberate part of this control's keyboard behaviour (and are
// pinned by its tests), not a claim about a tab widget.
</script>

<template>
  <div class="view-tabs" @keydown="onKeydown">
    <button
      v-for="tab in props.tabs"
      :key="tab.key"
      class="tab-button"
      :class="{ active: props.modelValue === tab.key }"
      type="button"
      :aria-pressed="props.modelValue === tab.key"
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
  /* Shrinkable with ellipsis: in a narrow sidebar all tabs stay visible
     instead of the overflow clipping one mid-word. */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 6px 12px;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 0.9em;
  white-space: nowrap;
}

/* No hover background: a filled block next to the active tab's underline
   reads as a second active tab. Preview the underline instead. */
.tab-button:not(.active):hover {
  border-bottom-color: var(--vscode-descriptionForeground);
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
