<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ForgejoIssue, ForgejoUser } from '../types/api';

const props = defineProps<{
  type: 'user' | 'issue';
  data?: ForgejoUser | ForgejoIssue;
  loading?: boolean;
  error?: string;
  x: number;
  y: number;
}>();

const { t } = useI18n();

const user = computed(() => (props.type === 'user' ? (props.data as ForgejoUser | undefined) : undefined));
const issue = computed(() => (props.type === 'issue' ? (props.data as ForgejoIssue | undefined) : undefined));

const issueIcon = computed(() => (issue.value?.is_pull ? 'git-pull-request' : 'issues'));
const issueStateClass = computed(() => (issue.value?.state === 'open' ? 'state-open' : 'state-closed'));

// Keep the fixed-position card inside the webview viewport so it is not
// clipped by the right edge in narrow sidebars.
const CARD_MAX_WIDTH = 360;
const VIEWPORT_GAP = 8;

const cardStyle = computed(() => {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const maxLeft = Math.max(VIEWPORT_GAP, viewportWidth - CARD_MAX_WIDTH - VIEWPORT_GAP);
  const left = Math.min(Math.max(props.x + 12, VIEWPORT_GAP), maxLeft);
  return { top: `${props.y + 12}px`, left: `${left}px` };
});

function formatDate(value?: string): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString();
}
</script>

<template>
  <div class="mention-hover-card" :style="cardStyle" @mouseenter.stop @mouseleave.stop>
    <div v-if="loading" class="hover-loading">{{ t('dashboard.hoverCard.loading') }}</div>
    <div v-else-if="error" class="hover-error">{{ t('dashboard.hoverCard.error', { message: error }) }}</div>
    <div v-else-if="user" class="hover-user">
      <img v-if="user.avatar_url" :src="user.avatar_url" :alt="user.login" class="hover-avatar" />
      <vscode-icon v-else name="account" :size="32" class="hover-avatar hover-avatar-fallback" />
      <div class="hover-user-info">
        <div class="hover-login">{{ user.login }}</div>
        <div v-if="user.full_name" class="hover-fullname">{{ user.full_name }}</div>
      </div>
    </div>
    <div v-else-if="issue" class="hover-issue">
      <div class="hover-issue-header">
        <vscode-icon :name="issueIcon" :size="16" class="hover-issue-icon" :class="issueStateClass" />
        <span class="hover-issue-number">#{{ issue.number }}</span>
        <span class="hover-issue-state" :class="issueStateClass">
          {{
            issue.state === 'open'
              ? t('dashboard.hoverCard.issueState.open')
              : t('dashboard.hoverCard.issueState.closed')
          }}
        </span>
      </div>
      <div class="hover-issue-title">{{ issue.title }}</div>
      <div v-if="issue.user" class="hover-issue-meta">
        {{ t('dashboard.hoverCard.openedBy') }} {{ issue.user.login }} · {{ formatDate(issue.created_at) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.mention-hover-card {
  position: fixed;
  z-index: 1000;
  /* Cap the minimum too: below ~248px viewport a fixed min-width wins over
     max-width and the card would overflow the right edge. */
  min-width: min(240px, calc(100vw - 16px));
  max-width: min(360px, calc(100vw - 16px));
  padding: 12px;
  background-color: var(--vscode-editorHoverWidget-background);
  color: var(--vscode-editorHoverWidget-foreground);
  border: 1px solid var(--vscode-editorHoverWidget-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  font-size: 0.9em;
  pointer-events: none;
}

.hover-loading,
.hover-error {
  color: var(--vscode-descriptionForeground);
}

.hover-error {
  color: var(--vscode-testing-iconFailed);
}

.hover-user {
  display: flex;
  align-items: center;
  gap: 12px;
}

.hover-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hover-avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.hover-user-info {
  min-width: 0;
}

.hover-login {
  font-weight: 600;
  color: var(--vscode-foreground);
}

.hover-fullname {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.hover-issue-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.hover-issue-icon.state-open {
  color: var(--vscode-gitDecoration-untrackedResourceForeground);
}

.hover-issue-icon.state-closed {
  color: var(--vscode-gitDecoration-deletedResourceForeground);
}

.hover-issue-number {
  color: var(--vscode-textLink-foreground);
  font-weight: 600;
}

.hover-issue-state {
  font-size: 0.8em;
  padding: 1px 6px;
  border-radius: 10px;
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.hover-issue-title {
  font-weight: 600;
  margin-bottom: 6px;
  word-break: break-word;
}

.hover-issue-meta {
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
}
</style>
