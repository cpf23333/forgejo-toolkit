<script setup lang="ts">
interface Props {
  modelValue?: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

function rfc3339ToDatetimeLocal(value?: string): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function datetimeLocalToRfc3339(value: string): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  const offset = -date.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(offset) / 60);
  const offsetMinutes = Math.abs(offset) % 60;
  const offsetSign = offset >= 0 ? '+' : '-';
  const offsetStr = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
  return `${value}:00${offsetStr}`;
}

function onInput(event: Event) {
  const target = event.target as HTMLInputElement;
  emit('update:modelValue', datetimeLocalToRfc3339(target.value));
}
</script>

<template>
  <vscode-textfield type="datetime-local" :value="rfc3339ToDatetimeLocal(modelValue)" @input="onInput" />
</template>
