<script setup lang="ts">
import { ref, useId } from 'vue';

interface Props {
  title: string;
  defaultExpanded?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  defaultExpanded: true,
});

const expanded = ref(props.defaultExpanded);

// One id per section instance (`useId` is unique per component), so the
// trigger's `aria-controls` names this section's own content instead of
// whichever section happens to render first.
const contentId = `collapsible-section-content-${useId()}`;

function toggle() {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div class="collapsible-section" :class="{ expanded }">
    <!-- The header is the disclosure trigger: without `aria-expanded` the open
         state is carried only by the rotated chevron, which a screen reader
         cannot read as a state, and `aria-controls` ties the content to it. -->
    <button
      type="button"
      class="collapsible-header"
      :aria-expanded="expanded"
      :aria-controls="contentId"
      @click="toggle"
    >
      <span class="collapsible-title">{{ title }}</span>
      <vscode-icon class="collapsible-icon" name="chevron-right" />
    </button>
    <div v-show="expanded" :id="contentId" class="collapsible-content">
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
