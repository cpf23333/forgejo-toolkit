<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import ModalDialog from '../components/ModalDialog.vue';
import PullRequestForm from '../components/PullRequestForm.vue';
import AttachmentList from '../components/AttachmentList.vue';
import PendingAttachmentList from '../components/PendingAttachmentList.vue';
import {
  useAppState,
  pullRequestFormKey,
  repoDetailKey,
  repoLabelsKey,
  repoAssigneesKey,
  repoMilestonesKey,
  repoPullRequestsKey,
} from '../composables/useAppState';
import type { ForgejoPullRequest } from '../types/api';

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
  repoPullRequestsKey(instanceId.value, owner.value, repo.value, stateParam.value, appliedQuery.value),
);

const items = computed(() => state.repoPullRequests.value.get(key.value) ?? []);
const loading = computed(() => state.loading.get(key.value) ?? false);
const error = computed(() => state.errors.get(key.value));

const isCreating = ref(false);
const createFormResetKey = ref(0);
const createInitialHead = ref('');
const createFormKey = computed(() => pullRequestFormKey(instanceId.value, owner.value, repo.value, 0));
const createLoading = computed(() => state.loading.get(createFormKey.value) ?? false);
const createError = computed(() => state.errors.get(createFormKey.value));
const pendingIssueAttachments = ref<File[]>([]);
const pendingImageObjectUrls = ref<Map<string, File>>(new Map());
const uploadingIssueAttachmentCount = ref(0);
const createDialogLoading = computed(() => createLoading.value || uploadingIssueAttachmentCount.value > 0);
const repoKey = computed(() => repoDetailKey(instanceId.value, owner.value, repo.value));
const repoDetail = computed(() => state.repoDetails.value.get(repoKey.value));
const hasPullRequests = computed(
  () => !repoDetail.value?.repository.mirror && repoDetail.value?.repository.has_pull_requests !== false,
);
const branches = computed(() => repoDetail.value?.branches ?? []);
// The prefilled head branch may not be among the first branches returned by
// the API; append it so the select can display it.
const createBranches = computed(() =>
  createInitialHead.value && !branches.value.includes(createInitialHead.value)
    ? [...branches.value, createInitialHead.value]
    : branches.value,
);
const labelsKey = computed(() => repoLabelsKey(instanceId.value, owner.value, repo.value));
const labels = computed(() => state.repoLabels.value.get(labelsKey.value) ?? []);
const assigneesKey = computed(() => repoAssigneesKey(instanceId.value, owner.value, repo.value));
const assignees = computed(() => state.repoAssignees.value.get(assigneesKey.value) ?? []);
const milestonesKey = computed(() => repoMilestonesKey(instanceId.value, owner.value, repo.value));
const milestones = computed(() => state.repoMilestones.value.get(milestonesKey.value) ?? []);

watch(
  [instanceId, owner, repo, stateParam],
  () => {
    state.loadRepoDetail(instanceId.value, owner.value, repo.value);
    if (hasPullRequests.value) {
      state.loadRepoPullRequests(instanceId.value, owner.value, repo.value, stateParam.value, appliedQuery.value);
    }
  },
  { immediate: true },
);

