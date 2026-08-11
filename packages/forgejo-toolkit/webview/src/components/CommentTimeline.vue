<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import MarkdownBody from './MarkdownBody.vue';
import AttachmentList from './AttachmentList.vue';
import ModalDialog from './ModalDialog.vue';
import EasyMdeEditor from './EasyMdeEditor.vue';
import ReactionBar from './ReactionBar.vue';
import type { ForgejoTimelineComment, ForgejoIssueAttachment } from '../types/api';
import { useAppState, issueCommentEditFormKey, commentReactionsKey } from '../composables/useAppState';

const { t } = useI18n();
const state = useAppState();

interface Props {
  comments: ForgejoTimelineComment[];
  instanceId: string;
  owner: string;
  repo: string;
  index: number;
  baseUrl?: string;
}

const props = defineProps<Props>();
const renderedBodies = reactive<Record<string, string>>({});
const loadingIds = ref<Set<string>>(new Set());
const uploadingCommentCount = ref(0);
const uploadErrors = reactive<Record<number, string>>({});
const editingComment = ref<ForgejoTimelineComment | undefined>(undefined);
const editBody = ref('');
const pendingDeleteAttachmentIds = ref<number[]>([]);
const deletingAttachmentIds = ref<Set<number>>(new Set());
const isSavingEdit = ref(false);

const currentUsername = computed(() => {
  return state.instances.value.find((i) => i.id === props.instanceId)?.username;
});

const editFormKey = computed(() => {
  if (editingComment.value?.id === undefined) {
    return '';
  }
  return issueCommentEditFormKey(props.instanceId, props.owner, props.repo, editingComment.value.id);
});
const editLoading = computed(() => (editFormKey.value ? (state.loading.get(editFormKey.value) ?? false) : false));
const editError = computed(() => (editFormKey.value ? state.errors.get(editFormKey.value) : undefined));

function commentKey(comment: ForgejoTimelineComment): string {
  return String(comment.id ?? `${comment.type ?? 'event'}-${comment.created_at ?? ''}-${comment.user?.login ?? ''}`);
}

async function renderComment(comment: ForgejoTimelineComment) {
  const key = commentKey(comment);
  if (renderedBodies[key] || !comment.body) {
    return;
  }
  loadingIds.value.add(key);
  try {
    const html = await state.renderMarkdown(props.instanceId, comment.body);
    renderedBodies[key] = html;
  } catch {
    renderedBodies[key] = comment.body;
  } finally {
    loadingIds.value.delete(key);
  }
}

watch(
  () => props.comments,
  (comments) => {
    for (const comment of comments) {
      if (comment.type === 'comment' && comment.body) {
        renderComment(comment);
      }
      if (comment.type === 'comment' && comment.id !== undefined) {
        state.loadCommentReactions(props.instanceId, props.owner, props.repo, comment.id);
      }
    }
  },
  { immediate: true, deep: true },
);

function getCommentReactionsKey(comment: ForgejoTimelineComment): string {
  if (comment.id === undefined) {
    return '';
  }
  return commentReactionsKey(props.instanceId, props.owner, props.repo, comment.id);
}

function getCommentReactions(comment: ForgejoTimelineComment) {
  const key = getCommentReactionsKey(comment);
  return key ? (state.commentReactions.value.get(key) ?? []) : [];
}

function getCommentReactionsLoading(comment: ForgejoTimelineComment) {
  const key = getCommentReactionsKey(comment);
  return key ? (state.loading.get(key) ?? false) : false;
}

