<script setup lang="ts">
import { computed, onActivated, onDeactivated, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import ModalDialog from '../components/ModalDialog.vue';
import IssueForm from '../components/IssueForm.vue';
import AttachmentList from '../components/AttachmentList.vue';
import PendingAttachmentList from '../components/PendingAttachmentList.vue';
import {
  useAppState,
  issueFormKey,
  repoDetailKey,
  repoIssuesKey,
  repoLabelsKey,
  repoAssigneesKey,
  repoMilestonesKey,
  repoRefsKey,
} from '../composables/useAppState';
import type { ForgejoIssue } from '../types/api';
import { stateLabel } from '../utils/stateLabel';

const { t } = useI18n();
const route = useRoute();
const state = useAppState();

const instanceId = computed(() => String(route.params.instanceId));
const owner = computed(() => String(route.params.owner));
const repo = computed(() => String(route.params.repo));
const stateParam = computed(() => String(route.params.state || 'open'));
const searchInput = ref('');
const appliedQuery = ref('');
const key = computed(() =>
  repoIssuesKey(instanceId.value, owner.value, repo.value, stateParam.value, appliedQuery.value),
);

const items = computed(() => state.repoIssues.value.get(key.value) ?? []);
const loading = computed(() => state.loading.get(key.value) ?? false);
const error = computed(() => state.errors.get(key.value));

// Keep the previous list on screen while a newly selected key (state filter,
// search query) loads; swap only when fresh data or an error lands, so the
// list never flashes a loading placeholder in place of the old items.
const displayItems = ref<ForgejoIssue[]>([]);
watch(
  [items, loading, error],
  ([newItems, isLoading, err]) => {
    if (!isLoading || err) {
      displayItems.value = newItems;
    }
  },
  { immediate: true },
);

const isCreating = ref(false);
const createFormResetKey = ref(0);
const createInitialTitle = ref('');
const createInitialBody = ref('');
const createFormDirty = ref(false);
const createFormKey = computed(() => issueFormKey(instanceId.value, owner.value, repo.value, 0));
const createLoading = computed(() => state.loading.get(createFormKey.value) ?? false);
const createError = computed(() => state.errors.get(createFormKey.value));
const pendingIssueAttachments = ref<File[]>([]);
const pendingImageObjectUrls = ref<Map<string, File>>(new Map());
const uploadingIssueAttachmentCount = ref(0);
const createDialogLoading = computed(() => createLoading.value || uploadingIssueAttachmentCount.value > 0);

const labelsKey = computed(() => repoLabelsKey(instanceId.value, owner.value, repo.value));
const assigneesKey = computed(() => repoAssigneesKey(instanceId.value, owner.value, repo.value));
const milestonesKey = computed(() => repoMilestonesKey(instanceId.value, owner.value, repo.value));
const refsKey = computed(() => repoRefsKey(instanceId.value, owner.value, repo.value));

const repoKey = computed(() => repoDetailKey(instanceId.value, owner.value, repo.value));
const repoDetail = computed(() => state.repoDetails.value.get(repoKey.value));
const hasIssues = computed(
  () => !repoDetail.value?.repository.mirror && repoDetail.value?.repository.has_issues !== false,
);
const labels = computed(() => state.repoLabels.value.get(labelsKey.value) ?? []);
const assignees = computed(() => state.repoAssignees.value.get(assigneesKey.value) ?? []);
const milestones = computed(() => state.repoMilestones.value.get(milestonesKey.value) ?? []);
const refs = computed(() => state.repoRefs.value.get(refsKey.value));
const branches = computed(
  () => refs.value?.branches.map((b) => b.name).filter((name): name is string => Boolean(name)) ?? [],
);
const tags = computed(() => refs.value?.tags.map((t) => t.name).filter((name): name is string => Boolean(name)) ?? []);

// Under keep-alive this view is deactivated (not unmounted) when navigating
// away; `route.params` then tracks the global route, not this view's own
// route. Guard route-driven loading on isActive.
const isActive = ref(true);

function loadListData() {
  state.loadRepoDetail(instanceId.value, owner.value, repo.value);
  if (hasIssues.value) {
    state.loadRepoIssues(instanceId.value, owner.value, repo.value, stateParam.value, appliedQuery.value);
    state.loadRepoLabels(instanceId.value, owner.value, repo.value);
    state.loadRepoAssignees(instanceId.value, owner.value, repo.value);
    state.loadRepoMilestones(instanceId.value, owner.value, repo.value);
    state.loadRepoRefs(instanceId.value, owner.value, repo.value);
  }
}

onActivated(() => {
  isActive.value = true;
  // Params may have changed back before this hook ran; make sure data for the
  // current route is loaded (loaders dedup via their caches).
  loadListData();
});
onDeactivated(() => {
  isActive.value = false;
});

watch(
  [instanceId, owner, repo, stateParam],
  () => {
    if (!isActive.value) {
      return;
    }
    loadListData();
  },
  { immediate: true },
);

let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
watch(searchInput, (value) => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    appliedQuery.value = value.trim();
    if (hasIssues.value) {
      state.loadRepoIssues(instanceId.value, owner.value, repo.value, stateParam.value, appliedQuery.value);
    }
  }, 300);
});

