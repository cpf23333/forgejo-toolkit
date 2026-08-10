<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppState, actionRunsKey } from '../composables/useAppState';

const props = defineProps<{
  instanceId: string;
  owner: string;
  repo: string;
}>();

const { t } = useI18n();
const state = useAppState();

const page = ref(1);
const key = computed(() => actionRunsKey(props.instanceId, props.owner, props.repo, page.value));
const totalKey = computed(() => `${props.instanceId}:${props.owner}/${props.repo}`);
const runs = computed(() => state.actionRuns.value.get(key.value) ?? []);
const loading = computed(() => state.loading.get(key.value) ?? false);
const error = computed(() => state.errors.get(key.value));
const totalCount = computed(() => state.actionRunTotalCount.value.get(totalKey.value) ?? 0);

watch(
  [() => props.instanceId, () => props.owner, () => props.repo],
  () => {
    page.value = 1;
    state.loadActionRuns(props.instanceId, props.owner, props.repo, page.value);
  },
  { immediate: true },
);

function reload() {
  state.loadActionRuns(props.instanceId, props.owner, props.repo, page.value, true);
}

function statusIcon(status?: string): string {
  switch (status) {
    case 'success':
      return 'check';
    case 'failure':
    case 'error':
      return 'error';
    case 'running':
      return 'sync';
    case 'pending':
    case 'waiting':
    case 'requested':
      return 'watch';
    case 'cancelled':
      return 'circle-slash';
    case 'skipped':
      return 'debug-step-over';
    default:
      return 'question';
  }
}

function statusClass(status?: string): string {
  return status ?? 'unknown';
}

function formatDuration(nanoseconds?: number): string {
  if (nanoseconds === undefined || nanoseconds === null || nanoseconds <= 0) {
    return '';
  }
  const seconds = Math.floor(nanoseconds / 1_000_000_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return t('dashboard.actionsDuration.hoursMinutes', { hours, minutes: minutes % 60 });
  }
  if (minutes > 0) {
    return t('dashboard.actionsDuration.minutesSeconds', { minutes, seconds: seconds % 60 });
  }
  return t('dashboard.actionsDuration.seconds', { seconds });
}

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
</script>

<template>
  <div class="repo-actions">
    <div v-if="loading && runs.length === 0" class="loading-state">
      <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
    </div>
    <div v-else-if="error" class="error-state">
      <span>{{ t('dashboard.error', { message: error }) }}</span>
      <vscode-button variant="secondary" icon="refresh" @click="reload">
        {{ t('dashboard.retry') }}
      </vscode-button>
    </div>
    <div v-else-if="runs.length === 0" class="empty-state">
      {{ t('dashboard.repoActions.empty') }}
    </div>
    <div v-else class="actions-list">
      <div v-for="run in runs" :key="run.id ?? run.index_in_repo" class="action-run-item">
        <vscode-icon :class="['run-status-icon', statusClass(run.status)]" :name="statusIcon(run.status)" />
        <div class="run-info">
          <div class="run-title-row">
            <button
              type="button"
              class="link-button run-title"
              :title="run.title"
              @click="run.html_url ? state.openExternal(run.html_url) : undefined"
            >
              {{ run.title || run.workflow_id || t('dashboard.repoActions.untitledRun') }}
            </button>
            <span class="run-index">#{{ run.index_in_repo }}</span>
          </div>
          <div class="run-meta">
            <span v-if="run.prettyref" class="run-meta-item">
              <vscode-icon name="git-branch" />
              {{ run.prettyref }}
            </span>
            <span v-if="run.event" class="run-meta-item">
              <vscode-icon name="zap" />
              {{ run.event }}
            </span>
            <span :class="['run-meta-item', 'run-status', statusClass(run.status)]">
              {{ run.status }}
            </span>
            <span v-if="run.duration" class="run-meta-item">
              <vscode-icon name="clock" />
              {{ formatDuration(run.duration) }}
            </span>
            <span v-if="run.updated" class="run-meta-item">
              <vscode-icon name="history" />
              {{ formatDate(run.updated) }}
            </span>
          </div>
        </div>
      </div>
      <div v-if="totalCount > runs.length" class="actions-footer">
        <vscode-button
          variant="secondary"
          :disabled="loading"
          @click="
            page++;
            reload();
          "
        >
          {{ loading ? t('dashboard.loading') : t('dashboard.repoActions.loadMore') }}
        </vscode-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.repo-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.loading-state,
.error-state,
.empty-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  color: var(--vscode-descriptionForeground);
}

.error-state {
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.actions-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.action-run-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.run-status-icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.run-status-icon.success {
  color: var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground));
}

.run-status-icon.failure,
.run-status-icon.error {
  color: var(--vscode-testing-iconFailed, var(--vscode-gitDecoration-deletedResourceForeground));
}

.run-status-icon.running {
  color: var(--vscode-descriptionForeground);
}

.run-status-icon.pending,
.run-status-icon.waiting,
.run-status-icon.requested {
  color: var(--vscode-descriptionForeground);
}

.run-status-icon.cancelled {
  color: var(--vscode-descriptionForeground);
}

.run-status-icon.skipped {
  color: var(--vscode-descriptionForeground);
}

.run-status-icon.unknown {
  color: var(--vscode-descriptionForeground);
}

.run-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.run-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.run-title {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.run-index {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  flex-shrink: 0;
}

.run-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.run-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.run-meta-item vscode-icon {
  flex-shrink: 0;
}

.run-status.success {
  color: var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground));
}

.run-status.failure,
.run-status.error {
  color: var(--vscode-testing-iconFailed, var(--vscode-gitDecoration-deletedResourceForeground));
}

.run-status.running {
  color: var(--vscode-descriptionForeground);
}

.actions-footer {
  display: flex;
  justify-content: center;
  margin-top: 8px;
}
</style>
