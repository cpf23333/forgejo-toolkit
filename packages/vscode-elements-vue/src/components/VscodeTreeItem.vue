<script setup lang="ts">
interface Props {
  active?: boolean;
  branch?: boolean;
  open?: boolean;
  level?: number;
  selected?: boolean;
}

withDefaults(defineProps<Props>(), {
  active: false,
  branch: false,
  open: false,
  level: 0,
  selected: false,
});
</script>

<template>
  <vscode-tree-item
    :active="active || undefined"
    :branch="branch || undefined"
    :open="open || undefined"
    :level="level"
    :selected="selected || undefined"
  >
    <slot />
    <template v-if="$slots.description" #description>
      <slot name="description" />
    </template>
    <template v-if="$slots.actions" #actions>
      <slot name="actions" />
    </template>
    <template v-if="$slots.decoration" #decoration>
      <slot name="decoration" />
    </template>
    <template v-if="$slots['icon-branch']" #icon-branch>
      <slot name="icon-branch" />
    </template>
    <template v-if="$slots['icon-branch-opened']" #icon-branch-opened>
      <slot name="icon-branch-opened" />
    </template>
    <template v-if="$slots['icon-leaf']" #icon-leaf>
      <slot name="icon-leaf" />
    </template>
  </vscode-tree-item>
</template>
