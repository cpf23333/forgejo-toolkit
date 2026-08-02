<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { isImageFile } from '../utils/file';

interface Props {
  files: File[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  remove: [index: number];
}>();

const { t } = useI18n();

const objectUrls = ref<Map<File, string>>(new Map());

function syncObjectUrls() {
  const files = props.files;
  const currentFiles = new Set(files);
  for (const [file, url] of objectUrls.value) {
    if (!currentFiles.has(file)) {
      URL.revokeObjectURL(url);
      objectUrls.value.delete(file);
    }
  }
  for (const file of files) {
    if (isImageFile(file) && !objectUrls.value.has(file)) {
      objectUrls.value.set(file, URL.createObjectURL(file));
    }
  }
}

watch(() => props.files.map((f) => `${f.name}-${f.size}-${f.lastModified}`).join(','), syncObjectUrls, {
  immediate: true,
});

onUnmounted(() => {
  for (const url of objectUrls.value.values()) {
    URL.revokeObjectURL(url);
  }
  objectUrls.value.clear();
});

function handleRemove(index: number) {
  emit('remove', index);
}

function formatBytes(bytes?: number): string {
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
  <ul v-if="files.length > 0" class="pending-attachment-list">
    <li v-for="(file, idx) in files" :key="`${file.name}-${idx}`" class="pending-attachment-item">
      <img v-if="isImageFile(file)" :src="objectUrls.get(file)" :alt="file.name" class="pending-attachment-preview" />
      <span class="pending-attachment-name">{{ file.name }}</span>
      <span v-if="file.size !== undefined" class="pending-attachment-size">{{ formatBytes(file.size) }}</span>
      <button type="button" class="pending-attachment-remove" @click="handleRemove(idx)">
        {{ t('dashboard.remove') }}
      </button>
    </li>
  </ul>
</template>

<style scoped>
.pending-attachment-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pending-attachment-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
}

.pending-attachment-preview {
  width: 32px;
  height: 32px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}

.pending-attachment-name {
  font-size: 0.9em;
  color: var(--vscode-foreground);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pending-attachment-size {
  color: var(--vscode-descriptionForeground);
  font-size: 0.8em;
  flex-shrink: 0;
}

.pending-attachment-remove {
  background-color: transparent;
  color: var(--vscode-errorForeground);
  border: 1px solid var(--vscode-errorForeground);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 0.8em;
  cursor: pointer;
  flex-shrink: 0;
}

.pending-attachment-remove:hover {
  background-color: var(--vscode-errorForeground);
  color: var(--vscode-button-foreground);
}
</style>
