<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import MarkdownBody from '../components/MarkdownBody.vue';
import AttachmentList from '../components/AttachmentList.vue';
import DiffFileList from '../components/DiffFileList.vue';
import CommentTimeline from '../components/CommentTimeline.vue';
import CommitDiffList from '../components/CommitDiffList.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PullRequestForm from '../components/PullRequestForm.vue';
import EasyMdeEditor from '../components/EasyMdeEditor.vue';
import {
  useAppState,
  pullRequestDetailKey,
  pullRequestFilesKey,
  pullRequestCommentsKey,
  pullRequestCommitsKey,
  pullRequestFormKey,
  pullRequestMergeFormKey,
  issueCommentFormKey,
  repoDetailKey,
} from '../composables/useAppState';
import type { ForgejoIssueAttachment } from '../types/api';

const { t } = useI18n();
const route = useRoute();
const state = useAppState();

const instanceId = computed(() => String(route.params.instanceId));
const owner = computed(() => String(route.params.owner));
const repo = computed(() => String(route.params.repo));
const index = computed(() => Number(route.params.index));
const key = computed(() => pullRequestDetailKey(instanceId.value, owner.value, repo.value, index.value));

const detail = computed(() => state.pullRequestDetails.value.get(key.value));
const loading = computed(() => state.loading.get(key.value) ?? false);
const error = computed(() => state.errors.get(key.value));
const baseUrl = computed(() => state.instances.value.find((i) => i.id === instanceId.value)?.url);
const currentUsername = computed(() => state.instances.value.find((i) => i.id === instanceId.value)?.username);
const isPullRequestAuthor = computed(
  () => detail.value?.user?.login === currentUsername.value && currentUsername.value !== undefined,
);
const canManagePullRequest = computed(() => {
  if (isPullRequestAuthor.value) {
    return true;
  }
  const permissions = detail.value?.repoPermissions;
  return permissions?.admin === true || permissions?.push === true;
});

const filesKey = computed(() => pullRequestFilesKey(instanceId.value, owner.value, repo.value, index.value));
const files = computed(() => state.pullRequestFiles.value.get(filesKey.value) ?? []);
const filesError = computed(() => state.errors.get(filesKey.value));
const filesLoading = computed(() => files.value.length === 0 && !filesError.value);

const commentsKey = computed(() => pullRequestCommentsKey(instanceId.value, owner.value, repo.value, index.value));
const comments = computed(() => state.pullRequestComments.value.get(commentsKey.value) ?? []);
const commentsError = computed(() => state.errors.get(commentsKey.value));
const commentsLoading = computed(() => !state.pullRequestComments.value.has(commentsKey.value) && !commentsError.value);

const commitsKey = computed(() => pullRequestCommitsKey(instanceId.value, owner.value, repo.value, index.value));
const commits = computed(() => state.pullRequestCommits.value.get(commitsKey.value) ?? []);
const commitsError = computed(() => state.errors.get(commitsKey.value));
const commitsLoading = computed(() => !state.pullRequestCommits.value.has(commitsKey.value) && !commitsError.value);

watch(
  [instanceId, owner, repo, index],
  () => {
    state.loadPullRequestDetail(instanceId.value, owner.value, repo.value, index.value);
  },
  { immediate: true },
);

watch(
  () => detail.value,
  () => {
    if (detail.value) {
      state.loadPullRequestFiles(
        instanceId.value,
        owner.value,
        repo.value,
        index.value,
        detail.value.base?.sha,
        detail.value.head?.sha,
      );
      state.loadPullRequestComments(instanceId.value, owner.value, repo.value, index.value);
      state.loadPullRequestCommits(instanceId.value, owner.value, repo.value, index.value);
    }
  },
  { immediate: true },
);

const prUrl = computed(() => detail.value?.html_url ?? '');
const isEditing = ref(false);
const uploadingAttachmentCount = ref(0);
const deletingAttachmentId = ref<number | undefined>(undefined);
const isDeletingAttachments = ref(false);
const pendingDeleteAttachmentIds = ref<number[]>([]);
const editFormKey = computed(() => pullRequestFormKey(instanceId.value, owner.value, repo.value, index.value));
const editLoading = computed(() => state.loading.get(editFormKey.value) ?? false);
const editError = computed(() => state.errors.get(editFormKey.value));
const formLoading = computed(() => editLoading.value || isDeletingAttachments.value);

