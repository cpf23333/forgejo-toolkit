<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppState } from '../composables/useAppState';

interface Props {
  open?: boolean;
  title?: string;
  loading?: boolean;
  closeOnBackdropClick?: boolean;
  closeOnEsc?: boolean;
  confirmCloseIfDirty?: boolean;
  isDirty?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  title: '',
  loading: false,
  closeOnBackdropClick: false,
  closeOnEsc: true,
  confirmCloseIfDirty: false,
  isDirty: false,
});

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();
const state = useAppState();

const dialogRef = ref<HTMLDialogElement | null>(null);

function updateDialog(open: boolean) {
  if (open) {
    dialogRef.value?.showModal();
  } else {
    dialogRef.value?.close();
  }
}

onMounted(() => {
  if (props.open) {
    updateDialog(true);
  }
});

watch(
  () => props.open,
  (open) => {
    updateDialog(open);
  },
);

// Guards against duplicate confirm dialogs while one showConfirm call is pending.
const confirmCloseInFlight = ref(false);

async function requestClose() {
  if (props.confirmCloseIfDirty && props.isDirty) {
    if (confirmCloseInFlight.value) {
      return;
    }
    confirmCloseInFlight.value = true;
    try {
      if (await state.showConfirm(t('common.discardChangesConfirm'))) {
        emit('close');
      }
    } finally {
      confirmCloseInFlight.value = false;
    }
    return;
  }
  emit('close');
}

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
    void requestClose();
  }
}

function handleCancel(event: Event) {
  if (props.loading || !props.closeOnEsc) {
    event.preventDefault();
    return;
  }
  // Intercept the Esc close before the dialog actually closes so we can ask
  // for confirmation first; preventing cancel keeps the dialog open meanwhile.
  if (props.confirmCloseIfDirty && props.isDirty) {
    event.preventDefault();
    void requestClose();
  }
}

function handleClose() {
  // Native closes (e.g. Esc) bypass our emit paths; forward them so parents can
  // reset their state. Skip when the parent already closed us via the open prop
  // (props.open is false) or while loading (cancel is prevented anyway).
  if (props.loading || !props.open) {
    return;
  }
  emit('close');
}
</script>

<template>
  <dialog ref="dialogRef" class="modal-dialog" @click="handleClick" @cancel="handleCancel" @close="handleClose">
    <div class="modal-header">
      <h3 v-if="title" class="modal-title">{{ title }}</h3>
      <button v-if="!loading" type="button" class="modal-close" aria-label="Close" @click="requestClose">×</button>
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
