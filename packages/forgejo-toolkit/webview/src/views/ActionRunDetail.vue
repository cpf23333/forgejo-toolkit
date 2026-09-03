<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  useAppState,
  actionRunKey,
  actionRunJobsKey,
  actionRunArtifactsKey,
  actionJobLogKey,
  actionRunCancelKey,
  actionRunDeleteKey,
  actionArtifactDownloadKey,
} from '../composables/useAppState';

const route = useRoute();
const { t } = useI18n();
const state = useAppState();

const instanceId = computed(() => String(route.params.instanceId));
const owner = computed(() => String(route.params.owner));
const repo = computed(() => String(route.params.repo));
const runId = computed(() => Number(route.params.runId));

const runKey = computed(() => actionRunKey(instanceId.value, owner.value, repo.value, runId.value));
const jobsKey = computed(() => actionRunJobsKey(instanceId.value, owner.value, repo.value, runId.value));
const artifactsKey = computed(() => actionRunArtifactsKey(instanceId.value, owner.value, repo.value, runId.value));

const run = computed(() => state.actionRunDetails.value.get(runKey.value));
const jobs = computed(() => state.actionRunJobs.value.get(jobsKey.value) ?? []);
const artifacts = computed(() => state.actionRunArtifacts.value.get(artifactsKey.value) ?? []);
const runLoading = computed(() => state.loading.get(runKey.value) ?? false);
const jobsLoading = computed(() => state.loading.get(jobsKey.value) ?? false);
const artifactsLoading = computed(() => state.loading.get(artifactsKey.value) ?? false);
const runError = computed(() => state.errors.get(runKey.value));
const jobsError = computed(() => state.errors.get(jobsKey.value));
const artifactsError = computed(() => state.errors.get(artifactsKey.value));
const cancelKey = computed(() => actionRunCancelKey(instanceId.value, owner.value, repo.value, runId.value));
const cancelLoading = computed(() => state.loading.get(cancelKey.value) ?? false);
const cancelError = computed(() => state.errors.get(cancelKey.value));
const deleteKey = computed(() => actionRunDeleteKey(instanceId.value, owner.value, repo.value, runId.value));
const deleteLoading = computed(() => state.loading.get(deleteKey.value) ?? false);
const deleteError = computed(() => state.errors.get(deleteKey.value));

const jobLogElements = ref<Map<number, HTMLPreElement>>(new Map());
const jobLogScrollStates = ref<Map<number, { wasAtBottom: boolean }>>(new Map());

// Under keep-alive this view is deactivated (not unmounted) when navigating
// away; `route.params` then tracks the global route, not this view's own
// route. Guard all route-driven loading on isActive.
const isActive = ref(true);

function loadRunData() {
  if (!instanceId.value || !owner.value || !repo.value || Number.isNaN(runId.value)) {
    return;
  }
  state.loadActionRun(instanceId.value, owner.value, repo.value, runId.value);
  state.loadActionRunJobs(instanceId.value, owner.value, repo.value, runId.value);
  state.loadActionRunArtifacts(instanceId.value, owner.value, repo.value, runId.value);
}

watch(
  [instanceId, owner, repo, runId],
  () => {
    if (!isActive.value) {
      return;
    }
    loadRunData();
  },
  { immediate: true },
);

const POLL_INTERVAL_MS = 4000;
let pollTimer: ReturnType<typeof setInterval> | undefined;

function isFinalStatus(status?: string): boolean {
  return ['success', 'failure', 'error', 'cancelled', 'skipped'].includes(status ?? '');
}

function refreshRun() {
  if (!instanceId.value || !owner.value || !repo.value || Number.isNaN(runId.value)) {
    return;
  }
  state.loadActionRun(instanceId.value, owner.value, repo.value, runId.value, true);
  state.loadActionRunJobs(instanceId.value, owner.value, repo.value, runId.value, true);
  state.loadActionRunArtifacts(instanceId.value, owner.value, repo.value, runId.value, true);
  for (const job of jobs.value) {
    const jobId = job.id;
    if (jobId !== undefined) {
      // Logs of finished jobs are immutable; only force-refetch logs of live jobs.
      state.loadActionJobLog(instanceId.value, owner.value, repo.value, jobId, !isFinalStatus(job.status));
    }
  }
}

