<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import MarkdownBody from './MarkdownBody.vue';
import type { ForgejoTimelineComment } from '../types/api';
import { useAppState } from '../composables/useAppState';

const { t } = useI18n();
const state = useAppState();

interface Props {
  comments: ForgejoTimelineComment[];
  instanceId: string;
  baseUrl?: string;
}

const props = defineProps<Props>();
const renderedBodies = reactive<Record<string, string>>({});
const loadingIds = ref<Set<string>>(new Set());

function commentKey(comment: ForgejoTimelineComment): string {
  return String(comment.id ?? `${comment.type ?? 'event'}-${comment.created_at ?? ''}-${comment.user?.login ?? ''}`);
}

async function renderComment(comment: ForgejoTimelineComment) {
  const key = commentKey(comment);
  if (renderedBodies[key] || !comment.body) {
    return;
  }
  loadingIds.value.add(key);
  try {
    const html = await state.renderMarkdown(props.instanceId, comment.body);
    renderedBodies[key] = html;
  } catch {
    renderedBodies[key] = comment.body;
  } finally {
    loadingIds.value.delete(key);
  }
}

watch(
  () => props.comments,
  (comments) => {
    for (const comment of comments) {
      if (comment.type === 'comment' && comment.body) {
        renderComment(comment);
      }
    }
  },
  { immediate: true, deep: true },
);

function formatDate(date: string): string {
  try {
    const d = new Date(date);
    const now = Date.now();
    const diff = now - d.getTime();
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const month = 30 * day;
    const year = 365 * day;

    if (diff < minute) {
      return t('dashboard.timeAgo.justNow');
    }
    if (diff < hour) {
      return t('dashboard.timeAgo.minutes', { count: Math.floor(diff / minute) });
    }
    if (diff < day) {
      return t('dashboard.timeAgo.hours', { count: Math.floor(diff / hour) });
    }
    if (diff < month) {
      return t('dashboard.timeAgo.days', { count: Math.floor(diff / day) });
    }
    if (diff < year) {
      return t('dashboard.timeAgo.months', { count: Math.floor(diff / month) });
    }
    return t('dashboard.timeAgo.years', { count: Math.floor(diff / year) });
  } catch {
    return date;
  }
}

function eventText(comment: ForgejoTimelineComment): string {
  const key = `dashboard.detail.timelineEvent.${comment.type ?? 'unknown'}`;
  const translated = t(key);
  if (translated !== key) {
    return translated;
  }
  return comment.type ?? 'event';
}
</script>

<template>
  <div class="comment-timeline">
    <div v-if="comments.length === 0" class="empty">{{ t('dashboard.detail.noComments') }}</div>
    <div v-for="comment in comments" :key="commentKey(comment)" class="timeline-item">
      <div class="timeline-header">
        <img
          v-if="comment.user?.avatar_url"
          :src="comment.user.avatar_url"
          :alt="comment.user.login"
          class="user-avatar"
        />
        <span v-if="comment.user" class="user-name">{{ comment.user.login }}</span>
        <span class="event-type">{{ eventText(comment) }}</span>
        <span v-if="comment.created_at" class="meta-item">{{ formatDate(comment.created_at) }}</span>
      </div>
      <div v-if="comment.type === 'comment'" class="comment-body">
        <div v-if="loadingIds.has(commentKey(comment))" class="loading">{{ t('dashboard.detail.renderingBody') }}</div>
        <MarkdownBody
          v-else
          :html="renderedBodies[commentKey(comment)] ?? ''"
          :base-url="props.baseUrl"
          @open-external="state.openExternal($event)"
        />
      </div>
      <div v-else-if="comment.ref_commit_sha || comment.ref_comment" class="event-detail">
        <span v-if="comment.ref_commit_sha" class="commit-ref">{{ comment.ref_commit_sha.slice(0, 7) }}</span>
        <span v-else-if="comment.ref_comment" class="comment-ref">#{{ comment.ref_comment.id }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.comment-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.timeline-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
}

.timeline-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.85em;
}

.user-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}

.user-name {
  color: var(--vscode-foreground);
  font-weight: 500;
}

.event-type {
  color: var(--vscode-descriptionForeground);
}

.meta-item {
  color: var(--vscode-descriptionForeground);
}

.comment-body {
  font-size: 0.95em;
}

.loading {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.event-detail {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.commit-ref,
.comment-ref {
  font-family: var(--vscode-editor-font-family), monospace;
}
</style>
