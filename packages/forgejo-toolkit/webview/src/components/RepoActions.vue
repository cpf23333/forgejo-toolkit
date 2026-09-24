<script setup lang="ts">
import { computed, onActivated, onDeactivated, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppState, actionRunsKey, dispatchWorkflowKey } from '../composables/useAppState';
import { actionStatusClass as statusClass, actionStatusIcon as statusIcon } from '../utils/actionStatus';

const props = defineProps<{
  instanceId: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
  branches?: string[];
}>();

const { t } = useI18n();
const state = useAppState();

const showTrigger = ref(false);
const triggerWorkflow = ref('');
const triggerRef = ref(props.defaultBranch ?? '');
const triggerInputs = ref<{ key: string; value: string }[]>([]);
// The workflow filename as the rest of the flow uses it (and as the host
// receives it): `dispatchWorkflow` writes its loading/error slot under the
// trimmed name (see submitTrigger). Keying the spinner and the error on the raw
// field instead made a typed trailing space look like a different workflow, so
// a failing dispatch showed no error and the Run button never re-enabled.
const trimmedWorkflow = computed(() => triggerWorkflow.value.trim());
const dispatchKey = computed(() =>
  dispatchWorkflowKey(props.instanceId, props.owner, props.repo, trimmedWorkflow.value || 'new'),
);
const dispatchLoading = computed(() => state.loading.get(dispatchKey.value) ?? false);
const dispatchError = computed(() => state.errors.get(dispatchKey.value));
// One accumulated list per repo: pages append to it, so "Load more" never
// replaces the runs already on screen. The next page is derived from how many
// runs are loaded rather than from a page counter, which keeps a concurrent
// page-1 refresh from leaving a gap in the list.
const key = computed(() => actionRunsKey(props.instanceId, props.owner, props.repo));

let listPollTimer: ReturnType<typeof setInterval> | undefined;
const POLL_INTERVAL_MS = 4000;
const MAX_LIST_POLL_ATTEMPTS = 15;
let listPollAttempts = 0;
const pollingAfterIndex = ref<number | undefined>(undefined);
// Feedback for the dispatch flow: 'waiting' while polling for the new run,
// 'timeout' when the poll gives up without seeing it.
const dispatchStatus = ref<'idle' | 'waiting' | 'timeout'>('idle');
const runs = computed(() => state.actionRuns.value.get(key.value) ?? []);
const loading = computed(() => state.loading.get(key.value) ?? false);
const error = computed(() => state.errors.get(key.value));
const hasMore = computed(() => state.actionRunsHasMore.value.get(key.value) ?? false);
// The next page comes from the loaded-page counter, not from the row count: a
// server that clamps the page size below ACTION_RUNS_PAGE_LIMIT would otherwise
// make the row-count estimate re-request a page that is already loaded.
const nextPage = computed(() => (state.actionRunsPage.value.get(key.value) ?? 0) + 1);

// RepoActions lives inside RepoDetail, which is kept alive: while deactivated
// the parent's props track the global route, not this repo. Guard route-driven
// loading on isActive and stop polling while deactivated.
const isActive = ref(true);

watch(
  [() => props.instanceId, () => props.owner, () => props.repo],
  () => {
    if (!isActive.value) {
      return;
    }
    state.loadActionRuns(props.instanceId, props.owner, props.repo, 1);
  },
  { immediate: true },
);

watch(
  () => dispatchLoading.value,
  (loading, previousLoading) => {
    if (
      previousLoading &&
      !loading &&
      !dispatchError.value &&
      pollingAfterIndex.value !== undefined &&
      isActive.value
    ) {
      if (state.lastDispatchCancelled.value === dispatchKey.value) {
        // The user declined the host-side confirmation: nothing was dispatched,
        // so there is no new run to wait for and no success to announce. Without
        // this the cleared loading flag looks like a successful dispatch and the
        // list would poll for ~60 s before timing out.
        pollingAfterIndex.value = undefined;
        dispatchStatus.value = 'idle';
        return;
      }
      dispatchStatus.value = 'waiting';
      startListPolling(pollingAfterIndex.value);
      pollingAfterIndex.value = undefined;
    }
  },
);

function reload() {
  // Page 1 replaces the accumulated list: a refresh/retry starts the list over
  // rather than appending to stale pages.
  state.loadActionRuns(props.instanceId, props.owner, props.repo, 1, true);
}

function loadMore() {
  state.loadActionRuns(props.instanceId, props.owner, props.repo, nextPage.value);
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

function openRunDetail(run: { id?: number }) {
  if (run.id === undefined) {
    return;
  }
  state.openActionRunDetail(props.instanceId, props.owner, props.repo, run.id);
}

// The row is a button-like container, but it also holds real controls (the
// "Open in Browser" button). Keydown bubbles from them, so activating one would
// run the row action as well; leave keys that originate inside a nested control
// to that control, like FileTreeNode and RepoRefs do.
function onRunRowKeydown(event: KeyboardEvent, run: { id?: number }) {
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, a, input, vscode-button')) {
    return;
  }
  event.preventDefault();
  openRunDetail(run);
}

