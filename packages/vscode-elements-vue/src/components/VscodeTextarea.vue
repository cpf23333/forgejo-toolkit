<script setup lang="ts">
interface Props {
  modelValue?: string;
  placeholder?: string;
  rows?: number;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  placeholder: '',
  rows: 8,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

function onInput(event: Event) {
  const target = event.target as HTMLTextAreaElement;
  emit('update:modelValue', target.value);
}
</script>

<template>
  <vscode-textarea :value="modelValue" :placeholder="placeholder" :rows="rows" @input="onInput" />
</template>
