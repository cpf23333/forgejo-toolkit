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

type ToolbarScene = 'default' | 'wiki';

interface Props {
  modelValue?: string;
  placeholder?: string;
  uploadImage?: (file: File, onSuccess: (url: string) => void, onError: (error: string) => void) => void;
  disabled?: boolean;
  instanceId?: string;
  owner?: string;
  repo?: string;
  scene?: ToolbarScene;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  placeholder: '',
  disabled: false,
  scene: 'default',
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

function buildToolbar(uploadEnabled: boolean): NonNullable<EasyMDE.Options['toolbar']> {
  const imageAction = uploadEnabled
    ? {
        name: 'upload-image',
        action: EasyMDE.drawUploadedImage,
        className: 'fa fa-upload',
        title: t('editor.toolbar.uploadImage'),
      }
    : {
        name: 'image',
        action: EasyMDE.drawImage,
        className: 'fa fa-image',
        title: t('editor.toolbar.image'),
      };

  const builtin: Record<string, EasyMDE.ToolbarIcon> = {
    heading: {
      name: 'heading',
      action: EasyMDE.toggleHeadingSmaller,
      className: 'fa fa-header',
      title: t('editor.toolbar.heading'),
    },
    'heading-1': {
      name: 'heading-1',
      action: EasyMDE.toggleHeading1,
      className: 'fa fa-header',
      title: `${t('editor.toolbar.heading')} 1`,
    },
    'heading-2': {
      name: 'heading-2',
      action: EasyMDE.toggleHeading2,
      className: 'fa fa-header',
      title: `${t('editor.toolbar.heading')} 2`,
    },
    'heading-3': {
      name: 'heading-3',
      action: EasyMDE.toggleHeading3,
      className: 'fa fa-header',
      title: `${t('editor.toolbar.heading')} 3`,
    },
    'heading-bigger': {
      name: 'heading-bigger',
      action: EasyMDE.toggleHeadingBigger,
      className: 'fa fa-header',
      title: t('editor.toolbar.heading'),
    },
    'heading-smaller': {
      name: 'heading-smaller',
      action: EasyMDE.toggleHeadingSmaller,
      className: 'fa fa-header',
      title: t('editor.toolbar.heading'),
    },
    bold: { name: 'bold', action: EasyMDE.toggleBold, className: 'fa fa-bold', title: t('editor.toolbar.bold') },
    italic: {
      name: 'italic',
      action: EasyMDE.toggleItalic,
      className: 'fa fa-italic',
      title: t('editor.toolbar.italic'),
    },
    strikethrough: {
      name: 'strikethrough',
      action: EasyMDE.toggleStrikethrough,
      className: 'fa fa-strikethrough',
      title: t('editor.toolbar.strikethrough'),
    },
    quote: {
      name: 'quote',
      action: EasyMDE.toggleBlockquote,
      className: 'fa fa-quote-left',
      title: t('editor.toolbar.quote'),
    },
    code: { name: 'code', action: EasyMDE.toggleCodeBlock, className: 'fa fa-code', title: t('editor.toolbar.code') },
    link: { name: 'link', action: EasyMDE.drawLink, className: 'fa fa-link', title: t('editor.toolbar.link') },
    image: { name: 'image', action: EasyMDE.drawImage, className: 'fa fa-image', title: t('editor.toolbar.image') },
    table: { name: 'table', action: EasyMDE.drawTable, className: 'fa fa-table', title: t('editor.toolbar.table') },
    'horizontal-rule': {
      name: 'horizontal-rule',
      action: EasyMDE.drawHorizontalRule,
      className: 'fa fa-minus',
      title: t('editor.toolbar.horizontalRule'),
    },
    'unordered-list': {
      name: 'unordered-list',
      action: EasyMDE.toggleUnorderedList,
      className: 'fa fa-list-ul',
      title: t('editor.toolbar.unorderedList'),
    },
    'ordered-list': {
      name: 'ordered-list',
      action: EasyMDE.toggleOrderedList,
      className: 'fa fa-list-ol',
      title: t('editor.toolbar.orderedList'),
    },
    preview: {
      name: 'preview',
      action: EasyMDE.togglePreview,
      className: 'fa fa-eye',
      title: t('editor.toolbar.preview'),
    },
    fullscreen: {
      name: 'fullscreen',
      action: EasyMDE.toggleFullScreen,
      className: 'fa fa-arrows-alt',
      title: t('editor.toolbar.fullscreen'),
    },
    'side-by-side': {
      name: 'side-by-side',
      action: EasyMDE.toggleSideBySide,
      className: 'fa fa-columns',
      title: t('editor.toolbar.sideBySide'),
    },
    guide: {
      name: 'guide',
      action: 'https://www.markdownguide.org/basic-syntax/',
      className: 'fa fa-question-circle',
      title: t('editor.toolbar.guide'),
    },
  };

  const customActions: Record<string, EasyMDE.ToolbarIcon> = {
    'task-list': {
      name: 'task-list',
      action: (editor) => {
        const cm = editor.codemirror;
        const selection = cm.getSelection();
        if (selection) {
          cm.replaceSelection(`- [ ] ${selection}`);
        } else {
          const cursor = cm.getCursor();
          cm.replaceRange('- [ ] ', cursor);
        }
        cm.focus();
      },
      className: 'fa fa-check-square-o',
      title: t('editor.toolbar.taskList'),
    },
    indent: {
      name: 'indent',
      action: (editor) => {
        editor.codemirror.indentSelection('add');
        editor.codemirror.focus();
      },
      className: 'fa fa-indent',
      title: t('editor.toolbar.indent'),
    },
    unindent: {
      name: 'unindent',
      action: (editor) => {
        editor.codemirror.indentSelection('subtract');
        editor.codemirror.focus();
      },
      className: 'fa fa-outdent',
      title: t('editor.toolbar.unindent'),
    },
    mention: {
      name: 'mention',
      action: (editor) => {
        const cm = editor.codemirror;
        cm.replaceSelection('@');
        cm.focus();
      },
      className: 'fa fa-at',
      title: t('editor.toolbar.mention'),
    },
    ref: {
      name: 'ref',
      action: (editor) => {
        const cm = editor.codemirror;
        cm.replaceSelection('#');
        cm.focus();
      },
      className: 'fa fa-hashtag',
      title: t('editor.toolbar.ref'),
    },
    'inline-code': {
      name: 'inline-code',
      action: (editor) => {
        const cm = editor.codemirror;
        const selection = cm.getSelection();
        cm.replaceSelection(`\`${selection}\``);
        if (!selection) {
          const cursor = cm.getCursor();
          cm.setCursor(cursor.line, cursor.ch - 1);
        }
        cm.focus();
      },
      className: 'fa fa-terminal',
      title: t('editor.toolbar.inlineCode'),
    },
    'checkbox-empty': {
      name: 'checkbox-empty',
      action: (editor) => {
        const cm = editor.codemirror;
        const selection = cm.getSelection();
        cm.replaceSelection(`\n- [ ] ${selection}`);
        cm.focus();
      },
      className: 'fa fa-square-o',
      title: t('editor.toolbar.taskList'),
    },
    'checkbox-checked': {
      name: 'checkbox-checked',
      action: (editor) => {
        const cm = editor.codemirror;
        const selection = cm.getSelection();
        cm.replaceSelection(`\n- [x] ${selection}`);
        cm.focus();
      },
      className: 'fa fa-check-square-o',
      title: t('editor.toolbar.taskList'),
    },
  };

  const wikiToolbar: NonNullable<EasyMDE.Options['toolbar']> = [
    builtin.bold,
    builtin.italic,
    builtin.strikethrough,
    '|',
    builtin['heading-1'],
    builtin['heading-2'],
    builtin['heading-3'],
    builtin['heading-bigger'],
    builtin['heading-smaller'],
    '|',
    customActions['inline-code'],
    builtin.code,
    builtin.quote,
    '|',
    customActions['checkbox-empty'],
    customActions['checkbox-checked'],
    '|',
    builtin['unordered-list'],
    builtin['ordered-list'],
    '|',
    builtin.link,
    imageAction,
    builtin.table,
    builtin['horizontal-rule'],
    '|',
    builtin.preview,
    builtin['side-by-side'],
    '|',
    builtin.guide,
  ];

  const defaultToolbar: NonNullable<EasyMDE.Options['toolbar']> = [
    builtin.heading,
    builtin.bold,
    builtin.italic,
    '|',
    builtin.quote,
    builtin.code,
    builtin.link,
    '|',
    builtin['unordered-list'],
    builtin['ordered-list'],
    customActions['task-list'],
    customActions.unindent,
    customActions.indent,
    '|',
    builtin.table,
    customActions.mention,
    customActions.ref,
    '|',
    imageAction,
    '|',
    builtin.preview,
    builtin['side-by-side'],
    '|',
    builtin.guide,
  ];

  const toolbar = props.scene === 'wiki' ? wikiToolbar : defaultToolbar;

  // Mention/ref toolbar buttons only make sense when mention search is available.
  if (props.scene === 'default' && !mentionsEnabled.value) {
    return toolbar.filter((item) => {
      if (typeof item === 'string') return true;
      return item.name !== 'mention' && item.name !== 'ref';
    }) as NonNullable<EasyMDE.Options['toolbar']>;
  }

  return toolbar;
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
    toolbar: buildToolbar(uploadEnabled),
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
  display: flex;
  flex-wrap: wrap;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-color: var(--vscode-panel-border);
}

.easy-mde-editor :deep(.editor-toolbar button) {
  color: var(--vscode-foreground);
}

.easy-mde-editor :deep(.editor-toolbar i.separator) {
  color: transparent;
  border-left-color: var(--vscode-panel-border);
  border-right-color: transparent;
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
  background-color: var(--vscode-editorSuggestWidget-background) !important;
  border: 1px solid var(--vscode-editorSuggestWidget-border) !important;
  border-radius: 3px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36);
  color: var(--vscode-editorSuggestWidget-foreground) !important;
  max-height: 240px;
  overflow-y: auto;
  font-size: 0.9em;
}

.easy-mde-editor :deep(.tribute-container ul) {
  margin: 0;
  padding: 0;
  list-style: none;
  background-color: transparent !important;
}

.easy-mde-editor :deep(.tribute-container li) {
  padding: 4px 10px;
  cursor: pointer;
  color: var(--vscode-editorSuggestWidget-foreground) !important;
}

.easy-mde-editor :deep(.tribute-container li.highlight) {
  background-color: var(--vscode-list-activeSelectionBackground) !important;
  color: var(--vscode-list-activeSelectionForeground) !important;
}

.easy-mde-editor :deep(.tribute-container li:hover:not(.highlight)) {
  background-color: var(--vscode-list-hoverBackground) !important;
  color: var(--vscode-list-hoverForeground) !important;
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