function onWorkflowChange(event: Event) {
  const target = event.target as HTMLSelectElement | null;
  triggerWorkflow.value = target?.value ?? '';
}

function onRefChange(event: Event) {
  const target = event.target as HTMLSelectElement | null;
  triggerRef.value = target?.value ?? '';
}

function latestRunIndex(): number {
  const prefix = `${props.instanceId}:${props.owner}/${props.repo}:`;
  let max = 0;
  for (const [runKey, list] of state.actionRuns.value) {
    if (!runKey.startsWith(prefix)) {
      continue;
    }
    for (const run of list) {
      max = Math.max(max, run.index_in_repo ?? 0);
    }
  }
  return max;
}

function stopListPolling() {
  if (listPollTimer) {
    clearInterval(listPollTimer);
    listPollTimer = undefined;
  }
  listPollAttempts = 0;
}

function startListPolling(afterIndex: number) {
  stopListPolling();
  listPollAttempts = 0;
  listPollTimer = setInterval(() => {
    listPollAttempts += 1;
    if (listPollAttempts > MAX_LIST_POLL_ATTEMPTS) {
      stopListPolling();
      dispatchStatus.value = 'timeout';
      return;
    }
    state.loadActionRuns(props.instanceId, props.owner, props.repo, 1, true);
    const currentLatest = latestRunIndex();
    if (currentLatest > afterIndex) {
      stopListPolling();
      dispatchStatus.value = 'idle';
    }
  }, POLL_INTERVAL_MS);
}

function addTriggerInput() {
  triggerInputs.value.push({ key: '', value: '' });
}

function removeTriggerInput(index: number) {
  triggerInputs.value.splice(index, 1);
}

