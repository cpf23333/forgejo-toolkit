<script setup lang="ts">
import { ref, watch } from 'vue';

interface Props {
  open?: boolean;
  title?: string;
  loading?: boolean;
  closeOnBackdropClick?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  title: '',
  loading: false,
  closeOnBackdropClick: false,
});

const emit = defineEmits<{
  close: [];
}>();

const dialogRef = ref<HTMLDialogElement | null>(null);

watch(
  () => props.open,
  (open) => {
    if (open) {
      dialogRef.value?.showModal();
    } else {
      dialogRef.value?.close();
    }
  },
);

function handleClick(event: MouseEvent) {
  if (!props.closeOnBackdropClick || props.loading) {
    return;
  }
  const rect = dialogRef.value?.getBoundingClientRect();
  if (!rect) {
    return;
  }
  const isInDialog =
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;
  if (!isInDialog) {
    emit('close');
  }
}

function handleCancel(event: Event) {
  if (props.loading) {
    event.preventDefault();
  }
}
</script>

<template>
  <dialog ref="dialogRef" class="modal-dialog" @click="handleClick" @cancel="handleCancel">
    <div class="modal-header">
      <h3 v-if="title" class="modal-title">{{ title }}</h3>
      <button v-if="!loading" type="button" class="modal-close" aria-label="Close" @click="emit('close')">×</button>
    </div>
    <div class="modal-body">
      <slot />
    </div>
  </dialog>
</template>

<style scoped>
.modal-dialog {
  background-color: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 0;
  width: min(520px, calc(100vw - 32px));
  max-width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
}

.modal-dialog::backdrop {
  background-color: rgba(0, 0, 0, 0.5);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.modal-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.modal-close {
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.modal-close:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
}

.modal-body {
  padding: 16px;
}
</style>
