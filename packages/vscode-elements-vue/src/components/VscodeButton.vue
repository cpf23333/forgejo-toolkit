<script setup lang="ts">
import { computed, useSlots } from 'vue';

interface Props {
  variant?: 'primary' | 'secondary' | 'icon';
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  icon?: string;
  iconAfter?: string;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'secondary',
  disabled: false,
  type: 'button',
});

const emit = defineEmits<{
  (e: 'click', event: MouseEvent): void;
}>();

const slots = useSlots();
const variantClass = computed(() => `variant-${props.variant}`);
const isSecondary = computed(() => props.variant === 'secondary');
const isIconOnly = computed(() => props.variant === 'icon' && !slots.default);
</script>

<template>
  <vscode-button
    :class="variantClass"
    :disabled="disabled"
    :type="type"
    :icon="icon"
    :icon-after="iconAfter"
    :secondary="isSecondary ? true : undefined"
    :icon-only="isIconOnly ? true : undefined"
    @click="(event) => emit('click', event as MouseEvent)"
  >
    <slot />
  </vscode-button>
</template>
