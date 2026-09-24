<script setup lang="ts">
import { computed, onActivated, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAppState, notificationsKey } from '../composables/useAppState';
import type { ForgejoNotification } from '../types/api';
import type { ForgejoInstance } from '../types/instance';
import IconActionButton from '../components/IconActionButton.vue';
import { activateTreeRowFromKey, TREE_ROW_ACTION_SELECTOR } from '../utils/treeRowActivation';

const { t } = useI18n();
const state = useAppState();
const router = useRouter();

const statusFilter = ref<'unread' | 'read' | 'all'>('unread');
const typeFilter = ref<'all' | 'issue' | 'pull' | 'repository'>('all');

const instances = computed(() => state.instances.value);
const loading = computed(() => state.loading);
const errors = computed(() => state.errors);
const pollErrors = computed(() => state.notificationPollErrors.value);
const notifications = computed(() => state.notifications.value);
// Counted over the notifications this view is displaying, not over the poller
// slot: the poller only runs while notification polling is enabled, so its
// count is empty (and stale) after a manual load when polling is off.
const unreadCount = computed(() => state.unreadViewNotificationCount.value);

const statusTypes = computed<string[]>(() => {
  if (statusFilter.value === 'unread') {
    return ['unread', 'pinned'];
  }
  if (statusFilter.value === 'read') {
    return ['read'];
  }
  return ['unread', 'read', 'pinned'];
});

const subjectType = computed<string[] | undefined>(() => {
  if (typeFilter.value === 'all') {
    return undefined;
  }
  return [typeFilter.value];
});

function key(instanceId: string): string {
  return notificationsKey(instanceId);
}

function listFor(instanceId: string): ForgejoNotification[] {
  return notifications.value.get(key(instanceId)) ?? [];
}

function filteredList(instanceId: string): ForgejoNotification[] {
  return listFor(instanceId).filter((notification) => {
    if (statusFilter.value === 'unread') {
      return notification.unread;
    }
    if (statusFilter.value === 'read') {
      return !notification.unread;
    }
    return true;
  });
}

// The endpoint returns one page at a time and no total, so a full page is the
// only signal that older notifications exist; the hint tells the user why the
// list stops there, and the button loads the next page.
function hasMore(instanceId: string): boolean {
  return state.notificationsHasMore.value.get(key(instanceId)) ?? false;
}

function nextCursor(instanceId: string): string | undefined {
  return state.notificationsBefore.value.get(key(instanceId));
}

function canLoadMore(instanceId: string): boolean {
  return hasMore(instanceId) && nextCursor(instanceId) !== undefined;
}

function loadMore(instanceId: string) {
  const cursor = nextCursor(instanceId);
  if (!cursor) {
    return;
  }
  state.loadNotifications(instanceId, statusTypes.value, subjectType.value, cursor);
}

function isLoading(): boolean {
  for (const instance of instances.value) {
    if (loading.value.get(key(instance.id))) {
      return true;
    }
  }
  return false;
}

function hasLoaded(): boolean {
  for (const instance of instances.value) {
    if (notifications.value.has(key(instance.id)) || errors.value.has(key(instance.id))) {
      return true;
    }
  }
  return false;
}

// Instances with content, a view error, a poll failure or another page to load
// get a card — a token-expired instance must not collapse into the global empty
// state, and an instance whose loaded page is hidden by the filters must keep
// its "Load more" reachable.
function visibleInstances(): ForgejoInstance[] {
  return instances.value.filter(
    (instance) =>
      filteredList(instance.id).length > 0 ||
      errors.value.has(key(instance.id)) ||
      pollErrors.value.has(instance.id) ||
      canLoadMore(instance.id),
  );
}

function loadAll() {
  for (const instance of instances.value) {
    state.loadNotifications(instance.id, statusTypes.value, subjectType.value);
  }
}

/**
 * The banner's lines, one per cause that is actually known to be wrong.
 *
 * The host sends a complete user-facing sentence for both a failed load
 * (`getNotifications`) and a failed background poll (`pushNotificationError`),
 * so each cause gets exactly one webview wrapper — "Failed to load: …" for the
 * view's own request, "Failed to refresh notifications: …" for the poller's —
 * and neither is ever wrapped on top of the other. A view error and a poll
 * error can both be present (the poller keeps failing while the user's retry
 * fails too), and both are stated instead of the poll cause being dropped.
 */