function handleCommentReactionToggle(comment: ForgejoTimelineComment, content: string, add: boolean) {
  if (comment.id === undefined) {
    return;
  }
  state.changeCommentReaction(props.instanceId, props.owner, props.repo, comment.id, content, add);
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

function eventText(comment: ForgejoTimelineComment): string {
  const key = `dashboard.detail.timelineEvent.${comment.type ?? 'unknown'}`;
  const translated = t(key);
  if (translated !== key) {
    return translated;
  }
  return comment.type ?? 'event';
}

async function uploadAttachment(comment: ForgejoTimelineComment, file: File) {
  const commentId = comment.id;
  if (commentId === undefined) {
    return;
  }
  uploadingCommentCount.value += 1;
  delete uploadErrors[commentId];
  try {
    await state.uploadIssueCommentAttachment(props.instanceId, props.owner, props.repo, props.index, commentId, file);
  } catch (error) {
    uploadErrors[commentId] = error instanceof Error ? error.message : String(error);
  } finally {
    uploadingCommentCount.value -= 1;
  }
}

const sortOrder = ref<'asc' | 'desc'>('asc');

const sortedComments = computed(() => {
  const list = [...props.comments];
  list.sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return sortOrder.value === 'asc' ? ta - tb : tb - ta;
  });
  return list;
});

function toggleSortOrder() {
  sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
}

const menuRefs = ref<Map<number, HTMLElement>>(new Map());

function openExternal(url: string) {
  state.openExternal(url);
}

function isOwnComment(comment: ForgejoTimelineComment): boolean {
  return comment.user?.login === currentUsername.value && comment.id !== undefined;
}

function setMenuRef(comment: ForgejoTimelineComment, el: unknown) {
  if (comment.id !== undefined && el) {
    menuRefs.value.set(comment.id, el as HTMLElement);
  }
}

function openMenu(comment: ForgejoTimelineComment, event: MouseEvent) {
  const menu = comment.id !== undefined ? menuRefs.value.get(comment.id) : undefined;
  if (!menu) {
    return;
  }
  const menuEl = menu as HTMLElement & { data?: unknown[]; show?: boolean };
  menuEl.data = [
    { label: t('dashboard.actions.edit'), value: 'edit' },
    { label: t('dashboard.actions.delete'), value: 'delete' },
  ];
  const rect = (event.target as HTMLElement).getBoundingClientRect();
  menuEl.style.position = 'fixed';
  menuEl.style.left = `${rect.left}px`;
  menuEl.style.top = `${rect.bottom + 4}px`;
  menuEl.style.zIndex = '1000';
  menuEl.show = true;
}

function handleMenuSelect(event: Event, comment: ForgejoTimelineComment) {
  const value = (event as CustomEvent<{ value: string }>).detail.value;
  if (value === 'edit') {
    openEdit(comment);
  } else if (value === 'delete' && comment.id !== undefined) {
    state.deleteIssueComment(props.instanceId, props.owner, props.repo, comment.id);
  }
}

function openEdit(comment: ForgejoTimelineComment) {
  editingComment.value = comment;
  editBody.value = comment.body ?? '';
  pendingDeleteAttachmentIds.value = [];
}

function closeEdit() {
  editingComment.value = undefined;
  editBody.value = '';
  pendingDeleteAttachmentIds.value = [];
  isSavingEdit.value = false;
}

async function saveEdit() {
  const commentId = editingComment.value?.id;
  if (commentId === undefined) {
    return;
  }
  isSavingEdit.value = true;
  state.editIssueComment(props.instanceId, props.owner, props.repo, commentId, editBody.value.trim());
}

watch(
  () => editLoading.value,
  async (next, prev) => {
    if (!prev || next || !isSavingEdit.value) {
      return;
    }
    if (editError.value) {
      isSavingEdit.value = false;
      return;
    }
    const commentId = editingComment.value?.id;
    if (commentId === undefined) {
      closeEdit();
      return;
    }
    const idsToDelete = [...pendingDeleteAttachmentIds.value];
    if (idsToDelete.length > 0) {
      for (const attachmentId of idsToDelete) {
        deletingAttachmentIds.value.add(attachmentId);
      }
      try {
        await Promise.all(
          idsToDelete.map((attachmentId) =>
            state
              .deleteIssueCommentAttachment(props.instanceId, props.owner, props.repo, commentId, attachmentId)
              .finally(() => deletingAttachmentIds.value.delete(attachmentId)),
          ),
        );
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to delete comment attachments', error);
      }
    }
    closeEdit();
  },
);

