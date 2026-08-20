<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import MentionHoverCard from './MentionHoverCard.vue';
import { useAppState } from '../composables/useAppState';
import { sanitizeMarkdownHtml } from '../utils/markdown';
import type { ForgejoIssue, ForgejoUser } from '../types/api';

const props = defineProps<{
  html?: string;
  loading?: boolean;
  error?: string;
  baseUrl?: string;
  instanceId?: string;
}>();

const emit = defineEmits<{
  (e: 'openExternal', url: string): void;
}>();

const { t } = useI18n();
const state = useAppState();

const hoverType = ref<'user' | 'issue'>('user');
const hoverData = ref<ForgejoUser | ForgejoIssue | undefined>(undefined);
const hoverLoading = ref(false);
const hoverError = ref<string | undefined>(undefined);
const hoverX = ref(0);
const hoverY = ref(0);
const hoverVisible = ref(false);
let hoverTimeout: ReturnType<typeof setTimeout> | undefined;
let currentHoverTarget: HTMLElement | null = null;
let pendingHoverRequest: Promise<unknown> | undefined;

const safeHtml = computed(() => (props.html ? sanitizeMarkdownHtml(props.html, props.baseUrl) : ''));

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

    const href = anchor.getAttribute('data-href');
    if (!href) {
      return;
    }
    event.preventDefault();
    emit('openExternal', href);
    return;
  }
}

function parseUserFromHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    const segments = url.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1];
  } catch {
    return undefined;
  }
}

function parseIssueFromHref(href: string): { owner: string; repo: string; index: number } | undefined {
  try {
    const url = new URL(href);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 4) {
      return undefined;
    }
    const indexSegment = segments[segments.length - 1];
    const typeSegment = segments[segments.length - 2];
    if (typeSegment !== 'issues' && typeSegment !== 'pulls') {
      return undefined;
    }
    const index = Number.parseInt(indexSegment, 10);
    if (Number.isNaN(index)) {
      return undefined;
    }
    return {
      owner: segments[segments.length - 4],
      repo: segments[segments.length - 3],
      index,
    };
  } catch {
    return undefined;
  }
}

function clearHover() {
  hoverVisible.value = false;
  currentHoverTarget = null;
  pendingHoverRequest = undefined;
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = undefined;
  }
}

async function fetchHoverData(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute('data-href') ?? anchor.href;
  const classList = anchor.classList;

  if (classList.contains('mention')) {
    const username = parseUserFromHref(href);
    if (!username || !props.instanceId) {
      clearHover();
      return;
    }
    hoverType.value = 'user';
    hoverLoading.value = true;
    hoverError.value = undefined;
    hoverData.value = undefined;
    const request = state.getUserPreview(props.instanceId, username);
    pendingHoverRequest = request;
    try {
      const user = await request;
      if (pendingHoverRequest === request) {
        hoverData.value = user;
      }
    } catch (error) {
      if (pendingHoverRequest === request) {
        hoverError.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (pendingHoverRequest === request) {
        hoverLoading.value = false;
      }
    }
    return;
  }

  if (classList.contains('ref-issue') || classList.contains('ref-external-issue')) {
    const parsed = parseIssueFromHref(href);
    if (!parsed || !props.instanceId) {
      clearHover();
      return;
    }
    hoverType.value = 'issue';
    hoverLoading.value = true;
    hoverError.value = undefined;
    hoverData.value = undefined;
    const request = state.getIssuePreview(props.instanceId, parsed.owner, parsed.repo, parsed.index);
    pendingHoverRequest = request;
    try {
      const issue = await request;
      if (pendingHoverRequest === request) {
        hoverData.value = issue;
      }
    } catch (error) {
      if (pendingHoverRequest === request) {
        hoverError.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (pendingHoverRequest === request) {
        hoverLoading.value = false;
      }
    }
  }
}

function handleMouseMove(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const anchor = target.closest('a') as HTMLAnchorElement | null;
  if (
    !anchor ||
    (!anchor.classList.contains('mention') &&
      !anchor.classList.contains('ref-issue') &&
      !anchor.classList.contains('ref-external-issue'))
  ) {
    clearHover();
    return;
  }

  hoverX.value = event.clientX;
  hoverY.value = event.clientY;

  if (currentHoverTarget === anchor) {
    return;
  }

  currentHoverTarget = anchor;
  hoverVisible.value = true;
  hoverLoading.value = true;
  hoverError.value = undefined;
  hoverData.value = undefined;

  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
  }
  hoverTimeout = setTimeout(() => {
    fetchHoverData(anchor);
  }, 200);
}

function handleMouseLeave() {
  clearHover();
}
</script>

<template>
  <div class="markdown-body">
    <div v-if="loading" class="markdown-loading">{{ t('dashboard.detail.renderingBody') }}</div>
    <div v-else-if="error" class="markdown-error">{{ t('dashboard.error', { message: error }) }}</div>
    <div v-else-if="!html" class="markdown-empty">{{ t('dashboard.detail.noBody') }}</div>
    <div
      v-else
      class="markdown-content"
      @click="handleClick"
      @mousemove="handleMouseMove"
      @mouseleave="handleMouseLeave"
      v-html="safeHtml"
    />
    <MentionHoverCard
      v-if="hoverVisible"
      :type="hoverType"
      :data="hoverData"
      :loading="hoverLoading"
      :error="hoverError"
      :x="hoverX"
      :y="hoverY"
    />
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
  border-left: 2px solid var(--vscode-panel-border);
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