function bannerErrorLines(instanceId: string): string[] {
  const lines: string[] = [];
  const viewError = errors.value.get(key(instanceId));
  if (viewError) {
    lines.push(t('dashboard.error', { message: viewError }));
  }
  const pollError = pollErrors.value.get(instanceId);
  if (pollError) {
    lines.push(t('dashboard.notifications.pollFailed', { message: pollError }));
  }
  return lines;
}

/**
 * Retry for the banner's per-instance refresh. The composable's reply handling
 * clears the view error on a successful load, but the poll failure lives in a
 * slot only the poller writes, so it has to be cleared here: otherwise the
 * banner would stay on screen after a successful retry, reporting a failure
 * that is no longer true.
 */
function retryInstance(instanceId: string) {
  state.notificationPollErrors.value.delete(instanceId);
  state.loadNotifications(instanceId, statusTypes.value, subjectType.value);
}

// The tree consumes Enter/Space on the focused tree item before the browser can
// activate anything inside it (see utils/treeRowActivation), so a notification
// row would only ever be selected, never opened. The capture-phase listener runs
// before the tree's own and activates the row.
function onTreeKeydownCapture(event: KeyboardEvent) {
  if (activateTreeRowFromKey(event, TREE_ROW_ACTION_SELECTOR)) {
    event.stopImmediatePropagation();
    event.preventDefault();
  }
}

function notificationTypeIcon(notification: ForgejoNotification): string {
  const type = notification.subject?.type?.toLowerCase();
  if (type === 'issue') {
    return 'issues';
  }
  if (type === 'pullrequest' || type === 'pull') {
    return 'git-pull-request';
  }
  if (type === 'repository') {
    return 'repo';
  }
  if (type === 'commit') {
    return 'git-commit';
  }
  return 'bell';
}

function parseOwnerRepo(url: string): { owner: string; repo: string } | undefined {
  try {
    const path = new URL(url).pathname;
    const parts = path.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return { owner: parts[0], repo: parts[1] };
    }
  } catch {
    // ignore
  }
  return undefined;
}