const states = ['open', 'closed', 'all'];

const title = computed(() => `${owner.value}/${repo.value}`);

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

function openIssue(issue: ForgejoIssue) {
  state.openIssueDetail(instanceId.value, owner.value, repo.value, issue.number);
}

function changeState(newState: string) {
  state.changeRepoIssuesState(instanceId.value, owner.value, repo.value, newState);
}

function openCreateIssue(prefill?: { title?: string; body?: string }) {
  createInitialTitle.value = prefill?.title ?? '';
  createInitialBody.value = prefill?.body ?? '';
  createFormResetKey.value += 1;
  state.errors.delete(createFormKey.value);
  isCreating.value = true;
}

// Open the create dialog prefilled when the host asked us to (e.g. the
// "Create Issue from TODO comment" code action), both on mount and while
// this view is already active. A deactivated instance must not consume the
// pending intent meant for the currently active view.
watch(
  [instanceId, owner, repo, () => state.pendingNewIssue.value],
  () => {
    if (!isActive.value) {
      return;
    }
    const pending = state.consumePendingNewIssue(instanceId.value, owner.value, repo.value);
    if (pending) {
      openCreateIssue({ title: pending.title, body: pending.body });
    }
  },
  { immediate: true },
);

function closeCreateIssue() {
  for (const url of pendingImageObjectUrls.value.keys()) {
    URL.revokeObjectURL(url);
  }
  pendingImageObjectUrls.value.clear();
  pendingIssueAttachments.value = [];
  state.errors.delete(createFormKey.value);
  isCreating.value = false;
}

function handleIssueAttachmentUpload(file: File) {
  pendingIssueAttachments.value.push(file);
}

function removePendingAttachment(index: number) {
  pendingIssueAttachments.value.splice(index, 1);
}

function handleUploadImageForCreate(file: File, onSuccess: (url: string) => void, _onError: (error: string) => void) {
  const objectUrl = URL.createObjectURL(file);
  pendingImageObjectUrls.value.set(objectUrl, file);
  pendingIssueAttachments.value.push(file);
  onSuccess(objectUrl);
}

async function handleCreateSubmit(data: {
  title: string;
  body: string;
  ref?: string;
  labels?: number[];
  assignees?: string[];
  milestone?: number;
  dueDate?: string;
}) {
  try {
    const issue = await state.createIssue(instanceId.value, owner.value, repo.value, data);
    const files = pendingIssueAttachments.value;
    const replacements = new Map<string, string>();
    if (files.length > 0) {
      await Promise.all(
        files.map(async (file) => {
          uploadingIssueAttachmentCount.value += 1;
          try {
            const attachment = await state.uploadIssueAttachment(
              instanceId.value,
              owner.value,
              repo.value,
              issue.number,
              file,
            );
            if (attachment.uuid) {
              for (const [objectUrl, pendingFile] of pendingImageObjectUrls.value) {
                if (pendingFile === file) {
                  replacements.set(objectUrl, `/attachments/${attachment.uuid}`);
                  break;
                }
              }
            }
          } finally {
            uploadingIssueAttachmentCount.value -= 1;
          }
        }),
      );
    }
    let updatedBody = data.body;
    for (const [objectUrl, attachmentUrl] of replacements) {
      updatedBody = updatedBody.replaceAll(objectUrl, attachmentUrl);
    }
    if (updatedBody !== data.body) {
      state.editIssue(instanceId.value, owner.value, repo.value, issue.number, {
        title: data.title,
        body: updatedBody,
      });
    }
    for (const url of pendingImageObjectUrls.value.keys()) {
      URL.revokeObjectURL(url);
    }
    pendingImageObjectUrls.value.clear();
    pendingIssueAttachments.value = [];
    isCreating.value = false;
    state.openIssueDetail(instanceId.value, owner.value, repo.value, issue.number);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.errors.set(createFormKey.value, message);
  }
}
</script>

