<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  variant?: 'primary' | 'secondary' | 'icon';
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'secondary',
  disabled: false,
  type: 'button',
});

const emit = defineEmits<{
  (e: 'click', event: MouseEvent): void;
}>();

const variantClass = computed(() => `variant-${props.variant}`);
</script>

<template>
  <vscode-button
    :class="variantClass"
    :disabled="disabled"
    :type="type"
    @click="(event) => emit('click', event as MouseEvent)"
  >
    <slot />
  </vscode-button>
</template>
