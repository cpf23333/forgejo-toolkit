<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ForgejoIssueAttachment } from '../types/api';

const props = withDefaults(
  defineProps<{
    assets?: ForgejoIssueAttachment[];
    allowUpload?: boolean;
    allowDelete?: boolean;
    uploading?: boolean;
    deletingId?: number;
    deletingIds?: number[];
    pendingDeleteIds?: number[];
    showHeader?: boolean;
    /**
     * The attachment lookup failed, so an empty `assets` list is not an answer.
     * The list then renders a notice saying it could not be loaded instead of
     * hiding the section, which used to read as "this item has no attachments".
     */
    attachmentsUnavailable?: boolean;
  }>(),
  {
    showHeader: true,
  },
);

function isDeleting(id?: number): boolean {
  if (id === undefined) {
    return false;
  }
  if (props.deletingIds?.includes(id)) {
    return true;
  }
  return props.deletingId !== undefined && props.deletingId === id;
}

const emit = defineEmits<{
  (e: 'openExternal', url: string): void;
  (e: 'upload', file: File): void;
  (e: 'delete', asset: ForgejoIssueAttachment): void;
}>();

const { t } = useI18n();
const fileInputRef = ref<HTMLInputElement | null>(null);

function triggerFileInput() {
  fileInputRef.value?.click();
}

function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement;
  const files = target.files;
  if (files) {
    for (const file of files) {
      emit('upload', file);
    }
  }
  target.value = '';
}

function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <div v-if="attachmentsUnavailable || assets?.length || allowUpload" class="detail-section">
    <div v-if="showHeader" class="attachment-header">
      <h3>{{ t('dashboard.detail.attachments') }}</h3>
      <button v-if="allowUpload" type="button" class="upload-button" :disabled="uploading" @click="triggerFileInput">
        {{ uploading ? t('dashboard.form.saving') : t('dashboard.actions.uploadAttachment') }}
      </button>
      <input ref="fileInputRef" type="file" multiple class="file-input" @change="handleFileChange" />
    </div>
    <!-- A failed lookup arrives as an empty list: without this the section said
         the item has no attachments, so a user whose attachment was still there
         concluded it had been deleted. -->
    <div v-if="attachmentsUnavailable" class="attachment-unavailable" role="status">
      <vscode-icon name="warning" />
      <span>{{ t('dashboard.detail.attachmentsUnavailable') }}</span>
    </div>
    <ul v-if="assets?.length" class="attachment-list">
      <li
        v-for="asset in assets"
        :key="asset.uuid ?? asset.name ?? ''"
        class="attachment-item"
        :class="{ 'pending-delete': asset.id !== undefined && pendingDeleteIds?.includes(asset.id) }"
      >
        <span
          class="attachment-name"
          tabindex="0"
          role="link"
          @click="emit('openExternal', asset.browser_download_url ?? '')"
          @keydown.enter="emit('openExternal', asset.browser_download_url ?? '')"
          @keydown.space.prevent="emit('openExternal', asset.browser_download_url ?? '')"
          >{{ asset.name }}</span
        >
        <span v-if="asset.size" class="attachment-size">{{ formatFileSize(asset.size) }}</span>
        <button
          v-if="allowDelete"
          type="button"
          class="delete-button"
          :disabled="asset.id !== undefined && isDeleting(asset.id)"
          @click="emit('delete', asset)"
        >
          {{
            asset.id !== undefined && pendingDeleteIds?.includes(asset.id)
              ? t('dashboard.actions.undoDelete')
              : t('dashboard.actions.delete')
          }}
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.detail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.detail-section h3 {
  margin: 0;
  font-size: 0.95rem;
  color: var(--vscode-foreground);
}

.attachment-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.attachment-unavailable {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.upload-button {
  background-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 0.85em;
  cursor: pointer;
}

.upload-button:hover:not(:disabled) {
  background-color: var(--vscode-button-hoverBackground);
}

.upload-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.delete-button {
  background-color: transparent;
  color: var(--vscode-errorForeground);
  border: 1px solid var(--vscode-errorForeground);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 0.8em;
  cursor: pointer;
  margin-left: auto;
}

.delete-button:hover:not(:disabled) {
  background-color: var(--vscode-errorForeground);
  color: var(--vscode-button-foreground);
}

.delete-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.file-input {
  display: none;
}

.attachment-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attachment-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
}

.attachment-item.pending-delete {
  opacity: 0.6;
}

.attachment-item.pending-delete .attachment-name {
  text-decoration: line-through;
  color: var(--vscode-descriptionForeground);
}

.attachment-name {
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  font-size: 0.9em;
}

.attachment-name:hover {
  text-decoration: underline;
}

.attachment-size {
  color: var(--vscode-descriptionForeground);
  font-size: 0.8em;
}
</style>
