<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import EasyMDE from 'easymde';
import 'easymde/dist/easymde.min.css';
import 'tributejs/tribute.css';
import Tribute from 'tributejs';
import { isImageFile } from '../utils/file';
import { useAppState, type MentionUser, type MentionIssue } from '../composables/useAppState';

type MentionItem = MentionUser | MentionIssue;

const UPLOAD_FILE_TITLE = 'Upload File';
const INSERT_IMAGE_TITLE = 'Insert Image';

interface Props {
  modelValue?: string;
  placeholder?: string;
  uploadImage?: (file: File, onSuccess: (url: string) => void, onError: (error: string) => void) => void;
  disabled?: boolean;
  instanceId?: string;
  owner?: string;
  repo?: string;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  placeholder: '',
  disabled: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const { t } = useI18n();
const state = useAppState();

const wrapperRef = ref<HTMLDivElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
let easyMDE: EasyMDE | null = null;
let visibilityObserver: IntersectionObserver | null = null;
let tribute: Tribute<any> | null = null;

const mentionsEnabled = computed(
  () => props.instanceId !== undefined && props.owner !== undefined && props.repo !== undefined,
);

function getMentionInput(): HTMLElement | null {
  return easyMDE?.codemirror.getInputField() ?? null;
}

function isTributeActive(): boolean {
  const container = document.querySelector('.tribute-container') as HTMLElement | null;
  return container !== null && container.style.display !== 'none';
}

async function attachMentions() {
  if (!mentionsEnabled.value) {
    return;
  }
  const input = getMentionInput();
  if (!input || !wrapperRef.value) {
    return;
  }

  const { instanceId, owner, repo } = props as Required<Pick<Props, 'instanceId' | 'owner' | 'repo'>>;

  tribute = new Tribute({
    menuContainer: wrapperRef.value,
    collection: [
      {
        trigger: '@',
        requireLeadingSpace: true,
        lookup: (item: any) => item.name,
        selectTemplate: (item: any) => {
          const original = item.original as MentionUser;
          return `@${original.name} `;
        },
        menuItemTemplate: (item: any) => {
          const original = item.original as MentionUser;
          const avatar = original.avatar_url
            ? `<img src="${escapeHtml(original.avatar_url)}" class="mention-avatar" alt="" />`
            : `<span class="mention-avatar mention-avatar-fallback"><vscode-icon name="account" size="16"></vscode-icon></span>`;
          const fullName = original.full_name
            ? `<span class="mention-fullname">${escapeHtml(original.full_name)}</span>`
            : '';
          return `<div class="mention-item">${avatar}<span class="mention-name">${escapeHtml(original.name)}</span>${fullName}</div>`;
        },
        values: (text: string, callback: (result: any[]) => void) => {
          state
            .searchMentions(instanceId, owner, repo, text, 'user')
            .then((result) => callback(result.users))
            .catch(() => callback([]));
        },
      },
      {
        trigger: '#',
        requireLeadingSpace: true,
        lookup: (item: any) => `${item.value} ${item.title}`,
        selectTemplate: (item: any) => {
          const original = item.original as MentionIssue;
          return `#${original.value} `;
        },
        menuItemTemplate: (item: any) => {
          const original = item.original as MentionIssue;
          const icon = original.is_pull ? 'git-pull-request' : 'issues';
          const stateClass = original.state === 'open' ? 'state-open' : 'state-closed';
          return `<div class="mention-item mention-issue"><vscode-icon name="${icon}" size="14" class="mention-issue-icon ${stateClass}"></vscode-icon><span class="mention-issue-number">#${escapeHtml(original.value)}</span><span class="mention-issue-title">${escapeHtml(original.title)}</span></div>`;
        },
        values: (text: string, callback: (result: any[]) => void) => {
          state
            .searchMentions(instanceId, owner, repo, text, 'issue')
            .then((result) => callback(result.issues))
            .catch(() => callback([]));
        },
      },
    ],
    noMatchTemplate: () => '',
  });

  tribute.attach(input);
}

function detachMentions() {
  if (tribute) {
    const input = getMentionInput();
    if (input) {
      tribute.detach(input);
    }
    tribute = null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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

  easyMDE.codemirror.setOption('extraKeys', {
    Enter: (cm) => {
      if (!isTributeActive()) {
        cm.execCommand('newlineAndIndent');
      }
    },
    Up: (cm) => {
      if (!isTributeActive()) {
        cm.execCommand('goLineUp');
      }
    },
    Down: (cm) => {
      if (!isTributeActive()) {
        cm.execCommand('goLineDown');
      }
    },
  });

  if (props.disabled) {
    easyMDE.codemirror.setOption('readOnly', true);
  } else {
    attachMentions();
  }

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
  detachMentions();
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

watch(
  () => props.disabled,
  (disabled) => {
    easyMDE?.codemirror.setOption('readOnly', disabled);
    if (disabled) {
      detachMentions();
    } else {
      detachMentions();
      attachMentions();
    }
  },
);

watch(
  () => [props.instanceId, props.owner, props.repo],
  () => {
    detachMentions();
    if (!props.disabled) {
      attachMentions();
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
.easy-mde-editor {
  position: relative;
}

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

.easy-mde-editor :deep(.tribute-container) {
  position: absolute;
  z-index: 100;
  margin-top: 1.2em;
  background-color: var(--vscode-editorHoverWidget-background) !important;
  border: 1px solid var(--vscode-editorHoverWidget-border) !important;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  color: var(--vscode-editorHoverWidget-foreground) !important;
  max-height: 240px;
  overflow-y: auto;
  font-size: 0.9em;
}

.easy-mde-editor :deep(.tribute-container ul) {
  margin: 0;
  padding: 4px 0;
  list-style: none;
}

.easy-mde-editor :deep(.tribute-container li) {
  padding: 6px 12px;
  cursor: pointer;
  color: var(--vscode-editorHoverWidget-foreground) !important;
}

.easy-mde-editor :deep(.tribute-container li.highlight) {
  background-color: var(--vscode-list-activeSelectionBackground) !important;
  color: var(--vscode-list-activeSelectionForeground) !important;
}

.easy-mde-editor :deep(.mention-item) {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.easy-mde-editor :deep(.mention-avatar) {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex-shrink: 0;
}

.easy-mde-editor :deep(.mention-avatar-fallback) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.easy-mde-editor :deep(.mention-fullname) {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.easy-mde-editor :deep(.mention-issue-number) {
  flex-shrink: 0;
  color: var(--vscode-textLink-foreground);
}

.easy-mde-editor :deep(.mention-issue-title) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.easy-mde-editor :deep(.mention-issue-icon.state-open) {
  color: var(--vscode-gitDecoration-untrackedResourceForeground);
}

.easy-mde-editor :deep(.mention-issue-icon.state-closed) {
  color: var(--vscode-gitDecoration-deletedResourceForeground);
}
</style>