let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
watch(searchInput, (value) => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    appliedQuery.value = value.trim();
    if (hasPullRequests.value) {
      state.loadRepoPullRequests(instanceId.value, owner.value, repo.value, stateParam.value, appliedQuery.value);
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

function openPullRequest(pr: ForgejoPullRequest) {
  state.openPullRequestDetail(instanceId.value, owner.value, repo.value, pr.number);
}

function changeState(newState: string) {
  state.changeRepoPullRequestsState(instanceId.value, owner.value, repo.value, newState);
}

function openCreatePullRequest(head = '') {
  createInitialHead.value = head;
  createFormResetKey.value += 1;
  state.errors.delete(createFormKey.value);
  state.loadRepoDetail(instanceId.value, owner.value, repo.value);
  state.loadRepoLabels(instanceId.value, owner.value, repo.value);
  state.loadRepoAssignees(instanceId.value, owner.value, repo.value);
  state.loadRepoMilestones(instanceId.value, owner.value, repo.value);
  isCreating.value = true;
}

// Open the create dialog prefilled from the current branch when the host asked
// us to (status bar / command palette), both on mount and while this view is
// already active.
watch(
  [instanceId, owner, repo, () => state.pendingCreatePr.value],
  () => {
    const pending = state.consumePendingCreatePr(instanceId.value, owner.value, repo.value);
    if (pending) {
      openCreatePullRequest(pending.head);
    }
  },
  { immediate: true },
);

function closeCreatePullRequest() {
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
  base?: string;
  head?: string;
  assignees: string[];
  labels: number[];
  milestone?: number;
  dueDate?: string;
}) {
  try {
    const pr = await state.createPullRequest(instanceId.value, owner.value, repo.value, data);
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
              pr.number,
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
      state.editPullRequest(instanceId.value, owner.value, repo.value, pr.number, {
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
    state.openPullRequestDetail(instanceId.value, owner.value, repo.value, pr.number);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.errors.set(createFormKey.value, message);
  }
}
</script>

<template>
  <div class="repo-pull-requests">
    <div class="list-header">
      <h2>{{ t('dashboard.repoPullRequests.title', { repo: title }) }}</h2>
      <div class="header-actions">
        <vscode-textfield
          :value="searchInput"
          class="search-input"
          :placeholder="t('dashboard.repoPullRequests.searchPlaceholder')"
          @input="searchInput = ($event.target as HTMLInputElement).value"
        />
        <vscode-button icon="add" @click="openCreatePullRequest()">
          {{ t('dashboard.actions.newPullRequest') }}
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

    <div v-if="!hasPullRequests" class="empty-list">{{ t('dashboard.repoPullRequests.disabled') }}</div>
    <div v-else-if="loading" class="loading">{{ t('dashboard.loading') }}</div>
    <div v-else-if="error" class="error">{{ t('dashboard.error', { message: error }) }}</div>
    <div v-else-if="items.length" class="item-list">
      <div v-for="pr in items" :key="pr.id" class="item-card">
        <div class="item-title">
          <button type="button" class="link-button" @click="openPullRequest(pr)">
            #{{ pr.number }} {{ pr.title }}
          </button>
          <span class="pr-actions">
            <button
              type="button"
              class="link-button"
              :title="t('dashboard.actions.open')"
              :aria-label="t('dashboard.actions.open')"
              @click="state.openExternal(pr.html_url)"
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
          <span :class="`state-${pr.state}`" class="state-badge">{{ pr.state }}</span>
          <img v-if="pr.user?.avatar_url" :src="pr.user.avatar_url" :alt="pr.user.login" class="user-avatar" />
          <span v-if="pr.user">{{ pr.user.login }}</span>
          <span>{{ formatDate(pr.updated_at) }}</span>
        </div>
      </div>
    </div>
    <div v-else class="empty-list">{{ t('dashboard.repoPullRequests.empty') }}</div>

    <ModalDialog
      :open="isCreating"
      :title="t('dashboard.form.newPullRequest')"
      :loading="createDialogLoading"
      @close="closeCreatePullRequest"
    >
      <PullRequestForm
        :key="createFormResetKey"
        :initial-base="repoDetail?.repository.default_branch"
        :initial-head="createInitialHead"
        :branches="createBranches"
        :labels="labels"
        :assignees="assignees"
        :milestones="milestones"
        :submit-label="t('dashboard.form.create')"
        :loading="createDialogLoading"
        :error="createError"
        :upload-image="handleUploadImageForCreate"
        :instance-id="instanceId"
        :owner="owner"
        :repo="repo"
        @submit="handleCreateSubmit"
        @cancel="closeCreatePullRequest"
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
      </PullRequestForm>
    </ModalDialog>
  </div>
</template>

<style scoped>
.repo-pull-requests {
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

.pr-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-left: auto;
}

.pr-actions .link-button {
  color: var(--vscode-descriptionForeground);
  text-decoration: none;
  padding: 2px;
}

.pr-actions .link-button:hover {
  color: var(--vscode-textLink-foreground);
}

.pr-actions .link-button svg {
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
