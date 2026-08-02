<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  html?: string;
  loading?: boolean;
  error?: string;
  baseUrl?: string;
}>();

const emit = defineEmits<{
  (e: 'openExternal', url: string): void;
}>();

const { t } = useI18n();

const dangerousTags = new Set(['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'button']);
const dangerousSchemes = /^javascript:|data:text\/html|^data:image\/svg/i;
const absoluteUrlPattern = /^[a-z][a-z0-9+.-]*:/i;

function resolveUrl(value: string): string {
  if (!props.baseUrl || absoluteUrlPattern.test(value) || value.startsWith('#')) {
    return value;
  }
  try {
    return new URL(value, props.baseUrl).href;
  } catch {
    return value;
  }
}

function sanitizeNode(node: Node): Node | null {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element;
    const tagName = element.tagName.toLowerCase();

    if (dangerousTags.has(tagName)) {
      return null;
    }

    const attributes = Array.from(element.attributes);
    for (const attr of attributes) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' || name === 'src') {
        const value = attr.value.trim();
        if (dangerousSchemes.test(value)) {
          element.setAttribute(attr.name, '');
        } else {
          element.setAttribute(attr.name, resolveUrl(value));
        }
        continue;
      }
      if (name === 'target') {
        element.removeAttribute(attr.name);
        continue;
      }
    }

    const children = Array.from(element.childNodes);
    for (const child of children) {
      const sanitized = sanitizeNode(child);
      if (sanitized !== child) {
        if (sanitized) {
          element.replaceChild(sanitized, child);
        } else {
          element.removeChild(child);
        }
      }
    }
  }
  return node;
}

function sanitizeHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const children = Array.from(doc.body.childNodes);
  for (const child of children) {
    sanitizeNode(child);
  }
  return doc.body.innerHTML;
}

const safeHtml = computed(() => (props.html ? sanitizeHtml(props.html) : ''));

function handleClick(event: MouseEvent) {
  const target = event.target as HTMLElement;

  const anchor = target.closest('a') as HTMLAnchorElement | null;
  if (anchor) {
    const children = Array.from(anchor.childNodes);
    const onlyImage =
      children.length === 1 &&
      children[0].nodeType === Node.ELEMENT_NODE &&
      (children[0] as Element).tagName.toLowerCase() === 'img';
    if (onlyImage) {
      event.preventDefault();
      return;
    }

    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#')) {
      return;
    }
    event.preventDefault();
    emit('openExternal', anchor.href);
    return;
  }
}
</script>

<template>
  <div class="markdown-body">
    <div v-if="loading" class="markdown-loading">{{ t('dashboard.detail.renderingBody') }}</div>
    <div v-else-if="error" class="markdown-error">{{ t('dashboard.error', { message: error }) }}</div>
    <div v-else-if="!html" class="markdown-empty">{{ t('dashboard.detail.noBody') }}</div>
    <div v-else class="markdown-content" @click="handleClick" v-html="safeHtml" />
  </div>
</template>

<style scoped>
.markdown-body {
  display: flex;
  flex-direction: column;
}

.markdown-loading {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.markdown-error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
}

.markdown-empty {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  font-style: italic;
}

.markdown-content {
  font-size: 0.95em;
  line-height: 1.6;
  color: var(--vscode-foreground);
}

.markdown-content :deep(*) {
  box-sizing: border-box;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  margin-top: 16px;
  margin-bottom: 8px;
  font-weight: 600;
  line-height: 1.25;
}

.markdown-content :deep(h1) {
  font-size: 1.4em;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding-bottom: 4px;
}

.markdown-content :deep(h2) {
  font-size: 1.2em;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding-bottom: 4px;
}

.markdown-content :deep(h3) {
  font-size: 1.1em;
}

.markdown-content :deep(p) {
  margin-top: 0;
  margin-bottom: 12px;
}

.markdown-content :deep(a) {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin-top: 0;
  margin-bottom: 12px;
  padding-left: 24px;
}

.markdown-content :deep(li) {
  margin-bottom: 4px;
}

.markdown-content :deep(pre) {
  background-color: var(--vscode-textCodeBlock-background);
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
  margin-bottom: 12px;
}

.markdown-content :deep(code) {
  font-family: var(--vscode-editor-font-family), monospace;
  font-size: 0.9em;
}

.markdown-content :deep(pre > code) {
  background-color: transparent;
  padding: 0;
}

.markdown-content :deep(:not(pre) > code) {
  background-color: var(--vscode-textCodeBlock-background);
  padding: 2px 4px;
  border-radius: 3px;
}

.markdown-content :deep(blockquote) {
  margin: 0 0 12px;
  padding: 4px 12px;
  border-left: 4px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
}

.markdown-content :deep(table) {
  border-collapse: collapse;
  margin-bottom: 12px;
  width: 100%;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid var(--vscode-panel-border);
  padding: 6px 10px;
  text-align: left;
}

.markdown-content :deep(th) {
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  font-weight: 600;
}

.markdown-content :deep(tr:nth-child(even)) {
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.markdown-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--vscode-panel-border);
  margin: 16px 0;
}

.markdown-content :deep(img) {
  max-width: 100%;
  height: auto;
  pointer-events: none;
}

.markdown-content :deep(.task-list-item) {
  list-style-type: none;
}
</style>
