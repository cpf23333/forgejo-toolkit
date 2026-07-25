<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import EasyMDE from 'easymde';
import 'easymde/dist/easymde.min.css';
import { isImageFile } from '../utils/file';

const UPLOAD_FILE_TITLE = 'Upload File';
const INSERT_IMAGE_TITLE = 'Insert Image';

interface Props {
  modelValue?: string;
  placeholder?: string;
  uploadImage?: (file: File, onSuccess: (url: string) => void, onError: (error: string) => void) => void;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  placeholder: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const { t } = useI18n();

const wrapperRef = ref<HTMLDivElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
let easyMDE: EasyMDE | null = null;
let visibilityObserver: IntersectionObserver | null = null;

onMounted(() => {
  if (!textareaRef.value) {
    return;
  }

  const uploadEnabled = props.uploadImage !== undefined;

  const options: EasyMDE.Options = {
    element: textareaRef.value,
    initialValue: props.modelValue,
    placeholder: props.placeholder,
    spellChecker: false,
    status: false,
    autoDownloadFontAwesome: false,
    minHeight: '120px',
    toolbar: [
      'bold',
      'italic',
      'heading',
      '|',
      'quote',
      'unordered-list',
      'ordered-list',
      '|',
      'link',
      {
        name: uploadEnabled ? 'upload-image' : 'image',
        action: uploadEnabled ? EasyMDE.drawUploadedImage : EasyMDE.drawImage,
        className: uploadEnabled ? 'fa fa-upload' : 'fa fa-image',
        title: uploadEnabled ? UPLOAD_FILE_TITLE : INSERT_IMAGE_TITLE,
      },
      '|',
      'preview',
      'side-by-side',
      'fullscreen',
      '|',
      'guide',
    ],
    uploadImage: uploadEnabled,
    imageAccept: 'image/*',
    imageUploadFunction: uploadEnabled
      ? (file, onSuccess, onError) => {
          if (!isImageFile(file)) {
            onError(t('dashboard.form.imageOnly'));
            return;
          }
          props.uploadImage!(
            file,
            (url) => {
              easyMDE?.codemirror.replaceSelection(`![image](${url})`);
            },
            onError,
          );
        }
      : undefined,
    errorCallback: () => {
      // Suppress the default alert() which is blocked in VS Code webviews.
      // Permission errors are reported via the extension host notification.
    },
  };

  easyMDE = new EasyMDE(options);
  easyMDE.codemirror.on('change', () => {
    emit('update:modelValue', easyMDE?.value() ?? '');
  });

  if (wrapperRef.value) {
    visibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.boundingClientRect.width > 0 && entry.boundingClientRect.height > 0) {
          easyMDE?.codemirror.refresh();
        }
      }
    });
    visibilityObserver.observe(wrapperRef.value);
  }
});

onUnmounted(() => {
  visibilityObserver?.disconnect();
  visibilityObserver = null;
  easyMDE?.cleanup();
  easyMDE = null;
});

watch(
  () => props.modelValue,
  (value) => {
    if (easyMDE && easyMDE.value() !== value) {
      easyMDE.value(value);
    }
  },
);
</script>

<template>
  <div ref="wrapperRef" class="easy-mde-editor">
    <textarea ref="textareaRef"></textarea>
  </div>
</template>

<style scoped>
.easy-mde-editor :deep(.EasyMDEContainer) {
  color: var(--vscode-foreground);
}

.easy-mde-editor :deep(.editor-toolbar) {
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-color: var(--vscode-panel-border);
}

.easy-mde-editor :deep(.editor-toolbar button) {
  color: var(--vscode-foreground);
}

.easy-mde-editor :deep(.editor-toolbar button:hover) {
  background-color: var(--vscode-toolbar-hoverBackground);
}

.easy-mde-editor :deep(.CodeMirror) {
  background-color: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border-color: var(--vscode-panel-border);
}

.easy-mde-editor :deep(.CodeMirror-cursor) {
  border-color: var(--vscode-foreground);
}

.easy-mde-editor :deep(.editor-preview) {
  background-color: var(--vscode-editor-background);
}
</style>
