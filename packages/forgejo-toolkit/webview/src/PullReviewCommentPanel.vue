<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import PullReviewCommentEditor from './views/PullReviewCommentEditor.vue';
import type { PullReviewCommentContext } from './types/config';

const context = ref<PullReviewCommentContext | undefined>(window.__FORGEJO_TOOLKIT_CONFIG__?.pullReviewComment);

// The panel is a singleton reused across lines and pull requests; keying the
// editor by the full context forces Vue to rebuild it, so local state (draft
// body, pendingReviewId, mode) can never leak into a different line or PR.
const editorKey = computed(() => {
  const c = context.value;
  if (!c) {
    return '';
  }
  return `${c.instanceId}:${c.owner}/${c.repo}#${c.index}:${c.path}:${c.lineNumber}:${c.isBase}:${c.mode}:${c.pendingReviewId ?? ''}`;
});

function handleMessage(event: MessageEvent) {
  if (event.data?.command === 'openPullReviewCommentEditor') {
    context.value = event.data as PullReviewCommentContext;
  }
}

onMounted(() => {
  window.addEventListener('message', handleMessage);
});

onUnmounted(() => {
  window.removeEventListener('message', handleMessage);
});
</script>

<template>
  <div v-if="context" class="pull-review-comment-panel">
    <PullReviewCommentEditor :key="editorKey" :context="context" />
  </div>
  <div v-else class="pull-review-comment-panel-empty">Loading...</div>
</template>

<style scoped>
.pull-review-comment-panel,
.pull-review-comment-panel-empty {
  height: 100%;
  overflow: hidden;
}

.pull-review-comment-panel-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
}
</style>
