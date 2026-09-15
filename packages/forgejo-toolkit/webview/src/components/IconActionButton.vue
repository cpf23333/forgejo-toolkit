<script setup lang="ts">
interface Props {
  name: string;
  label: string;
  size?: number;
}

withDefaults(defineProps<Props>(), { size: 16 });

const emit = defineEmits<{
  click: [event: MouseEvent];
}>();
</script>

<template>
  <button type="button" class="icon-action-button" :title="label" :aria-label="label" @click="emit('click', $event)">
    <i class="codicon" :class="`codicon-${name}`" :style="{ fontSize: `${size}px` }" aria-hidden="true"></i>
  </button>
</template>

<style scoped>
.icon-action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  margin: 0;
  background-color: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--vscode-icon-foreground, currentColor);
  cursor: pointer;
}

.icon-action-button:hover {
  background-color: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
}

.icon-action-button:active {
  background-color: var(--vscode-toolbar-activeBackground, rgba(99, 102, 103, 0.31));
}

.icon-action-button:focus-visible {
  outline: none;
  border-color: var(--vscode-focusBorder);
}
</style>
