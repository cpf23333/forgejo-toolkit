<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ForgejoIssueAttachment } from '../types/api';

const props = defineProps<{
  assets?: ForgejoIssueAttachment[];
}>();

const emit = defineEmits<{
  (e: 'openExternal', url: string): void;
}>();

const { t } = useI18n();

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
  <div v-if="assets?.length" class="detail-section">
    <h3>{{ t('dashboard.detail.attachments') }}</h3>
    <ul class="attachment-list">
      <li v-for="asset in assets" :key="asset.uuid ?? asset.name ?? ''" class="attachment-item">
        <span class="attachment-name" @click="emit('openExternal', asset.browser_download_url ?? '')">{{
          asset.name
        }}</span>
        <span v-if="asset.size" class="attachment-size">{{ formatFileSize(asset.size) }}</span>
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
