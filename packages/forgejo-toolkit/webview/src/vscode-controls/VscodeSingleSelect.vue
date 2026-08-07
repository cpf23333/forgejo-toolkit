<script setup lang="ts">
interface Props {
  modelValue?: string | number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | number | undefined): void;
}>();

function onChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  const value = target.value;
  if (value === '') {
    emit('update:modelValue', undefined);
    return;
  }
  const num = Number(value);
  emit('update:modelValue', Number.isNaN(num) ? value : num);
}
</script>

<template>
  <vscode-single-select :value="modelValue" @change="onChange">
    <slot />
  </vscode-single-select>
</template>
