<script setup lang="ts">
interface Props {
  expandMode?: 'singleClick' | 'doubleClick';
  hideArrows?: boolean;
  indent?: number;
  indentGuides?: 'none' | 'onHover' | 'always';
  multiSelect?: boolean;
}

withDefaults(defineProps<Props>(), {
  expandMode: 'singleClick',
  hideArrows: false,
  indent: 8,
  indentGuides: 'onHover',
  multiSelect: false,
});

const emit = defineEmits<{
  select: [selectedItems: unknown[]];
}>();

function onSelect(event: Event) {
  const customEvent = event as CustomEvent<{ selectedItems: unknown[] }>;
  emit('select', customEvent.detail?.selectedItems ?? []);
}
</script>

<template>
  <vscode-tree
    :expand-mode="expandMode"
    :hide-arrows="hideArrows || undefined"
    :indent="indent"
    :indent-guides="indentGuides"
    :multi-select="multiSelect || undefined"
    @vsc-tree-select="onSelect"
  >
    <slot />
  </vscode-tree>
</template>