function extractIndex(htmlUrl: string): number | undefined {
  try {
    const parts = new URL(htmlUrl).pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    const index = Number.parseInt(last ?? '', 10);
    if (!Number.isNaN(index)) {
      return index;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function openNotification(event: Event, notification: ForgejoNotification, instanceId: string) {
  if ((event.target as HTMLElement).closest('.notification-actions')) {
    return;
  }
  const htmlUrl = notification.subject?.html_url;
  if (!htmlUrl) {
    return;
  }
  const ownerRepo = notification.repository?.full_name
    ? {
        owner: notification.repository.full_name.split('/')[0],
        repo: notification.repository.full_name.split('/')[1],
      }
    : parseOwnerRepo(htmlUrl);
  if (!ownerRepo) {
    return;
  }
  const type = notification.subject?.type?.toLowerCase();
  const index = extractIndex(htmlUrl);
  if (type === 'issue' && index !== undefined) {
    state.openIssueDetail(instanceId, ownerRepo.owner, ownerRepo.repo, index);
  } else if ((type === 'pullrequest' || type === 'pull') && index !== undefined) {
    state.openPullRequestDetail(instanceId, ownerRepo.owner, ownerRepo.repo, index);
  } else {
    state.openExternal(htmlUrl);
  }
}

function markAsRead(event: Event, instanceId: string, notification: ForgejoNotification) {
  event.stopPropagation();
  if (notification.id === undefined) {
    return;
  }
  state.markNotificationRead(instanceId, notification.id);
}

function markAllAsRead() {
  for (const instance of instances.value) {
    state.markAllNotificationsRead(instance.id);
  }
}

function formatTime(time?: string): string {
  if (!time) {
    return '';
  }
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) {
    return time;
  }
  return date.toLocaleString(state.locale.value);
}

function notificationTypeLabel(notification: ForgejoNotification): string {
  // The real API uses 'PullRequest'/'Issue' etc.; mocks and some servers use
  // 'Pull'. Compare lowercased and cover both.
  const type = notification.subject?.type?.toLowerCase();
  switch (type) {
    case 'issue':
      return t('dashboard.notifications.types.issue');
    case 'pullrequest':
    case 'pull':
      return t('dashboard.notifications.types.pullRequest');
    case 'repository':
      return t('dashboard.notifications.types.repository');
    case 'commit':
      return t('dashboard.notifications.types.commit');
    default:
      return notification.subject?.type ?? '';
  }
}

function notificationMeta(notification: ForgejoNotification): string {
  const parts: string[] = [];
  if (notification.repository?.full_name) {
    parts.push(notification.repository.full_name);
  }
  if (notification.subject?.type) {
    parts.push(notificationTypeLabel(notification));
  }
  if (notification.updated_at) {
    parts.push(formatTime(notification.updated_at));
  }
  return parts.join(' · ');
}

// Debounce rapid filter toggles (e.g. unread → read → all) into a single
// request round; 300ms matches the issue/PR list search debounce.
let filterDebounceTimer: ReturnType<typeof setTimeout> | undefined;
watch([statusFilter, typeFilter], () => {
  clearTimeout(filterDebounceTimer);
  filterDebounceTimer = setTimeout(() => {
    loadAll();
  }, 300);
});

// Under keep-alive this view is deactivated (not unmounted) when navigating
// away, so onMounted only ever fires once. onActivated fires on the first
// mount as well as on every return, keeping the list fresh without relying on
// the manual refresh button.
onActivated(() => {
  loadAll();
});
</script>

<template>
  <div class="notifications">
    <div class="notifications-header">
      <div class="notifications-toolbar">
        <h1 class="notifications-title">{{ t('dashboard.notifications.title') }}</h1>
        <div class="notifications-toolbar-actions">
          <vscode-button
            icon="check-all"
            :disabled="isLoading() || unreadCount === 0"
            :title="t('dashboard.notifications.markAllAsReadHint')"
            :aria-label="t('dashboard.notifications.markAllAsReadHint')"
            @click="markAllAsRead"
            secondary
          >
            <span class="button-label">{{ t('dashboard.notifications.markAllAsRead') }}</span>
          </vscode-button>
          <vscode-button
            icon="refresh"
            :disabled="isLoading()"
            :title="t('dashboard.retry')"
            :aria-label="t('dashboard.retry')"
            @click="loadAll"
            secondary
          >
            <span class="button-label">{{ t('dashboard.retry') }}</span>
          </vscode-button>
        </div>
      </div>

      <div class="notifications-filters">
        <div class="filter-group">
          <label for="notification-status-filter" class="filter-label">
            {{ t('dashboard.notifications.filterStatus') }}
          </label>
          <vscode-single-select
            id="notification-status-filter"
            class="filter-select"
            :value="statusFilter"
            @change="statusFilter = ($event.target as HTMLInputElement).value as typeof statusFilter"
          >
            <vscode-option value="unread">{{ t('dashboard.notifications.unread') }}</vscode-option>
            <vscode-option value="read">{{ t('dashboard.notifications.read') }}</vscode-option>
            <vscode-option value="all">{{ t('dashboard.notifications.all') }}</vscode-option>
          </vscode-single-select>
        </div>
        <div class="filter-group">
          <label for="notification-type-filter" class="filter-label">
            {{ t('dashboard.notifications.filterType') }}
          </label>
          <vscode-single-select
            id="notification-type-filter"
            class="filter-select"
            :value="typeFilter"
            @change="typeFilter = ($event.target as HTMLInputElement).value as typeof typeFilter"
          >
            <vscode-option value="all">{{ t('dashboard.notifications.allTypes') }}</vscode-option>
            <vscode-option value="issue">{{ t('dashboard.tabs.issues') }}</vscode-option>
            <vscode-option value="pull">{{ t('dashboard.tabs.pullRequests') }}</vscode-option>
            <vscode-option value="repository">{{ t('dashboard.tabs.repositories') }}</vscode-option>
          </vscode-single-select>
        </div>
      </div>
    </div>

    <div v-if="instances.length === 0" class="empty-state">
      {{ t('dashboard.notifications.noInstances') }}
    </div>

    <div v-else-if="isLoading() && !hasLoaded()" class="empty-state">
      <vscode-progress-ring class="notifications-loading-ring" />
      {{ t('dashboard.loading') }}
    </div>

    <div v-else-if="hasLoaded() && visibleInstances().length === 0" class="empty-state">
      {{ t('dashboard.notifications.empty') }}
    </div>

    <div v-else class="notifications-list">
      <vscode-tree
        v-for="instance in visibleInstances()"
        :key="instance.id"
        indent-guides="onHover"
        @keydown.capture="onTreeKeydownCapture"
      >
        <vscode-tree-item branch open>
          {{ instance.url }} · {{ instance.username }}
          <vscode-tree-item
            v-for="notification in filteredList(instance.id)"
            :key="notification.id ?? notification.subject?.html_url"
            data-tree-row-action
            @click.capture="openNotification($event, notification, instance.id)"
          >
            <span class="notification-title" :class="{ unread: notification.unread }">
              <vscode-icon class="notification-type-icon" :name="notificationTypeIcon(notification)" :size="16" />
              <span v-if="notification.unread" class="unread-dot" />
              {{ notification.subject?.title ?? t('dashboard.notifications.untitled') }}
            </span>
            <span slot="description" class="notification-meta">
              {{ notificationMeta(notification) }}
            </span>
            <span slot="actions" class="notification-actions">
              <IconActionButton
                v-if="notification.unread"
                name="check"
                :label="t('dashboard.notifications.markAsRead')"
                @click.stop.prevent="markAsRead($event, instance.id, notification)"
              />
              <IconActionButton
                name="link-external"
                :label="t('dashboard.actions.open')"
                @click.stop.prevent="state.openExternal(notification.subject?.html_url ?? '')"
              />
            </span>
          </vscode-tree-item>
          <!-- The instance stays visible for its error rows or another page; when
               the filters hide every loaded row, say so instead of letting the
               instance look empty. -->
          <vscode-tree-item v-if="listFor(instance.id).length > 0 && filteredList(instance.id).length === 0">
            <span class="filter-empty">{{ t('dashboard.notifications.empty') }}</span>
          </vscode-tree-item>
          <vscode-tree-item v-if="canLoadMore(instance.id)">
            <span class="load-more">
              <vscode-button
                secondary
                :disabled="loading.get(key(instance.id))"
                @click.stop.prevent="loadMore(instance.id)"
              >
                {{ loading.get(key(instance.id)) ? t('dashboard.loading') : t('dashboard.notifications.loadMore') }}
              </vscode-button>
            </span>
          </vscode-tree-item>
          <vscode-tree-item v-if="errors.get(key(instance.id)) || pollErrors.get(instance.id)">
            <span class="error">
              <span v-for="(line, index) in bannerErrorLines(instance.id)" :key="index" class="error-line">
                {{ line }}
              </span>
            </span>
            <span slot="actions">
              <IconActionButton
                name="refresh"
                :label="t('dashboard.retry')"
                @click.stop.prevent="retryInstance(instance.id)"
              />
            </span>
          </vscode-tree-item>
        </vscode-tree-item>
      </vscode-tree>
    </div>
  </div>
</template>

<style scoped>
.notifications {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow: auto;
}

.notifications-header {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 8px;
}

.notifications-toolbar {
  /* Narrow sidebars drop the button labels (icons keep their tooltips)
     instead of clipping the text mid-word. */
  container-type: inline-size;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

@container (max-width: 360px) {
  .notifications-toolbar-actions .button-label {
    display: none;
  }
}

.notifications-title {
  margin: 0;
  font-size: 1.1em;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.notifications-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.notifications-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 16px;
}

.filter-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-label {
  font-size: 0.85em;
  color: var(--vscode-foreground);
  font-weight: 600;
}

.filter-select {
  --vscode-settings-dropdownBackground: var(--vscode-sideBar-background, var(--vscode-editor-background));
  --vscode-settings-dropdownBorder: transparent;
  --vscode-settings-dropdownListBorder: var(--vscode-panel-border, transparent);
  width: auto;
  min-width: 120px;
  font-size: 0.85em;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  color: var(--vscode-descriptionForeground);
  flex-direction: column;
}

.notifications-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 8px;
}

.notification-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9em;
}

.notification-title.unread {
  font-weight: 600;
}

.unread-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--vscode-notificationCenter-border, var(--vscode-focusBorder));
  flex-shrink: 0;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: 4px 0;
}

.notification-type-icon {
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}

.notification-meta {
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
}

.notification-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
}

/* One line per failing cause: a load failure and a poll failure are different
   causes and each is stated on its own line. */
.error-line {
  display: block;
}

.filter-empty {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.notifications-loading-ring {
  width: 16px;
  height: 16px;
}
</style>
