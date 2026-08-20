<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppState, actionRunsKey, dispatchWorkflowKey } from '../composables/useAppState';

const props = defineProps<{
  instanceId: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
  branches?: string[];
}>();

const { t } = useI18n();
const state = useAppState();

const page = ref(1);
const showTrigger = ref(false);
const triggerWorkflow = ref('');
const triggerRef = ref(props.defaultBranch ?? '');
const triggerInputs = ref<{ key: string; value: string }[]>([]);
const dispatchKey = computed(() =>
  dispatchWorkflowKey(props.instanceId, props.owner, props.repo, triggerWorkflow.value || 'new'),
);
const dispatchLoading = computed(() => state.loading.get(dispatchKey.value) ?? false);
const dispatchError = computed(() => state.errors.get(dispatchKey.value));
const key = computed(() => actionRunsKey(props.instanceId, props.owner, props.repo, page.value));

let listPollTimer: ReturnType<typeof setInterval> | undefined;
const POLL_INTERVAL_MS = 4000;
const MAX_LIST_POLL_ATTEMPTS = 15;
let listPollAttempts = 0;
const pollingAfterIndex = ref<number | undefined>(undefined);
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

watch(
  () => dispatchLoading.value,
  (loading, previousLoading) => {
    if (previousLoading && !loading && !dispatchError.value && pollingAfterIndex.value !== undefined) {
      startListPolling(pollingAfterIndex.value);
      pollingAfterIndex.value = undefined;
    }
  },
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

function openRunDetail(run: { id?: number }) {
  if (run.id === undefined) {
    return;
  }
  state.openActionRunDetail(props.instanceId, props.owner, props.repo, run.id);
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
  const allRuns = Array.from(state.actionRuns.value.values()).flat();
  return Math.max(0, ...allRuns.map((run) => run.index_in_repo ?? 0));
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
      return;
    }
    state.loadActionRuns(props.instanceId, props.owner, props.repo, 1, true);
    const currentLatest = latestRunIndex();
    if (currentLatest > afterIndex) {
      stopListPolling();
      page.value = 1;
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
  const workflow = triggerWorkflow.value.trim();
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
  showTrigger.value = false;
}

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
          />
        </div>
        <div class="trigger-field">
          <label>{{ t('dashboard.actionRun.ref') }}</label>
          <vscode-single-select v-if="(props.branches ?? []).length > 0" :value="triggerRef" @change="onRefChange">
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
          />
        </div>
        <div class="trigger-inputs">
          <div v-for="(input, index) in triggerInputs" :key="index" class="trigger-input-row">
            <vscode-textfield
              :value="input.key"
              @input="input.key = ($event.target as HTMLInputElement).value"
              :placeholder="t('dashboard.actionRun.inputKey')"
            />
            <vscode-textfield
              :value="input.value"
              @input="input.value = ($event.target as HTMLInputElement).value"
              :placeholder="t('dashboard.actionRun.inputValue')"
            />
            <vscode-button icon-only icon="trash" @click="removeTriggerInput(index)" />
          </div>
          <vscode-button secondary icon="add" @click="addTriggerInput">
            {{ t('dashboard.actionRun.addInput') }}
          </vscode-button>
        </div>
        <div v-if="dispatchError" class="error-state">
          <span>{{ t('dashboard.error', { message: dispatchError }) }}</span>
        </div>
        <div class="trigger-actions">
          <vscode-button
            :disabled="dispatchLoading || !triggerWorkflow.trim() || !triggerRef.trim()"
            @click="submitTrigger"
          >
            {{ dispatchLoading ? t('dashboard.loading') : t('dashboard.repoActions.runWorkflow') }}
          </vscode-button>
          <vscode-button secondary :disabled="dispatchLoading" @click="resetTrigger">
            {{ t('dashboard.actions.cancel') }}
          </vscode-button>
        </div>
      </div>
    </div>

    <div v-if="runs.length > 0" class="actions-list">
      <div v-for="run in runs" :key="run.id ?? run.index_in_repo" class="action-run-item" @click="openRunDetail(run)">
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
      <div v-if="totalCount > runs.length" class="actions-footer">
        <vscode-button
          secondary
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