function availableWorkflows(): string[] {
  const list = runs.value
    .map((run) => run.workflow_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return Array.from(new Set(list));
}

function submitTrigger() {
  const workflow = trimmedWorkflow.value;
  const ref = triggerRef.value.trim();
  if (!workflow || !ref) {
    return;
  }
  const inputs: Record<string, string> = {};
  for (const item of triggerInputs.value) {
    const key = item.key.trim();
    const value = item.value.trim();
    if (key) {
      inputs[key] = value;
    }
  }
  pollingAfterIndex.value = latestRunIndex();
  state.dispatchWorkflow(props.instanceId, props.owner, props.repo, workflow, ref, inputs);
}

function resetTrigger() {
  triggerWorkflow.value = '';
  triggerRef.value = props.defaultBranch ?? '';
  triggerInputs.value = [];
  dispatchStatus.value = 'idle';
  showTrigger.value = false;
}

onActivated(() => {
  isActive.value = true;
  // Props may have changed back before this hook ran; make sure the list for
  // the current repo is loaded (the loader dedups in-flight requests). Page 1
  // refreshes the accumulated list when the view is re-entered.
  state.loadActionRuns(props.instanceId, props.owner, props.repo, 1);
});

onDeactivated(() => {
  isActive.value = false;
  stopListPolling();
});

onUnmounted(() => {
  stopListPolling();
});
</script>

<template>
  <div class="repo-actions">
    <div v-if="loading && runs.length === 0" class="loading-state">
      <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
    </div>
    <div v-else-if="error" class="error-state">
      <span>{{ t('dashboard.error', { message: error }) }}</span>
      <vscode-button secondary icon="refresh" @click="reload">
        {{ t('dashboard.retry') }}
      </vscode-button>
    </div>
    <div v-else-if="runs.length === 0" class="empty-state">
      {{ t('dashboard.repoActions.empty') }}
    </div>

    <div class="trigger-section">
      <vscode-button v-if="!showTrigger" secondary icon="rocket" @click="showTrigger = true">
        {{ t('dashboard.repoActions.triggerWorkflow') }}
      </vscode-button>
      <div v-else class="trigger-form">
        <div class="trigger-field">
          <label>{{ t('dashboard.actionRun.workflowFile') }}</label>
          <vscode-single-select
            v-if="availableWorkflows().length > 0"
            :value="triggerWorkflow"
            :label="t('dashboard.actionRun.workflowFile')"
            @change="onWorkflowChange"
          >
            <vscode-option value="" disabled>{{ t('dashboard.actionRun.selectWorkflow') }}</vscode-option>
            <vscode-option v-for="wf in availableWorkflows()" :key="wf" :value="wf" :selected="wf === triggerWorkflow">
              {{ wf }}
            </vscode-option>
          </vscode-single-select>
          <vscode-textfield
            v-else
            :value="triggerWorkflow"
            @input="triggerWorkflow = ($event.target as HTMLInputElement).value"
            :placeholder="t('dashboard.actionRun.workflowFilePlaceholder')"
            :label="t('dashboard.actionRun.workflowFile')"
          />
        </div>
        <div class="trigger-field">
          <label>{{ t('dashboard.actionRun.ref') }}</label>
          <vscode-single-select
            v-if="(props.branches ?? []).length > 0"
            :value="triggerRef"
            :label="t('dashboard.actionRun.ref')"
            @change="onRefChange"
          >
            <vscode-option value="" disabled>{{ t('dashboard.actionRun.selectRef') }}</vscode-option>
            <vscode-option
              v-for="branch in props.branches"
              :key="branch"
              :value="branch"
              :selected="branch === triggerRef"
            >
              {{ branch }}
            </vscode-option>
          </vscode-single-select>
          <vscode-textfield
            v-else
            :value="triggerRef"
            @input="triggerRef = ($event.target as HTMLInputElement).value"
            :placeholder="t('dashboard.actionRun.refPlaceholder')"
            :label="t('dashboard.actionRun.ref')"
          />
        </div>
        <div class="trigger-inputs">
          <div v-for="(input, index) in triggerInputs" :key="index" class="trigger-input-row">
            <vscode-textfield
              :value="input.key"
              @input="input.key = ($event.target as HTMLInputElement).value"
              :placeholder="t('dashboard.actionRun.inputKey')"
              :label="t('dashboard.actionRun.inputKey')"
            />
            <vscode-textfield
              :value="input.value"
              @input="input.value = ($event.target as HTMLInputElement).value"
              :placeholder="t('dashboard.actionRun.inputValue')"
              :label="t('dashboard.actionRun.inputValue')"
            />
            <vscode-button
              icon-only
              icon="trash"
              :aria-label="t('dashboard.remove')"
              @click="removeTriggerInput(index)"
            />
          </div>
          <vscode-button secondary icon="add" @click="addTriggerInput">
            {{ t('dashboard.actionRun.addInput') }}
          </vscode-button>
        </div>
        <div v-if="dispatchError" class="error-state">
          <span>{{ t('dashboard.error', { message: dispatchError }) }}</span>
        </div>
        <div v-else-if="dispatchStatus === 'waiting'" class="status-message">
          {{ t('dashboard.repoActions.dispatchWaiting') }}
        </div>
        <div v-else-if="dispatchStatus === 'timeout'" class="status-message">
          {{ t('dashboard.repoActions.dispatchTimeout') }}
        </div>
        <div class="trigger-actions">
          <vscode-button :disabled="dispatchLoading || !trimmedWorkflow || !triggerRef.trim()" @click="submitTrigger">
            {{ dispatchLoading ? t('dashboard.loading') : t('dashboard.repoActions.runWorkflow') }}
          </vscode-button>
          <vscode-button secondary :disabled="dispatchLoading" @click="resetTrigger">
            {{ t('dashboard.actions.cancel') }}
          </vscode-button>
        </div>
      </div>
    </div>

    <div v-if="runs.length > 0" class="actions-list">
      <div
        v-for="run in runs"
        :key="run.id ?? run.index_in_repo"
        class="action-run-item"
        tabindex="0"
        role="button"
        @click="openRunDetail(run)"
        @keydown.enter="onRunRowKeydown($event, run)"
        @keydown.space="onRunRowKeydown($event, run)"
      >
        <vscode-icon :class="['run-status-icon', statusClass(run.status)]" :name="statusIcon(run.status)" />
        <div class="run-info">
          <div class="run-title-row">
            <span class="run-title" :title="run.title">
              {{ run.title || run.workflow_id || t('dashboard.repoActions.untitledRun') }}
            </span>
            <span class="run-index">#{{ run.index_in_repo }}</span>
            <vscode-button
              v-if="run.html_url"
              icon-only
              icon="globe"
              :title="t('dashboard.actions.open')"
              :aria-label="t('dashboard.actions.open')"
              @click.stop="state.openExternal(run.html_url)"
            />
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
      <div v-if="hasMore" class="actions-footer">
        <vscode-button secondary :disabled="loading" @click="loadMore">
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

.status-message {
  padding: 4px 0;
  color: var(--vscode-descriptionForeground);
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
  cursor: pointer;
}

.action-run-item:hover {
  background-color: var(--vscode-list-hoverBackground);
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

.run-status-icon.waiting,
.run-status-icon.blocked {
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

.trigger-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.trigger-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.trigger-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trigger-field label {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.trigger-inputs {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.trigger-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.trigger-input-row > * {
  flex: 1;
}

.trigger-input-row > vscode-button {
  flex: 0 0 auto;
}

.trigger-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