const commentFormKey = computed(() => issueCommentFormKey(instanceId.value, owner.value, repo.value, index.value));
const commentLoading = computed(() => state.loading.get(commentFormKey.value) ?? false);
const commentError = computed(() => state.errors.get(commentFormKey.value));
const commentBody = ref('');
const pendingCommentAttachments = ref<File[]>([]);
const uploadingCommentAttachmentCount = ref(0);

function handleCommentAttachmentUpload(file: File) {
  pendingCommentAttachments.value.push(file);
}

async function handleCommentImageUpload(
  file: File,
  onSuccess: (url: string) => void,
  onError: (error: string) => void,
) {
  try {
    const attachment = await state.uploadIssueAttachment(instanceId.value, owner.value, repo.value, index.value, file);
    const url = attachment.uuid ? `/attachments/${attachment.uuid}` : (attachment.browser_download_url ?? '');
    if (!url) {
      onError('Failed to upload image');
      return;
    }
    onSuccess(url);
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }
}

async function handleCommentSubmit() {
  const body = commentBody.value.trim();
  if (!body) {
    return;
  }
  try {
    const comment = await state.createIssueComment(instanceId.value, owner.value, repo.value, index.value, body);
    if (comment.id === undefined) {
      throw new Error('Created comment missing id');
    }
    const commentId = comment.id;
    const files = pendingCommentAttachments.value;
    if (files.length > 0) {
      await Promise.all(
        files.map(async (file) => {
          uploadingCommentAttachmentCount.value += 1;
          try {
            await state.uploadIssueCommentAttachment(
              instanceId.value,
              owner.value,
              repo.value,
              index.value,
              commentId,
              file,
            );
          } finally {
            uploadingCommentAttachmentCount.value -= 1;
          }
        }),
      );
    }
    commentBody.value = '';
    pendingCommentAttachments.value = [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.errors.set(commentFormKey.value, message);
  }
}

const mergeFormKey = computed(() => pullRequestMergeFormKey(instanceId.value, owner.value, repo.value, index.value));
const mergeLoading = computed(() => state.loading.get(mergeFormKey.value) ?? false);
const mergeError = computed(() => state.errors.get(mergeFormKey.value));
const mergeStrategy = ref<'merge' | 'rebase' | 'squash'>('merge');
const canMerge = computed(() => detail.value?.state === 'open' && !detail.value?.merged && canManagePullRequest.value);

function handleMerge() {
  if (!canMerge.value) {
    return;
  }
  state.mergePullRequest(instanceId.value, owner.value, repo.value, index.value, mergeStrategy.value);
}

const repoKey = computed(() => repoDetailKey(instanceId.value, owner.value, repo.value));
const repoDetail = computed(() => state.repoDetails.value.get(repoKey.value));
const branches = computed(() => repoDetail.value?.branches ?? []);

function openEdit() {
  state.loadRepoDetail(instanceId.value, owner.value, repo.value);
  state.loadPullRequestDetail(instanceId.value, owner.value, repo.value, index.value);
  isEditing.value = true;
}

function closeEdit() {
  pendingDeleteAttachmentIds.value = [];
  isEditing.value = false;
}

function handleEditSubmit(title: string, body: string) {
  state.editPullRequest(instanceId.value, owner.value, repo.value, index.value, { title, body });
}

async function deletePendingAttachments() {
  const ids = pendingDeleteAttachmentIds.value;
  if (ids.length === 0) {
    return;
  }
  isDeletingAttachments.value = true;
  deletingAttachmentId.value = ids[0];
  try {
    await Promise.all(
      ids.map((id) => state.deleteIssueAttachment(instanceId.value, owner.value, repo.value, index.value, id)),
    );
    const current = detail.value;
    if (current?.assets) {
      current.assets = current.assets.filter((a) => a.id === undefined || !ids.includes(a.id));
    }
  } finally {
    isDeletingAttachments.value = false;
    deletingAttachmentId.value = undefined;
  }
}

async function handleUploadImage(file: File, onSuccess: (url: string) => void, onError: (error: string) => void) {
  try {
    const attachment = await state.uploadIssueAttachment(instanceId.value, owner.value, repo.value, index.value, file);
    const current = detail.value;
    if (current) {
      if (!current.assets) {
        current.assets = [];
      }
      if (!current.assets.some((a) => a.uuid === attachment.uuid)) {
        current.assets.push(attachment);
      }
    }
    onSuccess(attachment.uuid ? `/attachments/${attachment.uuid}` : (attachment.browser_download_url ?? ''));
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }
}

async function handleAttachmentUpload(file: File) {
  uploadingAttachmentCount.value += 1;
  try {
    const attachment = await state.uploadIssueAttachment(instanceId.value, owner.value, repo.value, index.value, file);
    const current = detail.value;
    if (current) {
      if (!current.assets) {
        current.assets = [];
      }
      current.assets.push(attachment);
    }
  } finally {
    uploadingAttachmentCount.value -= 1;
  }
}

function handleAttachmentDelete(asset: ForgejoIssueAttachment) {
  const attachmentId = asset.id;
  if (attachmentId === undefined) {
    return;
  }
  const index = pendingDeleteAttachmentIds.value.indexOf(attachmentId);
  if (index >= 0) {
    pendingDeleteAttachmentIds.value.splice(index, 1);
  } else {
    pendingDeleteAttachmentIds.value.push(attachmentId);
  }
}

function toggleState() {
  const nextState = detail.value?.state === 'open' ? 'closed' : 'open';
  state.editPullRequest(instanceId.value, owner.value, repo.value, index.value, { state: nextState });
}

watch(
  () => state.lastSavedPullRequest.value,
  async (saved) => {
    if (
      saved?.instanceId === instanceId.value &&
      saved.owner === owner.value &&
      saved.repo === repo.value &&
      saved.index === index.value
    ) {
      try {
        await deletePendingAttachments();
        state.loadPullRequestDetail(instanceId.value, owner.value, repo.value, index.value, true);
        pendingDeleteAttachmentIds.value = [];
        isEditing.value = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.errors.set(editFormKey.value, t('dashboard.form.error', { message }));
      }
    }
  },
);

function handleOpenDiff(filename: string, status: string) {
  const baseSha = detail.value?.base?.sha;
  const headSha = detail.value?.head?.sha;
  if (!baseSha || !headSha) {
    return;
  }
  state.openPullRequestDiff(instanceId.value, owner.value, repo.value, index.value, filename, status, baseSha, headSha);
}

function handleOpenSelectedDiffs(selectedFiles: { filename: string; status: string }[]) {
  const baseSha = detail.value?.base?.sha;
  const headSha = detail.value?.head?.sha;
  if (!baseSha || !headSha || selectedFiles.length === 0) {
    return;
  }
  state.openSelectedPullRequestDiffs(
    instanceId.value,
    owner.value,
    repo.value,
    index.value,
    selectedFiles,
    baseSha,
    headSha,
  );
}

function handleCommitOpenDiff(payload: { filename: string; status: string; baseSha: string; headSha: string }) {
  state.openPullRequestDiff(
    instanceId.value,
    owner.value,
    repo.value,
    index.value,
    payload.filename,
    payload.status,
    payload.baseSha,
    payload.headSha,
  );
}

function handleCommitOpenSelectedDiffs(payload: {
  files: { filename: string; status: string }[];
  baseSha: string;
  headSha: string;
}) {
  if (payload.files.length === 0) {
    return;
  }
  state.openSelectedPullRequestDiffs(
    instanceId.value,
    owner.value,
    repo.value,
    index.value,
    payload.files,
    payload.baseSha,
    payload.headSha,
  );
}

const worktreeLoading = ref(false);
const worktreeStatus = ref('');
const worktreeStatusType = ref<'idle' | 'success' | 'error'>('idle');

const renderedBody = ref('');
const bodyLoading = ref(false);
const bodyError = ref('');

async function renderBody() {
  renderedBody.value = '';
  bodyError.value = '';
  if (!detail.value?.body) {
    return;
  }
  bodyLoading.value = true;
  try {
    const context = `${owner.value}/${repo.value}`;
    renderedBody.value = await state.renderMarkdown(instanceId.value, detail.value.body, context);
  } catch (error) {
    bodyError.value = error instanceof Error ? error.message : String(error);
  } finally {
    bodyLoading.value = false;
  }
}

watch(
  () => detail.value?.body,
  () => {
    renderBody();
  },
  { immediate: true },
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

function labelStyle(color?: string): string {
  if (!color) {
    return '';
  }
  return `background-color: #${color}; color: ${isLightColor(color) ? '#000' : '#fff'};`;
}

function isLightColor(hex: string): boolean {
  const normalized = hex.replace('#', '');
  const r = parseInt(normalized.substring(0, 2), 16);
  const g = parseInt(normalized.substring(2, 4), 16);
  const b = parseInt(normalized.substring(4, 6), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 128;
}

function prStateClass(state?: string, merged?: boolean): string {
  if (merged) {
    return 'state-merged';
  }
  if (state === 'closed') {
    return 'state-closed';
  }
  return 'state-open';
}

function prStateText(state?: string, merged?: boolean): string {
  if (merged) {
    return 'merged';
  }
  return state ?? 'open';
}

const hasWorktree = computed(() =>
  state.worktrees.value.some(
    (w) =>
      w.instanceId === instanceId.value &&
      w.owner === owner.value &&
      w.repo === repo.value &&
      w.prIndex === index.value,
  ),
);

function setWorktreeStatus(message: string, type: 'idle' | 'success' | 'error' = 'idle') {
  worktreeStatus.value = message;
  worktreeStatusType.value = type;
}

function openInWorktree() {
  worktreeLoading.value = true;
  setWorktreeStatus(t('dashboard.worktree.opening'), 'idle');
  state.openPrWorktree(instanceId.value, owner.value, repo.value, index.value);
}

watch(
  () => state.worktrees.value,
  () => {
    if (worktreeLoading.value) {
      worktreeLoading.value = false;
      setWorktreeStatus(t('dashboard.worktree.opened'), 'success');
    }
  },
  { deep: true },
);

watch(
  () => state.lastWorktreeCancelled.value,
  (cancelled) => {
    if (
      cancelled?.instanceId === instanceId.value &&
      cancelled.owner === owner.value &&
      cancelled.repo === repo.value &&
      cancelled.index === index.value
    ) {
      worktreeLoading.value = false;
      worktreeStatus.value = '';
      worktreeStatusType.value = 'idle';
    }
  },
);

watch(
  () => state.errors,
  () => {
    // No global error hook for worktree errors yet; status is updated via separate mechanism if needed.
  },
  { deep: true },
);
</script>

<template>
  <div class="pr-detail">
    <div v-if="loading" class="loading">
      <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
    </div>
    <div v-else-if="error" class="error">{{ t('dashboard.error', { message: error }) }}</div>
    <div v-else-if="detail" class="detail-content">
      <div class="detail-header">
        <h2 class="detail-title">
          <span class="detail-number">#{{ detail.number }}</span>
          {{ detail.title }}
        </h2>
        <span class="state-badge" :class="prStateClass(detail.state, detail.merged)">
          {{ prStateText(detail.state, detail.merged) }}
        </span>
      </div>

      <div class="detail-meta">
        <img
          v-if="detail.user?.avatar_url"
          :src="detail.user.avatar_url"
          :alt="detail.user.login"
          class="user-avatar"
        />
        <span v-if="detail.user" class="user-name">{{ detail.user.login }}</span>
        <span v-if="detail.created_at" class="meta-item">{{ formatDate(detail.created_at) }}</span>
        <span v-if="detail.merged_at" class="meta-item">
          {{ t('dashboard.detail.mergedAt') }} {{ formatDate(detail.merged_at) }}
        </span>
      </div>

      <div v-if="detail.base || detail.head" class="detail-section">
        <h3>{{ t('dashboard.detail.branches') }}</h3>
        <div class="branch-info">
          <span class="branch-tag">{{ t('dashboard.detail.base') }}: {{ detail.base?.ref ?? '-' }}</span>
          <span class="branch-arrow">←</span>
          <span class="branch-tag">{{ t('dashboard.detail.head') }}: {{ detail.head?.ref ?? '-' }}</span>
        </div>
      </div>

      <div v-if="detail.additions !== undefined || detail.deletions !== undefined" class="detail-section">
        <h3>{{ t('dashboard.detail.changes') }}</h3>
        <div class="change-stats">
          <span class="additions">+{{ detail.additions ?? 0 }} {{ t('dashboard.detail.additions') }}</span>
          <span class="deletions">−{{ detail.deletions ?? 0 }} {{ t('dashboard.detail.deletions') }}</span>
          <span v-if="detail.changed_files" class="files">
            {{ detail.changed_files }} {{ t('dashboard.detail.changedFiles') }}
          </span>
        </div>
      </div>

      <div class="detail-section">
        <h3>{{ t('dashboard.detail.changedFilesTitle') }}</h3>
        <DiffFileList
          :files="files"
          :loading="filesLoading"
          :error="filesError"
          :supports-multi-diff="state.supportsMultiDiff.value"
          @open-diff="handleOpenDiff"
          @open-selected-diffs="handleOpenSelectedDiffs"
        />
      </div>

      <div class="detail-section">
        <h3>{{ t('dashboard.detail.commits') }}</h3>
        <div v-if="commitsLoading" class="loading">
          <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
        </div>
        <div v-else-if="commitsError" class="error">{{ t('dashboard.error', { message: commitsError }) }}</div>
        <CommitDiffList
          v-else
          :commits="commits"
          :supports-multi-diff="state.supportsMultiDiff.value"
          @open-diff="handleCommitOpenDiff"
          @open-selected-diffs="handleCommitOpenSelectedDiffs"
        />
      </div>

      <div class="detail-section">
        <h3>{{ t('dashboard.detail.body') }}</h3>
        <MarkdownBody
          :html="renderedBody"
          :loading="bodyLoading"
          :error="bodyError"
          :base-url="baseUrl"
          @open-external="state.openExternal($event)"
        />
      </div>

      <AttachmentList :assets="detail.assets" @open-external="state.openExternal($event)" />

      <div v-if="detail.merged_by" class="detail-section">
        <h3>{{ t('dashboard.detail.mergedBy') }}</h3>
        <div class="detail-meta">
          <img
            v-if="detail.merged_by?.avatar_url"
            :src="detail.merged_by.avatar_url"
            :alt="detail.merged_by.login"
            class="user-avatar"
          />
          <span class="user-name">{{ detail.merged_by.login }}</span>
        </div>
      </div>

      <div v-if="detail.labels?.length" class="detail-section">
        <h3>{{ t('dashboard.detail.labels') }}</h3>
        <div class="label-list">
          <span
            v-for="label in detail.labels"
            :key="label.name ?? ''"
            class="label-tag"
            :style="labelStyle(label.color)"
          >
            {{ label.name }}
          </span>
        </div>
      </div>

      <div v-if="detail.milestone" class="detail-section">
        <h3>{{ t('dashboard.detail.milestone') }}</h3>
        <span class="milestone-tag">{{ detail.milestone.title }}</span>
      </div>

      <div class="detail-section">
        <h3>{{ t('dashboard.detail.commentsAndTimeline') }}</h3>
        <div v-if="commentsLoading" class="loading">
          <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
        </div>
        <div v-else-if="commentsError" class="error">{{ t('dashboard.error', { message: commentsError }) }}</div>
        <CommentTimeline
          v-else
          :comments="comments"
          :instance-id="instanceId"
          :owner="owner"
          :repo="repo"
          :index="index"
          :base-url="baseUrl"
        />

        <div class="comment-form">
          <EasyMdeEditor
            v-model="commentBody"
            :placeholder="t('dashboard.detail.addCommentPlaceholder')"
            :disabled="commentLoading"
            :upload-image="handleCommentImageUpload"
          />
          <AttachmentList
            :assets="[]"
            :allow-upload="true"
            :allow-delete="false"
            :uploading="uploadingCommentAttachmentCount > 0"
            @upload="handleCommentAttachmentUpload($event)"
          />
          <ul v-if="pendingCommentAttachments.length > 0" class="pending-attachment-list">
            <li
              v-for="(file, idx) in pendingCommentAttachments"
              :key="`${file.name}-${idx}`"
              class="pending-attachment-item"
            >
              <span class="pending-attachment-name">{{ file.name }}</span>
              <button type="button" class="pending-attachment-remove" @click="pendingCommentAttachments.splice(idx, 1)">
                {{ t('dashboard.remove') }}
              </button>
            </li>
          </ul>
          <div class="comment-form-actions">
            <vscode-button
              :disabled="!commentBody.trim() || commentLoading || uploadingCommentAttachmentCount > 0"
              @click="handleCommentSubmit"
            >
              {{
                commentLoading || uploadingCommentAttachmentCount > 0
                  ? t('dashboard.form.saving')
                  : t('dashboard.detail.postComment')
              }}
            </vscode-button>
          </div>
          <div v-if="commentError" class="error">{{ t('dashboard.error', { message: commentError }) }}</div>
        </div>
      </div>

      <div class="actions">
        <a href="#" class="action-link" @click.prevent="state.openExternal(prUrl)">
          {{ t('dashboard.detail.openPullRequest') }}
        </a>
        <a href="#" class="action-link" @click.prevent="state.copyToClipboard(prUrl)">
          {{ t('dashboard.detail.copyLink') }}
        </a>
        <a v-if="canManagePullRequest" href="#" class="action-link" @click.prevent="openEdit">
          {{ t('dashboard.actions.edit') }}
        </a>
        <a v-if="canManagePullRequest" href="#" class="action-link" @click.prevent="toggleState">
          {{ detail.state === 'open' ? t('dashboard.actions.close') : t('dashboard.actions.reopen') }}
        </a>
        <a href="#" class="action-link" :class="{ disabled: worktreeLoading }" @click.prevent="openInWorktree">
          {{
            worktreeLoading
              ? t('dashboard.worktree.opening')
              : hasWorktree
                ? t('dashboard.worktree.openExisting')
                : t('dashboard.worktree.openInWorktree')
          }}
        </a>
      </div>

      <div v-if="canMerge" class="merge-section">
        <h3>{{ t('dashboard.detail.mergePullRequest') }}</h3>
        <div class="merge-form">
          <vscode-select v-model="mergeStrategy">
            <vscode-option value="merge">{{ t('dashboard.detail.mergeStrategy.merge') }}</vscode-option>
            <vscode-option value="squash">{{ t('dashboard.detail.mergeStrategy.squash') }}</vscode-option>
            <vscode-option value="rebase">{{ t('dashboard.detail.mergeStrategy.rebase') }}</vscode-option>
          </vscode-select>
          <vscode-button :disabled="mergeLoading" @click="handleMerge">
            {{ mergeLoading ? t('dashboard.detail.merging') : t('dashboard.detail.merge') }}
          </vscode-button>
        </div>
        <div v-if="mergeError" class="error">{{ t('dashboard.error', { message: mergeError }) }}</div>
      </div>

      <div v-if="worktreeStatus" :class="['worktree-status', worktreeStatusType]">{{ worktreeStatus }}</div>

      <ModalDialog
        :open="isEditing"
        :title="t('dashboard.form.editPullRequest')"
        :loading="formLoading"
        @close="closeEdit"
      >
        <PullRequestForm
          :initial-title="detail.title"
          :initial-body="detail.body"
          :initial-base="detail.base?.ref"
          :initial-head="detail.head?.ref"
          :branches="branches"
          :submit-label="t('dashboard.form.save')"
          :loading="formLoading"
          :error="editError"
          :upload-image="handleUploadImage"
          @submit="handleEditSubmit"
          @cancel="closeEdit"
        >
          <template #extra>
            <AttachmentList
              :assets="detail.assets"
              :allow-upload="true"
              :allow-delete="true"
              :uploading="uploadingAttachmentCount > 0"
              :deleting-id="deletingAttachmentId"
              :pending-delete-ids="pendingDeleteAttachmentIds"
              @open-external="state.openExternal($event)"
              @upload="handleAttachmentUpload"
              @delete="handleAttachmentDelete"
            />
          </template>
        </PullRequestForm>
      </ModalDialog>
    </div>
  </div>
</template>

<style scoped>
.pr-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  overflow: auto;
}

.loading {
  color: var(--vscode-descriptionForeground);
}

.error {
  color: var(--vscode-testing-iconFailed);
}

.detail-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.detail-title {
  margin: 0;
  font-size: 1.1rem;
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-number {
  color: var(--vscode-descriptionForeground);
  font-weight: 400;
}

.state-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.8em;
  font-weight: 600;
  text-transform: capitalize;
}

.state-open {
  background-color: var(--vscode-gitDecoration-untrackedResourceForeground, #28a745);
  color: #fff;
}

.state-closed {
  background-color: var(--vscode-gitDecoration-deletedResourceForeground, #d73a49);
  color: #fff;
}

.state-merged {
  background-color: var(--vscode-gitDecoration-addedResourceForeground, #8957e5);
  color: #fff;
}

.detail-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
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

.meta-item {
  color: var(--vscode-descriptionForeground);
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.detail-section h3 {
  margin: 0;
  font-size: 0.95rem;
  color: var(--vscode-foreground);
}

.branch-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.branch-tag {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.85em;
}

.branch-arrow {
  color: var(--vscode-descriptionForeground);
}

.change-stats {
  display: flex;
  gap: 12px;
  font-size: 0.9em;
}

.additions {
  color: var(--vscode-gitDecoration-addedResourceForeground, #28a745);
}

.deletions {
  color: var(--vscode-gitDecoration-deletedResourceForeground, #d73a49);
}

.files {
  color: var(--vscode-descriptionForeground);
}

.label-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.label-tag {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.8em;
}

.milestone-tag {
  display: inline-block;
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.85em;
}

.body-content {
  white-space: pre-wrap;
  font-family: var(--vscode-editor-font-family), monospace;
  font-size: 0.9em;
  line-height: 1.5;
  padding: 12px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
  color: var(--vscode-foreground);
}

.detail-section .markdown-content {
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  padding: 12px;
  border-radius: 4px;
}

.detail-section .markdown-loading,
.detail-section .markdown-empty,
.detail-section .markdown-error {
  padding: 12px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 8px;
}

.action-link {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  font-size: 0.9em;
  white-space: nowrap;
}

.action-link:hover {
  text-decoration: underline;
}

.action-link.disabled {
  color: var(--vscode-descriptionForeground);
  pointer-events: none;
  text-decoration: none;
}

.worktree-status {
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 0.9em;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.worktree-status.success {
  color: var(--vscode-testing-iconPassed);
}

.worktree-status.error {
  color: var(--vscode-testing-iconFailed);
}

.detail-loading-ring {
  width: 16px;
  height: 16px;
  vertical-align: middle;
}

.comment-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.comment-form-actions {
  display: flex;
  justify-content: flex-end;
}

.merge-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.merge-section h3 {
  margin: 0;
  font-size: 0.95rem;
  color: var(--vscode-foreground);
}

.merge-form {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.pending-attachment-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pending-attachment-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
}

.pending-attachment-name {
  font-size: 0.9em;
  color: var(--vscode-foreground);
}

.pending-attachment-remove {
  background-color: transparent;
  color: var(--vscode-errorForeground);
  border: 1px solid var(--vscode-errorForeground);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 0.8em;
  cursor: pointer;
}

.pending-attachment-remove:hover {
  background-color: var(--vscode-errorForeground);
  color: var(--vscode-button-foreground);
}
</style>
