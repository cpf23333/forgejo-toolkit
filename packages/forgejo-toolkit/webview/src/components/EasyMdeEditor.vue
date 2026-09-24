<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type EasyMDE from 'easymde';
import type Tribute from 'tributejs';
import { isImageFile } from '../utils/file';
import { sanitizeMarkdownHtml } from '../utils/markdown';
import { createTimedCache } from '../utils/createTimedCache';
import { useAppState, type MentionUser, type MentionIssue } from '../composables/useAppState';

type MentionItem = MentionUser | MentionIssue;

type ToolbarScene = 'default' | 'wiki';

// The easymde d.ts uses `export =`, so the dynamic-import namespace type is
// the class itself; the CJS interop wrapper still exposes it on `default` at
// runtime (see the load in onMounted).
type EasyMDEStatic = typeof import('easymde');
type TributeStatic = (typeof import('tributejs'))['default'];

interface Props {
  modelValue?: string;
  placeholder?: string;
  /**
   * Accessible name of the editor. EasyMDE exposes its own placeholder as the
   * only description, so the field name has to be applied to the CodeMirror
   * input element after initialisation.
   */
  label?: string;
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
  label: '',
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
let TributeClass: TributeStatic | null = null;
let isUnmounted = false;
let visibilityObserver: IntersectionObserver | null = null;
let tribute: Tribute<any> | null = null;
let previewRenderTimer: ReturnType<typeof setTimeout> | undefined;
const mentionSearchCache = createTimedCache<{ users: MentionUser[]; issues: MentionIssue[] }>(30_000);
const mentionSearchTimers = new Map<'user' | 'issue', ReturnType<typeof setTimeout>>();
const renderedHtml = ref('');
const previewRendering = ref(false);
const isFullscreen = ref(false);
// Why the last image upload attempt produced nothing, or undefined.
//
// A failed upload used to be reported nowhere: EasyMDE's own surfaces are both
// off here (`status: false` hides the status bar the error would be written to,
// and `errorCallback` was overridden with an empty body on the belief that the
// host toasts permission errors - it does not, it answers
// `issueAttachmentCreated` with `error` and never notifies). The editor renders
// this line itself, so every call site gets the feedback without having to pass
// its own error handler.
const imageUploadError = ref<string | undefined>(undefined);

/**
 * Records one failed image upload for the editor's own error line.
 *
 * EasyMDE routes both its `imageUploadFunction` failures and the size/type
 * checks it does itself through `options.errorCallback`, so this is the single
 * place the message has to land. Nothing here writes a toast: the failure
 * belongs next to the editor the image was dropped into.
 */
function reportImageUploadError(message: string) {
  imageUploadError.value = message;
}

/**
 * The editor's failure line — one message, stating the failure once.
 *
 * A call site with a real reason hands the reason over and it is shown after the
 * banner's own prefix (`editor.imageUploadFailed`: "Image upload failed:
 * {message}"). A call site with no reason of its own hands over the generic
 * failure sentence (`common.imageUploadFailed`, "Failed to upload image") — the
 * no-URL path of `IssueDetail`/`PullRequestDetail`/`CommentTimeline` does — and
 * prefixing *that* rendered "Image upload failed: Failed to upload image": the
 * same failure twice, the second half saying nothing the first did not. The
 * generic sentence is the whole message then.
 */
function imageUploadErrorText(message: string | undefined): string {
  const generic = t('common.imageUploadFailed');
  return message && message !== generic ? t('editor.imageUploadFailed', { message }) : generic;
}

const mentionsEnabled = computed(
  () => props.instanceId !== undefined && props.owner !== undefined && props.repo !== undefined,
);

const baseUrl = computed(() => {
  if (!props.instanceId) {
    return undefined;
  }
  return state.instances.value.find((instance) => instance.id === props.instanceId)?.url;
});

function getMentionInput(): HTMLElement | null {
  return easyMDE?.codemirror.getInputField() ?? null;
}

// CodeMirror's own input element is the focus target, and `aria-label` fixes
// its accessible name. The `<textarea>` EasyMDE hides covers the window before
// EasyMDE has finished loading its chunks.
function applyEditorLabel() {
  const name = props.label || props.placeholder;
  const input = getMentionInput();
  if (input && name) {
    input.setAttribute('aria-label', name);
  }
  textareaRef.value?.setAttribute('aria-label', name);
}

function isTributeActive(): boolean {
  const container = document.querySelector('.tribute-container') as HTMLElement | null;
  return container !== null && container.style.display !== 'none';
}

function getActivePreviewElement(): HTMLElement | null {
  return (
    (wrapperRef.value?.querySelector(
      '.editor-preview-full.editor-preview-active, .editor-preview-side.editor-preview-active-side',
    ) as HTMLElement | null) ?? null
  );
}

async function renderPreviewHtml(markdown: string) {
  let html: string;
  if (!props.instanceId) {
    html = (easyMDE as any)?.markdown(markdown) ?? '';
  } else {
    previewRendering.value = true;
    try {
      const context = props.owner && props.repo ? `${props.owner}/${props.repo}` : undefined;
      html = await state.renderMarkdown(props.instanceId, markdown, context);
    } finally {
      previewRendering.value = false;
    }
  }
  renderedHtml.value = sanitizeMarkdownHtml(html, baseUrl.value);
}

function schedulePreviewRender() {
  if (previewRenderTimer) {
    clearTimeout(previewRenderTimer);
  }
  previewRenderTimer = setTimeout(() => {
    previewRenderTimer = undefined;
    const markdown = easyMDE?.value() ?? '';
    void renderPreviewHtml(markdown)
      .then(() => {
        const previewEl = getActivePreviewElement();
        if (previewEl) {
          previewEl.innerHTML = renderedHtml.value;
        }
      })
      .catch(() => {
        // Render request failed (e.g. host renderMarkdown rejected); keep the
        // previous preview instead of surfacing an unhandled rejection.
      });
  }, 300);
}

function searchMentionsDebounced(
  instanceId: string,
  owner: string,
  repo: string,
  type: 'user' | 'issue',
  text: string,
  callback: (result: any[]) => void,
) {
  const cacheKey = `${type}:${text}`;
  const cached = mentionSearchCache.get(cacheKey);
  if (cached) {
    callback(type === 'user' ? cached.users : cached.issues);
    return;
  }
  const existingTimer = mentionSearchTimers.get(type);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  mentionSearchTimers.set(
    type,
    setTimeout(() => {
      mentionSearchTimers.delete(type);
      state
        .searchMentions(instanceId, owner, repo, text, type)
        .then((result) => {
          mentionSearchCache.set(cacheKey, result);
          callback(type === 'user' ? result.users : result.issues);
        })
        .catch(() => callback([]));
    }, 300),
  );
}

async function attachMentions() {
  if (!mentionsEnabled.value) {
    return;
  }
  const input = getMentionInput();
  if (!input || !wrapperRef.value || !TributeClass) {
    return;
  }

  const { instanceId, owner, repo } = props as Required<Pick<Props, 'instanceId' | 'owner' | 'repo'>>;

  tribute = new TributeClass({
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
            : `<span class="mention-avatar mention-avatar-fallback"><vscode-icon name="account" :size="16"></vscode-icon></span>`;
          const fullName = original.full_name
            ? `<span class="mention-fullname">${escapeHtml(original.full_name)}</span>`
            : '';
          return `<div class="mention-item">${avatar}<span class="mention-name">${escapeHtml(original.name)}</span>${fullName}</div>`;
        },
        values: (text: string, callback: (result: any[]) => void) => {
          searchMentionsDebounced(instanceId, owner, repo, 'user', text, callback);
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
          return `<div class="mention-item mention-issue"><vscode-icon name="${icon}" :size="14" class="mention-issue-icon ${stateClass}"></vscode-icon><span class="mention-issue-number">#${escapeHtml(original.value)}</span><span class="mention-issue-title">${escapeHtml(original.title)}</span></div>`;
        },
        values: (text: string, callback: (result: any[]) => void) => {
          searchMentionsDebounced(instanceId, owner, repo, 'issue', text, callback);
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

function buildToolbar(mde: EasyMDEStatic, uploadEnabled: boolean): NonNullable<EasyMDE.Options['toolbar']> {
  const imageAction = uploadEnabled
    ? {
        name: 'upload-image',
        action: mde.drawUploadedImage,
        className: 'codicon codicon-cloud-upload',
        title: t('editor.toolbar.uploadImage'),
      }
    : {
        name: 'image',
        action: mde.drawImage,
        className: 'codicon codicon-file-media',
        title: t('editor.toolbar.image'),
      };

  const builtin: Record<string, EasyMDE.ToolbarIcon> = {
    heading: {
      name: 'heading',
      action: mde.toggleHeadingSmaller,
      className: 'codicon codicon-symbol-keyword',
      title: t('editor.toolbar.heading'),
    },
    'heading-1': {
      name: 'heading-1',
      action: mde.toggleHeading1,
      className: 'codicon codicon-symbol-keyword',
      title: `${t('editor.toolbar.heading')} 1`,
    },
    'heading-2': {
      name: 'heading-2',
      action: mde.toggleHeading2,
      className: 'codicon codicon-symbol-keyword',
      title: `${t('editor.toolbar.heading')} 2`,
    },
    'heading-3': {
      name: 'heading-3',
      action: mde.toggleHeading3,
      className: 'codicon codicon-symbol-keyword',
      title: `${t('editor.toolbar.heading')} 3`,
    },
    'heading-bigger': {
      name: 'heading-bigger',
      action: mde.toggleHeadingBigger,
      className: 'codicon codicon-symbol-keyword',
      title: t('editor.toolbar.heading'),
    },
    'heading-smaller': {
      name: 'heading-smaller',
      action: mde.toggleHeadingSmaller,
      className: 'codicon codicon-symbol-keyword',
      title: t('editor.toolbar.heading'),
    },
    bold: {
      name: 'bold',
      action: mde.toggleBold,
      className: 'codicon codicon-bold',
      title: t('editor.toolbar.bold'),
    },
    italic: {
      name: 'italic',
      action: mde.toggleItalic,
      className: 'codicon codicon-italic',
      title: t('editor.toolbar.italic'),
    },
    strikethrough: {
      name: 'strikethrough',
      action: mde.toggleStrikethrough,
      className: 'codicon codicon-strikethrough',
      title: t('editor.toolbar.strikethrough'),
    },
    quote: {
      name: 'quote',
      action: mde.toggleBlockquote,
      className: 'codicon codicon-quote',
      title: t('editor.toolbar.quote'),
    },
    code: {
      name: 'code',
      action: mde.toggleCodeBlock,
      className: 'codicon codicon-code',
      title: t('editor.toolbar.code'),
    },
    link: {
      name: 'link',
      action: mde.drawLink,
      className: 'codicon codicon-link',
      title: t('editor.toolbar.link'),
    },
    image: {
      name: 'image',
      action: mde.drawImage,
      className: 'codicon codicon-file-media',
      title: t('editor.toolbar.image'),
    },
    table: {
      name: 'table',
      action: mde.drawTable,
      className: 'codicon codicon-table',
      title: t('editor.toolbar.table'),
    },
    'horizontal-rule': {
      name: 'horizontal-rule',
      action: mde.drawHorizontalRule,
      className: 'codicon codicon-dash',
      title: t('editor.toolbar.horizontalRule'),
    },
    'unordered-list': {
      name: 'unordered-list',
      action: mde.toggleUnorderedList,
      className: 'codicon codicon-list-unordered',
      title: t('editor.toolbar.unorderedList'),
    },
    'ordered-list': {
      name: 'ordered-list',
      action: mde.toggleOrderedList,
      className: 'codicon codicon-list-ordered',
      title: t('editor.toolbar.orderedList'),
    },
    preview: {
      name: 'preview',
      action: mde.togglePreview,
      className: 'codicon codicon-preview',
      noDisable: true,
      title: t('editor.toolbar.preview'),
    },
    fullscreen: {
      name: 'fullscreen',
      action: mde.toggleFullScreen,
      className: 'codicon codicon-screen-full',
      noDisable: true,
      title: t('editor.toolbar.fullscreen'),
    },
    'side-by-side': {
      name: 'side-by-side',
      action: mde.toggleSideBySide,
      className: 'codicon codicon-split-horizontal',
      noDisable: true,
      title: t('editor.toolbar.sideBySide'),
    },
    guide: {
      name: 'guide',
      action: 'https://www.markdownguide.org/basic-syntax/',
      className: 'codicon codicon-question',
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
      className: 'codicon codicon-checklist',
      title: t('editor.toolbar.taskList'),
    },
    indent: {
      name: 'indent',
      action: (editor) => {
        editor.codemirror.indentSelection('add');
        editor.codemirror.focus();
      },
      className: 'codicon codicon-arrow-right',
      title: t('editor.toolbar.indent'),
    },
    unindent: {
      name: 'unindent',
      action: (editor) => {
        editor.codemirror.indentSelection('subtract');
        editor.codemirror.focus();
      },
      className: 'codicon codicon-arrow-left',
      title: t('editor.toolbar.unindent'),
    },
    mention: {
      name: 'mention',
      action: (editor) => {
        const cm = editor.codemirror;
        cm.replaceSelection('@');
        cm.focus();
      },
      className: 'codicon codicon-mention',
      title: t('editor.toolbar.mention'),
    },
    ref: {
      name: 'ref',
      action: (editor) => {
        const cm = editor.codemirror;
        cm.replaceSelection('#');
        cm.focus();
      },
      className: 'codicon codicon-tag',
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
      className: 'codicon codicon-terminal',
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
      className: 'codicon codicon-primitive-square',
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
      className: 'codicon codicon-checklist',
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
    builtin.fullscreen,
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
    builtin.fullscreen,
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

onMounted(async () => {
  const textarea = textareaRef.value;
  if (!textarea) {
    return;
  }

  // EasyMDE (CodeMirror 5 + marked) and Tribute are several hundred KB, so
  // they are loaded on demand; Vite splits them (and their CSS) into async
  // chunks that browsing-only sessions never fetch.
  const [easymdeModule, tributeModule] = await Promise.all([
    import('easymde'),
    import('tributejs'),
    import('easymde/dist/easymde.min.css'),
    import('tributejs/tribute.css'),
  ]);

  // The component may have been unmounted while the chunks were loading.
  if (isUnmounted) {
    return;
  }

  const EasyMDEClass =
    (easymdeModule as unknown as { default?: EasyMDEStatic }).default ?? (easymdeModule as unknown as EasyMDEStatic);
  TributeClass = tributeModule.default;

  const uploadEnabled = props.uploadImage !== undefined;

  const options: EasyMDE.Options = {
    element: textarea,
    initialValue: props.modelValue,
    placeholder: props.placeholder,
    spellChecker: false,
    status: false,
    autoDownloadFontAwesome: false,
    sideBySideFullscreen: false,
    minHeight: '120px',
    previewRender() {
      if (previewRendering.value && !renderedHtml.value) {
        return `<div class="editor-preview-loading">${t('dashboard.loading')}</div>`;
      }
      return renderedHtml.value;
    },
    toolbar: buildToolbar(EasyMDEClass, uploadEnabled),
    uploadImage: uploadEnabled,
    imageAccept: 'image/*',
    imageUploadFunction: uploadEnabled
      ? (file, onSuccess, onError) => {
          if (!isImageFile(file)) {
            onError(t('dashboard.form.imageOnly'));
            return;
          }
          // A new attempt clears the previous failure: the line describes the
          // last upload, not every one this editor has seen.
          imageUploadError.value = undefined;
          props.uploadImage!(
            file,
            (url) => {
              imageUploadError.value = undefined;
              easyMDE?.codemirror.replaceSelection(`![image](${url})`);
            },
            onError,
          );
        }
      : undefined,
    errorCallback: reportImageUploadError,
    onToggleFullScreen(active) {
      isFullscreen.value = active;
      if (active) {
        wrapperRef.value?.classList.add('is-fullscreen');
      } else {
        wrapperRef.value?.classList.remove('is-fullscreen');
      }
    },
  };

  easyMDE = new EasyMDEClass(options);
  applyEditorLabel();
  easyMDE.codemirror.on('change', () => {
    emit('update:modelValue', easyMDE?.value() ?? '');
    schedulePreviewRender();
  });

  const toolbarElements = (easyMDE as any).toolbarElements as Record<string, HTMLElement> | undefined;
  toolbarElements?.preview?.addEventListener('click', () => {
    schedulePreviewRender();
  });
  toolbarElements?.['side-by-side']?.addEventListener('click', () => {
    schedulePreviewRender();
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
  isUnmounted = true;
  detachMentions();
  visibilityObserver?.disconnect();
  visibilityObserver = null;
  if (previewRenderTimer) {
    clearTimeout(previewRenderTimer);
    previewRenderTimer = undefined;
  }
  for (const timer of mentionSearchTimers.values()) {
    clearTimeout(timer);
  }
  mentionSearchTimers.clear();
  easyMDE?.cleanup();
  easyMDE = null;
});

watch(
  () => props.modelValue,
  (value) => {
    if (easyMDE && easyMDE.value() !== value) {
      // The bound value changed from the outside, so this is a re-seed (another
      // comment, a reset), not the user typing: the editor instance is reused
      // for every comment and CodeMirror records `setValue` as an undoable
      // change. Clearing the history drops the undo boundary at the re-seed, so
      // Ctrl+Z cannot restore the previous comment's draft into this one.
      easyMDE.value(value);
      easyMDE.codemirror.clearHistory();
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

watch(() => [props.label, props.placeholder], applyEditorLabel);
</script>

<template>
  <div ref="wrapperRef" class="easy-mde-editor" :class="{ 'is-fullscreen': isFullscreen }">
    <textarea ref="textareaRef" :aria-label="label || placeholder"></textarea>
    <!-- The only visible report of a failed image upload: EasyMDE's status bar
         is off and its error callback is ours (see imageUploadError). -->
    <div v-if="imageUploadError" class="image-upload-error" role="alert">
      <vscode-icon name="error" />
      <span>{{ imageUploadErrorText(imageUploadError) }}</span>
    </div>
  </div>
</template>

<style scoped>
.easy-mde-editor {
  position: relative;
}

.image-upload-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 0.85em;
  color: var(--vscode-errorForeground, var(--vscode-foreground));
}

.easy-mde-editor :deep(.EasyMDEContainer) {
  color: var(--vscode-foreground);
}

.easy-mde-editor :deep(.editor-toolbar) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  min-height: 36px;
  height: auto;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-color: var(--vscode-panel-border);
}

.easy-mde-editor :deep(.editor-toolbar button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  min-width: 28px;
  padding: 0;
  color: var(--vscode-foreground);
}

.easy-mde-editor :deep(.editor-toolbar button.active) {
  background-color: var(--vscode-toolbar-activeBackground);
  border-color: var(--vscode-focusBorder);
}

.easy-mde-editor :deep(.editor-toolbar i) {
  font-family: 'codicon', sans-serif;
  font-size: 16px;
  font-style: normal;
  pointer-events: none;
}

.easy-mde-editor :deep(.editor-toolbar i.separator) {
  align-self: stretch;
  width: 1px;
  margin: 4px 6px;
  color: transparent;
  border-left-color: var(--vscode-panel-border);
  border-right-color: transparent;
}

.easy-mde-editor :deep(.editor-toolbar button:hover) {
  background-color: var(--vscode-toolbar-hoverBackground);
}

.easy-mde-editor :deep(.editor-toolbar button.heading-1::after),
.easy-mde-editor :deep(.editor-toolbar button.heading-2::after),
.easy-mde-editor :deep(.editor-toolbar button.heading-3::after),
.easy-mde-editor :deep(.editor-toolbar button.heading-bigger::after),
.easy-mde-editor :deep(.editor-toolbar button.heading-smaller::after) {
  display: none;
}

.easy-mde-editor :deep(.EasyMDEContainer) {
  display: grid;
  grid-template-rows: auto 1fr;
  grid-template-columns: 2fr 3fr;
  position: relative;
}

.easy-mde-editor :deep(.editor-toolbar) {
  grid-row: 1;
  grid-column: 1 / -1;
}

.easy-mde-editor :deep(.CodeMirror) {
  grid-row: 2;
  grid-column: 1 / -1;
  width: 100% !important;
}

.easy-mde-editor :deep(.CodeMirror.CodeMirror-sided) {
  grid-column: 1 / 2;
}

.easy-mde-editor :deep(.editor-preview-side) {
  position: static;
  grid-row: 2;
  grid-column: 2;
  display: none;
  width: 100%;
  height: 100%;
  border-left: 1px solid var(--vscode-panel-border);
  background-color: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
}

.easy-mde-editor :deep(.editor-preview-side.editor-preview-active-side) {
  display: block;
}

.easy-mde-editor :deep(.editor-preview-loading) {
  padding: 8px;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

/* Fullscreen mode: EasyMDE uses fixed positioning inside the webview, but
 * nested transforms/containment in VS Code webviews can break that. Instead
 * we make the wrapper itself fixed and lay the editor out with a grid.
 * The preview pane keeps EasyMDE's default absolute positioning, which is
 * relative to the CodeMirror wrapper.
 */
.easy-mde-editor.is-fullscreen {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10000;
  background-color: var(--vscode-editor-background);
  padding: 8px;
}

.easy-mde-editor.is-fullscreen :deep(.EasyMDEContainer) {
  display: grid;
  grid-template-rows: auto 1fr;
  grid-template-columns: 1fr 1fr;
  height: 100%;
}

.easy-mde-editor.is-fullscreen :deep(.editor-toolbar) {
  grid-row: 1;
  grid-column: 1 / -1;
  position: relative !important;
  top: auto;
  left: auto;
  right: auto;
  z-index: auto;
}

.easy-mde-editor.is-fullscreen :deep(.CodeMirror) {
  grid-row: 2;
  grid-column: 1 / -1;
  position: relative !important;
  top: auto;
  left: auto;
  right: auto;
  bottom: auto;
  width: 100% !important;
  height: 100% !important;
  min-height: 0;
}

.easy-mde-editor.is-fullscreen :deep(.CodeMirror.CodeMirror-sided) {
  grid-column: 1 / 2;
}

.easy-mde-editor.is-fullscreen :deep(.editor-preview-side) {
  grid-row: 2;
  grid-column: 2;
  display: none;
  position: relative !important;
  top: auto;
  right: auto;
  bottom: auto;
  width: 100%;
  height: 100%;
  overflow: auto;
  border: none;
  align-self: stretch;
}

.easy-mde-editor.is-fullscreen :deep(.editor-preview-side.editor-preview-active-side) {
  display: block;
}

.easy-mde-editor.is-fullscreen :deep(.CodeMirror.CodeMirror-sided) {
  border-right: none;
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
