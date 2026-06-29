<script setup lang="ts">
interface Props {
  modelValue?: string;
  placeholder?: string;
  type?: 'text' | 'password' | 'url';
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  placeholder: '',
  type: 'text',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

function onInput(event: Event) {
  const target = event.target as HTMLInputElement;
  emit('update:modelValue', target.value);
}
</script>

<template>
  <vscode-textfield
    :value="modelValue"
    :placeholder="placeholder"
    :type="type"
    @input="onInput"
  />
</template>