<template>
  <div class="repo-issues">
    <div class="list-header">
      <h2>{{ t('dashboard.repoIssues.title', { repo: title }) }}</h2>
      <div class="header-actions">
        <vscode-textfield
          :value="searchInput"
          class="search-input"
          :placeholder="t('dashboard.repoIssues.searchPlaceholder')"
          @input="searchInput = ($event.target as HTMLInputElement).value"
        />
        <vscode-button icon="add" @click="openCreateIssue()">
          {{ t('dashboard.actions.newIssue') }}
        </vscode-button>
        <div class="state-filter">
          <button
            v-for="s in states"
            :key="s"
            class="filter-button"
            :class="{ active: stateParam === s }"
            @click="changeState(s)"
          >
            {{ t(`dashboard.state.${s}`) }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="!hasIssues" class="empty-list">{{ t('dashboard.repoIssues.disabled') }}</div>
    <div v-else-if="error" class="error">{{ t('dashboard.error', { message: error }) }}</div>
    <div v-else-if="displayItems.length" class="item-list" :class="{ refreshing: loading }" :aria-busy="loading">
      <div v-for="issue in displayItems" :key="issue.id" class="item-card">
        <div class="item-title">
          <button type="button" class="link-button" @click="openIssue(issue)">
            #{{ issue.number }} {{ issue.title }}
          </button>
          <span class="issue-actions">
            <button
              type="button"
              class="link-button"
              :title="t('dashboard.actions.open')"
              :aria-label="t('dashboard.actions.open')"
              @click="state.openExternal(issue.html_url)"
            >
              <svg class="icon-link" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path
                  d="M1.5 1.75a.25.25 0 0 1 .25-.25h6.5a.75.75 0 0 0 0-1.5h-6.5C.786 0 0 .784 0 1.75v12.5C0 15.216.784 16 1.75 16h12.5A1.75 1.75 0 0 0 16 14.25v-6.5a.75.75 0 0 0-1.5 0v6.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25V1.75zM12.5 0a.75.75 0 0 0 0 1.5h2.19L6.22 9.97a.75.75 0 1 0 1.06 1.06L15.5 2.56v2.19a.75.75 0 0 0 1.5 0v-3.5a.75.75 0 0 0-.75-.75h-3.5z"
                />
              </svg>
            </button>
          </span>
        </div>
        <div class="item-meta">
          <span :class="`state-${issue.state}`" class="state-badge">{{ stateLabel(issue.state, t) }}</span>
          <img v-if="issue.user?.avatar_url" :src="issue.user.avatar_url" :alt="issue.user.login" class="user-avatar" />
          <span v-if="issue.user">{{ issue.user.login }}</span>
          <span>{{ formatDate(issue.updated_at) }}</span>
        </div>
      </div>
    </div>
    <div v-else-if="loading" class="loading">{{ t('dashboard.loading') }}</div>
    <div v-else class="empty-list">{{ t('dashboard.repoIssues.empty') }}</div>

    <ModalDialog
      :open="isCreating"
      :title="t('dashboard.form.newIssue')"
      :loading="createDialogLoading"
      :confirm-close-if-dirty="true"
      :is-dirty="createFormDirty"
      @close="closeCreateIssue"
    >
      <IssueForm
        :key="createFormResetKey"
        mode="create"
        :submit-label="t('dashboard.form.create')"
        :loading="createDialogLoading"
        :error="createError"
        :initial-title="createInitialTitle"
        :initial-body="createInitialBody"
        :labels="labels"
        :assignees="assignees"
        :milestones="milestones"
        :branches="branches"
        :tags="tags"
        :upload-image="handleUploadImageForCreate"
        :instance-id="instanceId"
        :owner="owner"
        :repo="repo"
        @submit="handleCreateSubmit"
        @cancel="closeCreateIssue"
        @dirty="createFormDirty = $event"
      >
        <template #extra>
          <AttachmentList
            :assets="[]"
            :allow-upload="true"
            :allow-delete="false"
            :uploading="uploadingIssueAttachmentCount > 0"
            @upload="handleIssueAttachmentUpload($event)"
          />
          <PendingAttachmentList :files="pendingIssueAttachments" @remove="removePendingAttachment($event)" />
        </template>
      </IssueForm>
    </ModalDialog>
  </div>
</template>

<style scoped>
.repo-issues {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  overflow: auto;
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.list-header h2 {
  margin: 0;
  font-size: 1.1rem;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.state-filter {
  display: flex;
  gap: 6px;
}

.search-input {
  min-width: 180px;
}

.filter-button {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--vscode-foreground);
  padding: 4px 10px;
  cursor: pointer;
  font-size: 0.9em;
  border-radius: 0;
}

.filter-button:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
}

.filter-button.active {
  color: var(--vscode-textLink-foreground);
  border-bottom-color: var(--vscode-textLink-foreground);
}

.loading {
  color: var(--vscode-descriptionForeground);
}

.error {
  color: var(--vscode-testing-iconFailed);
}

.empty-list {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  padding: 12px 0;
}

.item-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Previous items stay visible while the new filter loads; dim them slightly
   to signal the refresh instead of flashing an empty loading state. */
.item-list.refreshing {
  opacity: 0.55;
  transition: opacity 0.15s ease-in-out;
}

.item-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  padding: 10px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.item-title {
  font-weight: 600;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.item-title .link-button {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}

.item-title .link-button:hover {
  text-decoration: underline;
}

.issue-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-left: auto;
}

.issue-actions .link-button {
  color: var(--vscode-descriptionForeground);
  text-decoration: none;
  padding: 2px;
}

.issue-actions .link-button:hover {
  color: var(--vscode-textLink-foreground);
}

.issue-actions .link-button svg {
  width: 14px;
  height: 14px;
  display: block;
}

.item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.state-badge {
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 0.85em;
  font-weight: 600;
  text-transform: capitalize;
}

.state-open {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-gitDecoration-untrackedResourceForeground, #28a745);
}

.state-closed {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-gitDecoration-deletedResourceForeground, #d73a49);
}

.state-all {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-panel-border);
}

.user-avatar {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  object-fit: cover;
}
</style>
