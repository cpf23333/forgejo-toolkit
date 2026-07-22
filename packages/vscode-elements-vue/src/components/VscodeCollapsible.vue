<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  heading?: string;
  description?: string;
  open?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  heading: '',
  description: '',
  open: false,
});

const emit = defineEmits<{
  (e: 'toggle', open: boolean): void;
}>();

const isOpen = computed(() => props.open);
const hasDescription = computed(() => Boolean(props.description));

function toggle() {
  emit('toggle', !isOpen.value);
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    toggle();
  }
}
</script>

<template>
  <div class="collapsible" :class="{ open: isOpen }">
    <div
      class="collapsible-header"
      tabindex="0"
      role="button"
      :aria-expanded="isOpen"
      @click="toggle"
      @keydown="onKeyDown"
    >
      <svg class="chevron" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" :class="{ rotated: isOpen }">
        <path
          d="M4.427 9.427l3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 9H4.604a.25.25 0 0 0-.177.427z"
        />
      </svg>
      <h3 class="title">
        {{ heading }}
        <span v-if="hasDescription" class="description">{{ description }}</span>
      </h3>
      <div class="header-slots">
        <slot name="decorations" />
      </div>
    </div>
    <div v-show="isOpen" class="collapsible-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.collapsible {
  display: block;
}

.collapsible-header {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 4px;
  background-color: var(--vscode-sideBarSectionHeader-background);
  color: var(--vscode-sideBarTitle-foreground);
  cursor: pointer;
  user-select: none;
}

.collapsible-header:focus {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.chevron {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  transition: transform 0.1s;
}

.chevron.rotated {
  transform: rotate(180deg);
}

.title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  line-height: 22px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.description {
  margin-left: 10px;
  font-weight: 400;
  opacity: 0.6;
}

.header-slots {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.collapsible-body {
  padding: 8px 0;
}
</style>