async function uploadAttachmentForEdit(file: File): Promise<ForgejoIssueAttachment | undefined> {
  const commentId = editingComment.value?.id;
  if (commentId === undefined) {
    return undefined;
  }
  uploadingCommentCount.value += 1;
  delete uploadErrors[commentId];
  try {
    const attachment = await state.uploadIssueCommentAttachment(
      props.instanceId,
      props.owner,
      props.repo,
      props.index,
      commentId,
      file,
    );
    if (editingComment.value && attachment) {
      editingComment.value.assets = [...(editingComment.value.assets ?? []), attachment];
    }
    return attachment;
  } catch (error) {
    uploadErrors[commentId] = error instanceof Error ? error.message : String(error);
    return undefined;
  } finally {
    uploadingCommentCount.value -= 1;
  }
}

async function handleUploadImageForEdit(
  file: File,
  onSuccess: (url: string) => void,
  onError: (error: string) => void,
) {
  try {
    const attachment = await uploadAttachmentForEdit(file);
    const url = attachment?.uuid ? `/attachments/${attachment.uuid}` : (attachment?.browser_download_url ?? '');
    if (!url) {
      onError('Failed to upload image');
      return;
    }
    onSuccess(url);
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }
}

function markAttachmentForDelete(asset: ForgejoIssueAttachment) {
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
</script>

<template>
  <div class="comment-timeline">
    <div v-if="comments.length > 0" class="timeline-sort">
      <vscode-button variant="secondary" icon="sort-precedence" @click="toggleSortOrder">
        {{ sortOrder === 'asc' ? t('dashboard.detail.sortOldestFirst') : t('dashboard.detail.sortNewestFirst') }}
      </vscode-button>
    </div>
    <div v-if="comments.length === 0" class="empty">{{ t('dashboard.detail.noComments') }}</div>
    <div v-for="comment in sortedComments" :key="commentKey(comment)" class="timeline-item">
      <div class="timeline-header">
        <img
          v-if="comment.user?.avatar_url"
          :src="comment.user.avatar_url"
          :alt="comment.user.login"
          class="user-avatar"
        />
        <vscode-icon
          v-else-if="comment.user"
          name="account"
          class="user-avatar avatar-fallback"
          :title="comment.user.login"
        />
        <span v-if="comment.user" class="user-name">{{ comment.user.login }}</span>
        <span class="event-type">{{ eventText(comment) }}</span>
        <span v-if="comment.created_at" class="meta-item">{{ formatDate(comment.created_at) }}</span>
        <div v-if="isOwnComment(comment)" class="comment-menu-wrapper">
          <vscode-icon
            name="kebab-vertical"
            size="16"
            action-icon
            :title="t('dashboard.actions.more')"
            :aria-label="t('dashboard.actions.more')"
            @click="openMenu(comment, $event)"
          />
          <vscode-context-menu
            :ref="(el: unknown) => setMenuRef(comment, el)"
            @vsc-context-menu-select="handleMenuSelect($event, comment)"
          />
        </div>
      </div>
      <div v-if="comment.type === 'comment'" class="comment-body">
        <div v-if="loadingIds.has(commentKey(comment))" class="loading">{{ t('dashboard.detail.renderingBody') }}</div>
        <MarkdownBody
          v-else
          :html="renderedBodies[commentKey(comment)] ?? ''"
          :base-url="props.baseUrl"
          @open-external="state.openExternal($event)"
        />
      </div>
      <div v-else-if="comment.ref_commit_sha || comment.ref_comment" class="event-detail">
        <span v-if="comment.ref_commit_sha" class="commit-ref">{{ comment.ref_commit_sha.slice(0, 7) }}</span>
        <span v-else-if="comment.ref_comment" class="comment-ref">#{{ comment.ref_comment.id }}</span>
      </div>
      <div
        v-if="comment.type === 'comment' && comment.id !== undefined && comment.assets?.length"
        class="comment-attachments"
      >
        <AttachmentList
          :assets="comment.assets"
          :allow-upload="false"
          :allow-delete="false"
          :show-header="false"
          @open-external="openExternal"
        />
      </div>
      <ReactionBar
        v-if="comment.type === 'comment' && comment.id !== undefined"
        class="comment-reactions"
        :reactions="getCommentReactions(comment)"
        :current-username="currentUsername"
        :loading="getCommentReactionsLoading(comment)"
        @toggle="(content, add) => handleCommentReactionToggle(comment, content, add)"
      />
    </div>

    <ModalDialog
      :open="editingComment !== undefined"
      :title="t('dashboard.detail.editComment')"
      :loading="editLoading"
      @close="closeEdit"
    >
      <div class="edit-comment-form">
        <EasyMdeEditor
          v-model="editBody"
          :placeholder="t('dashboard.detail.addCommentPlaceholder')"
          :disabled="editLoading"
          :upload-image="handleUploadImageForEdit"
        />
        <div v-if="editingComment?.id !== undefined" class="edit-comment-attachments">
          <AttachmentList
            :assets="editingComment.assets"
            :allow-upload="true"
            :allow-delete="true"
            :uploading="uploadingCommentCount > 0"
            :pending-delete-ids="pendingDeleteAttachmentIds"
            :deleting-ids="Array.from(deletingAttachmentIds)"
            @open-external="openExternal"
            @upload="uploadAttachmentForEdit($event)"
            @delete="markAttachmentForDelete($event)"
          />
          <div v-if="uploadErrors[editingComment.id]" class="upload-error">{{ uploadErrors[editingComment.id] }}</div>
        </div>
        <div v-if="editError" class="error">{{ t('dashboard.error', { message: editError }) }}</div>
        <div class="edit-comment-actions">
          <vscode-button :disabled="editLoading" @click="saveEdit">
            {{ editLoading ? t('dashboard.form.saving') : t('dashboard.form.save') }}
          </vscode-button>
          <vscode-button secondary :disabled="editLoading" @click="closeEdit">
            {{ t('dashboard.form.cancel') }}
          </vscode-button>
        </div>
      </div>
    </ModalDialog>
  </div>
</template>

<style scoped>
.comment-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.timeline-sort {
  display: flex;
  justify-content: flex-end;
}

.empty {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.timeline-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
}

.timeline-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.85em;
}

.user-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}

.user-avatar.avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.user-name {
  color: var(--vscode-foreground);
  font-weight: 500;
}

.event-type {
  color: var(--vscode-descriptionForeground);
}

.meta-item {
  color: var(--vscode-descriptionForeground);
}

.comment-body {
  font-size: 0.95em;
}

.loading {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.event-detail {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.commit-ref,
.comment-ref {
  font-family: var(--vscode-editor-font-family), monospace;
}

.comment-attachments {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--vscode-panel-border);
}

.upload-error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.85em;
  margin-top: 4px;
}

.comment-menu-wrapper {
  margin-left: auto;
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}

.comment-menu-wrapper vscode-icon {
  cursor: pointer;
  opacity: 0.7;
}

.comment-menu-wrapper vscode-icon:hover {
  opacity: 1;
}

.comment-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.action-link {
  background: transparent;
  border: none;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  font-size: 0.85em;
  padding: 0;
}

.action-link:hover {
  text-decoration: underline;
}

.edit-comment-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.edit-comment-attachments {
  padding-top: 8px;
  border-top: 1px solid var(--vscode-panel-border);
}

.edit-comment-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.comment-reactions {
  margin-top: 8px;
}

.error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
}
</style>