function startPolling() {
  stopPolling();
  if (isFinalStatus(run.value?.status)) {
    return;
  }
  pollTimer = setInterval(() => {
    refreshRun();
    if (isFinalStatus(run.value?.status)) {
      stopPolling();
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

watch(
  () => run.value?.status,
  (status) => {
    if (isFinalStatus(status)) {
      stopPolling();
    } else if (isActive.value) {
      startPolling();
    }
  },
);

onActivated(() => {
  isActive.value = true;
  // Params may have changed back before this hook ran; make sure data for the
  // current route is loaded (loaders dedup via their caches).
  loadRunData();
  if (!isFinalStatus(run.value?.status)) {
    startPolling();
  }
});

onDeactivated(() => {
  isActive.value = false;
  stopPolling();
});

watch(
  () => state.actionJobLogs.value,
  () => {
    for (const [jobId, el] of jobLogElements.value.entries()) {
      const scrollState = jobLogScrollStates.value.get(jobId);
      const previousScrollHeight = el.scrollHeight;
      const previousScrollTop = el.scrollTop;
      const previousClientHeight = el.clientHeight;
      const wasAtBottom = scrollState?.wasAtBottom ?? true;
      nextTick(() => {
        const newScrollHeight = el.scrollHeight;
        if (wasAtBottom) {
          el.scrollTop = newScrollHeight;
        } else {
          const heightDiff = newScrollHeight - previousScrollHeight;
          el.scrollTop = previousScrollTop + heightDiff;
        }
      });
    }
  },
  { deep: true },
);

onUnmounted(() => {
  stopPolling();
});

function loadAllJobLogs(force = false) {
  for (const job of jobs.value) {
    const jobId = job.id;
    if (jobId !== undefined) {
      state.loadActionJobLog(instanceId.value, owner.value, repo.value, jobId, force);
    }
  }
}

watch(
  () => jobs.value.map((job) => job.id).join(','),
  () => {
    if (!isActive.value) {
      return;
    }
    loadAllJobLogs(false);
  },
);

function jobLog(jobId: number | undefined): string {
  if (jobId === undefined) {
    return '';
  }
  return state.actionJobLogs.value.get(actionJobLogKey(instanceId.value, owner.value, repo.value, jobId)) ?? '';
}

function scrollJobLogToBottom(el?: HTMLPreElement) {
  if (!el) {
    return;
  }
  nextTick(() => {
    el.scrollTop = el.scrollHeight;
  });
}

function setJobLogElement(el: HTMLPreElement | null, jobId: number | undefined) {
  if (jobId === undefined) {
    return;
  }
  if (el) {
    jobLogElements.value.set(jobId, el);
    scrollJobLogToBottom(el);
  } else {
    jobLogElements.value.delete(jobId);
  }
}

function onJobLogScroll(jobId: number | undefined, event: Event) {
  if (jobId === undefined) {
    return;
  }
  const el = event.target as HTMLPreElement;
  const isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  jobLogScrollStates.value.set(jobId, { wasAtBottom: isAtBottom });
}

function jobLogLoading(jobId: number | undefined): boolean {
  if (jobId === undefined) {
    return false;
  }
  return state.loading.get(actionJobLogKey(instanceId.value, owner.value, repo.value, jobId)) ?? false;
}

function jobLogError(jobId: number | undefined): string | undefined {
  if (jobId === undefined) {
    return undefined;
  }
  return state.errors.get(actionJobLogKey(instanceId.value, owner.value, repo.value, jobId));
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

function formatDate(date?: string): string {
  if (!date) {
    return '';
  }
  try {
    return new Date(date).toLocaleString();
  } catch {
    return date;
  }
}

function artifactDownloadUrl(artifact: { archive_download_url?: string }): string {
  return artifact.archive_download_url ?? '';
}

function canCancelRun(status?: string): boolean {
  return ['running', 'waiting', 'pending', 'requested'].includes(status ?? '');
}

async function cancelRun() {
  if (!canCancelRun(run.value?.status)) {
    return;
  }
  const confirmed = await state.showConfirm(t('dashboard.actionRun.cancelConfirm'));
  if (!confirmed) {
    return;
  }
  state.cancelActionRun(instanceId.value, owner.value, repo.value, runId.value);
}

async function deleteRun() {
  if (deleteLoading.value) {
    return;
  }
  const confirmed = await state.showConfirm(t('dashboard.actionRun.deleteConfirm'));
  if (!confirmed) {
    return;
  }
  state.deleteActionRun(instanceId.value, owner.value, repo.value, runId.value);
}

function artifactDownloadKey(artifactId?: number): string {
  if (artifactId === undefined) {
    return '';
  }
  return actionArtifactDownloadKey(instanceId.value, owner.value, repo.value, artifactId);
}

function reloadRun() {
  state.loadActionRun(instanceId.value, owner.value, repo.value, runId.value, true);
}

function reloadJobs() {
  state.loadActionRunJobs(instanceId.value, owner.value, repo.value, runId.value, true);
}

function reloadArtifacts() {
  state.loadActionRunArtifacts(instanceId.value, owner.value, repo.value, runId.value, true);
}

function reloadJobLog(jobId?: number) {
  if (jobId === undefined) {
    return;
  }
  state.loadActionJobLog(instanceId.value, owner.value, repo.value, jobId, true);
}

function artifactDownloadLoading(artifactId?: number): boolean {
  if (artifactId === undefined) {
    return false;
  }
  return state.loading.get(artifactDownloadKey(artifactId)) ?? false;
}

function artifactDownloadError(artifactId?: number): string | undefined {
  if (artifactId === undefined) {
    return undefined;
  }
  return state.errors.get(artifactDownloadKey(artifactId));
}

function downloadArtifact(artifact: { id?: number; name?: string }) {
  if (artifact.id === undefined) {
    return;
  }
  state.downloadActionArtifact(
    instanceId.value,
    owner.value,
    repo.value,
    artifact.id,
    artifact.name ?? `artifact-${artifact.id}`,
  );
}
</script>

<template>
  <div class="action-run-detail">
    <div class="run-header">
      <vscode-button v-if="run" secondary icon="trash" :disabled="deleteLoading" @click="deleteRun">
        {{ deleteLoading ? t('dashboard.loading') : t('dashboard.actionRun.deleteRun') }}
      </vscode-button>
      <vscode-button
        v-if="run && canCancelRun(run.status)"
        secondary
        icon="circle-slash"
        :disabled="cancelLoading"
        @click="cancelRun"
      >
        {{ cancelLoading ? t('dashboard.loading') : t('dashboard.actionRun.cancelRun') }}
      </vscode-button>
      <vscode-button v-if="run?.html_url" secondary icon="globe" @click="state.openExternal(run.html_url)">
        {{ t('dashboard.actions.open') }}
      </vscode-button>
    </div>

    <div v-if="deleteError" class="error-state">
      <span>{{ t('dashboard.error', { message: deleteError }) }}</span>
    </div>
    <div v-if="cancelError" class="error-state">
      <span>{{ t('dashboard.error', { message: cancelError }) }}</span>
    </div>

    <div v-if="runLoading && !run" class="loading-state">
      <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
    </div>
    <div v-else-if="runError" class="error-state">
      <span>{{ t('dashboard.error', { message: runError }) }}</span>
      <vscode-button secondary icon="refresh" @click="reloadRun">
        {{ t('dashboard.retry') }}
      </vscode-button>
    </div>
    <div v-else-if="run" class="run-summary">
      <div class="run-title-row">
        <vscode-icon :class="['run-status-icon', statusClass(run.status)]" :name="statusIcon(run.status)" />
        <h2 class="run-title">{{ run.title || run.workflow_id || t('dashboard.repoActions.untitledRun') }}</h2>
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
        <span v-if="run.created" class="run-meta-item">
          <vscode-icon name="calendar" />
          {{ formatDate(run.created) }}
        </span>
      </div>
    </div>

    <div v-if="jobsError" class="error-state">
      <span>{{ t('dashboard.error', { message: jobsError }) }}</span>
      <vscode-button secondary icon="refresh" @click="reloadJobs">
        {{ t('dashboard.retry') }}
      </vscode-button>
    </div>
    <div v-else-if="jobs.length > 0 || jobsLoading" class="jobs-section">
      <h3>{{ t('dashboard.actionRun.jobs') }}</h3>
      <div v-if="jobsLoading && jobs.length === 0" class="loading-state">
        <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
      </div>
      <div class="jobs-list">
        <div
          v-for="job in jobs"
          :key="job.id"
          :class="['job-item', { failed: job.status === 'failure' || job.status === 'error' }]"
        >
          <div class="job-header">
            <vscode-icon :class="['job-status-icon', statusClass(job.status)]" :name="statusIcon(job.status)" />
            <span class="job-name">{{ job.name || t('dashboard.actionRun.untitledJob') }}</span>
          </div>
          <div v-if="job.id !== undefined" class="job-log-panel">
            <div v-if="jobLogLoading(job.id)" class="loading-state">
              <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
            </div>
            <div v-else-if="jobLogError(job.id)" class="error-state">
              <span>{{ t('dashboard.error', { message: jobLogError(job.id) }) }}</span>
              <vscode-button secondary icon="refresh" @click="reloadJobLog(job.id)">
                {{ t('dashboard.retry') }}
              </vscode-button>
            </div>
            <pre
              v-else-if="jobLog(job.id)"
              :ref="(el) => setJobLogElement(el as HTMLPreElement, job.id)"
              class="job-log"
              @scroll="onJobLogScroll(job.id, $event)"
              >{{ jobLog(job.id) }}</pre
            >
            <div v-else class="empty-state">{{ t('dashboard.actionRun.noLogs') }}</div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="artifactsError" class="error-state">
      <span>{{ t('dashboard.error', { message: artifactsError }) }}</span>
      <vscode-button secondary icon="refresh" @click="reloadArtifacts">
        {{ t('dashboard.retry') }}
      </vscode-button>
    </div>
    <div v-else-if="artifacts.length > 0" class="artifacts-section">
      <h3>{{ t('dashboard.actionRun.artifacts') }}</h3>
      <div class="artifacts-list">
        <div v-for="artifact in artifacts" :key="artifact.id" class="artifact-row">
          <div class="artifact-item">
            <vscode-icon name="file-zip" />
            <span class="artifact-name">{{ artifact.name }}</span>
            <span v-if="artifact.size_in_bytes !== undefined" class="artifact-size">
              ({{ (artifact.size_in_bytes / 1024).toFixed(1) }} KB)
            </span>
            <vscode-button
              secondary
              icon="cloud-download"
              :disabled="artifactDownloadLoading(artifact.id)"
              @click="downloadArtifact(artifact)"
            >
              {{ artifactDownloadLoading(artifact.id) ? t('dashboard.loading') : t('dashboard.actionRun.download') }}
            </vscode-button>
          </div>
          <div v-if="artifactDownloadError(artifact.id)" class="error-state artifact-error">
            <span>{{ t('dashboard.error', { message: artifactDownloadError(artifact.id) }) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.action-run-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 12px;
}

.run-header {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
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
  color: var(--vscode-errorForeground);
}

.run-summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.run-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.run-title {
  margin: 0;
  font-size: 1.1em;
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

.run-status-icon {
  flex-shrink: 0;
}

.run-status-icon.success,
.job-status-icon.success {
  color: var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground));
}

.run-status-icon.failure,
.run-status-icon.error,
.job-status-icon.failure,
.job-status-icon.error {
  color: var(--vscode-testing-iconFailed, var(--vscode-gitDecoration-deletedResourceForeground));
}

.run-status.success {
  color: var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground));
}

.run-status.failure,
.run-status.error {
  color: var(--vscode-testing-iconFailed, var(--vscode-gitDecoration-deletedResourceForeground));
}

.jobs-section,
.artifacts-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.jobs-section h3,
.artifacts-section h3 {
  margin: 0;
  font-size: 1em;
  font-weight: 600;
}

.jobs-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.job-item {
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  overflow: hidden;
}

.job-item.failed {
  border-left: 3px solid var(--vscode-testing-iconFailed, var(--vscode-gitDecoration-deletedResourceForeground));
}

.job-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  color: var(--vscode-foreground);
  font-weight: 600;
}

.job-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.job-log-panel {
  border-top: 1px solid var(--vscode-panel-border);
}

.job-log {
  margin: 0;
  padding: 12px;
  max-height: 400px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size);
  line-height: var(--vscode-editor-line-height);
  background-color: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
}

.artifacts-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.artifact-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.artifact-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.artifact-size {
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
}

.artifact-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.artifact-error {
  margin-top: -4px;
  padding: 8px 12px;
}
</style>
