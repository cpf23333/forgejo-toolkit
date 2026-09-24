<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { isListTruncated } from '@cpf23333-forgejo-toolkit/shared/limits';
import { useI18n } from 'vue-i18n';
import MarkdownBody from './MarkdownBody.vue';
import AttachmentList from './AttachmentList.vue';
import ModalDialog from './ModalDialog.vue';
import EasyMdeEditor from './EasyMdeEditor.vue';
import ReactionBar from './ReactionBar.vue';
import IconActionButton from './IconActionButton.vue';
import type { ForgejoTimelineComment, ForgejoIssueAttachment } from '../types/api';
import {
  useAppState,
  issueCommentEditFormKey,
  issueCommentDeleteFormKey,
  commentReactionsKey,
} from '../composables/useAppState';
import { attachmentDeleteNoticeFor } from '../utils/attachmentDeleteNotice';
import { createPendingUploads } from '../utils/pendingUploads';

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
// Body each rendered HTML was produced from: a comment keeps its id across
// edits, so the cache must re-render when the body changes.
const renderedBodySources = reactive<Record<string, string>>({});
// Rows whose markdown render failed, with the body that failed and the host's
// reason. A failure must not be recorded as a successful render of that source
// (nor be shown as the rendered form): the row says the formatting failed and
// shows the body as written, and a Retry (or the next refresh) asks again.
const renderFailures = reactive<Record<string, { source: string; message: string }>>({});
// Rows whose markdown has been queued or is being rendered. The render queue
// only runs MAX_MARKDOWN_RENDERS_IN_FLIGHT renders at a time, so a row waiting
// for a slot has no HTML yet and must show the loading placeholder: feeding an
// empty body to MarkdownBody would claim the comment has no description.
const pendingRenderIds = ref<Set<string>>(new Set());
const uploadingCommentCount = ref(0);
const uploadErrors = reactive<Record<number, string>>({});
const editingComment = ref<ForgejoTimelineComment | undefined>(undefined);
const editBody = ref('');
const editDirty = computed(
  () => editingComment.value !== undefined && editBody.value !== (editingComment.value.body ?? ''),
);
// The host caps a paged list at LIST_ITEM_LIMIT and reports no total, so the list
// says it may be incomplete instead of looking complete.
const listTruncated = computed(() => isListTruncated(props.comments));
const pendingDeleteAttachmentIds = ref<number[]>([]);
const deletingAttachmentIds = ref<Set<number>>(new Set());
const isSavingEdit = ref(false);
// Images still uploading from the comment editor. The editor inserts
// `![image](url)` into the body only when the upload returns, so a save issued
// meanwhile would send a body that predates the image (see
// handleUploadImageForEdit and the save handler below).
const pendingEditUploads = createPendingUploads();
const isAwaitingEditUploads = ref(false);
// Feedback for attachments that survived the comment edit: the host asks for a
// confirmation per attachment, so a declined one must not vanish silently.
const attachmentDeleteNotice = ref<string | undefined>(undefined);

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
// Every reason the edit form is busy: the save request itself, the attachment
// list's own uploads, and the uploads a save is waiting for.
const editBusy = computed(() => editLoading.value || uploadingCommentCount.value > 0 || isAwaitingEditUploads.value);
// The busy state that blocks closing the dialog: a submit already on its way
// (the save request, or a save waiting for the uploads it must include). Only
// this is passed to ModalDialog as `loading`, which hides the X and swallows
// Esc. A mere image upload used to be included, so the dialog could not be
// closed at all until the request timed out (up to 60 s).
const editSubmitting = computed(() => editLoading.value || isSavingEdit.value || isAwaitingEditUploads.value);
// An upload in flight is unsaved work too - its markdown is inserted into the
// body only when it answers - so closing while one runs asks for the same
// confirmation as closing with an edited body (see requestEditClose).
const editUploadsInFlight = computed(() => uploadingCommentCount.value > 0);
const editCloseNeedsConfirm = computed(() => editDirty.value || editUploadsInFlight.value);

function commentKey(comment: ForgejoTimelineComment): string {
  return String(comment.id ?? `${comment.type ?? 'event'}-${comment.created_at ?? ''}-${comment.user?.login ?? ''}`);
}

async function renderComment(comment: ForgejoTimelineComment) {
  const key = commentKey(comment);
  if (!comment.body) {
    return;
  }
  if (renderedBodies[key] && renderedBodySources[key] === comment.body) {
    return;
  }
  try {
    // The repository is part of the render: `#123`, `@user` and relative links in
    // a comment resolve against the repository it was written in, which is what
    // every other render site passes (`IssueDetail`, `PullRequestDetail`,
    // `EasyMdeEditor`). Without it those references stayed plain text, and —
    // because the render cache is keyed by the context too — two repositories'
    // identical comment text shared one rendered entry.
    const html = await state.renderMarkdown(props.instanceId, comment.body, `${props.owner}/${props.repo}`);
    renderedBodies[key] = html;
    // Only here is the source recorded as rendered. Recording it from `finally`
    // (as this used to, together with storing the body itself as the HTML) made
    // the "already rendered" tests above pass for a *failed* render, so the row
    // showed raw markdown with no error line for the rest of the session: a
    // refresh re-sends the same bodies, the stale cache still matched, and only
    // a remount cleared it.
    renderedBodySources[key] = comment.body;
    delete renderFailures[key];
  } catch (error) {
    // Not presented as the rendered form, and not cached as one: the row shows
    // the failure notice and the body as written (see the template). Nothing
    // records this source as rendered, so `requestCommentData` queues it again
    // whenever the timeline changes - the next refresh, and the next "show more"
    // as well as the row's own Retry button (see retryCommentRender).
    delete renderedBodies[key];
    delete renderedBodySources[key];
    renderFailures[key] = {
      source: comment.body,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The failure reason for a row, or undefined while it is rendering or rendered.
 *
 * Matched on the body: a comment keeps its id across edits, and the notice of a
 * previous body must not label the new one as failed before its render returns.
 */
function renderFailureFor(comment: ForgejoTimelineComment): { source: string; message: string } | undefined {
  const failure = renderFailures[commentKey(comment)];
  return failure && comment.body !== undefined && failure.source === comment.body ? failure : undefined;
}

/**
 * Re-queues one row's markdown render after a failure. The failure record is
 * dropped first so the row leaves the failed state behind; it is restored with
 * the new reason if this attempt fails too. Nothing needs clearing beyond that:
 * a failed render is not cached as a rendered source (see renderComment), and
 * the host's own markdown cache only ever holds successes.
 */
function retryCommentRender(comment: ForgejoTimelineComment) {
  const key = commentKey(comment);
  delete renderFailures[key];
  if (pendingRenderIds.value.has(key)) {
    return;
  }
  pendingRenderIds.value.add(key);
  queuedCommentRenders.push(comment);
  pumpCommentRenders();
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

// A busy pull request can carry MAX_ITEMS timeline entries; firing one markdown
// request (and one reaction request) per comment in a single tick would hammer
// the host. At most this many markdown renders are in flight; the rest wait for
// a slot, so the host sees a trickle instead of a burst while every comment
// still gets rendered. A row waiting for a slot shows the loading placeholder
// (see pendingRenderIds) instead of an empty body.
const COMMENT_RENDER_BATCH = 25;
const MAX_MARKDOWN_RENDERS_IN_FLIGHT = 4;
let markdownRendersInFlight = 0;
const queuedCommentRenders: ForgejoTimelineComment[] = [];

// How many entries of the timeline are rendered. A full page of MAX_ITEMS
// comments would otherwise mount a markdown body per entry in one render; the
// remainder is revealed a batch at a time so nothing becomes unreachable.
const visibleCommentCount = ref(COMMENT_RENDER_BATCH);
const visibleComments = computed(() => sortedComments.value.slice(0, visibleCommentCount.value));
/**
 * The rows the render queue has been filled for, as one string. The queue has to
 * follow what is actually rendered, not a pair of dependencies that only
 * approximates it: `toggleSortOrder` re-slices `visibleComments` without changing
 * either `props.comments` or `visibleCommentCount`, so a watcher on those two
 * never fired after a sort flip and every row the flip brought into the window
 * had no rendered body — it showed the "No description provided." empty state for
 * a comment that has one until the props changed or "Show more" was pressed.
 */
const visibleCommentRenderKeys = computed(() =>
  visibleComments.value.map((comment) => commentKey(comment)).join('\u0000'),
);
const hiddenCommentCount = computed(() => Math.max(0, sortedComments.value.length - visibleCommentCount.value));
const nextCommentBatchCount = computed(() => Math.min(COMMENT_RENDER_BATCH, hiddenCommentCount.value));

function toggleSortOrder() {
  sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
}

function showMoreComments() {
  visibleCommentCount.value += COMMENT_RENDER_BATCH;
}

function pumpCommentRenders() {
  while (markdownRendersInFlight < MAX_MARKDOWN_RENDERS_IN_FLIGHT && queuedCommentRenders.length > 0) {
    const comment = queuedCommentRenders.shift()!;
    markdownRendersInFlight += 1;
    void renderComment(comment).finally(() => {
      pendingRenderIds.value.delete(commentKey(comment));
      markdownRendersInFlight = Math.max(0, markdownRendersInFlight - 1);
      pumpCommentRenders();
    });
  }
}

/**
 * Queues the markdown render and the reaction fetch of the comments currently
 * in the render window. `loadCommentReactions` applies the same idea for the
 * reaction requests, so the host receives a bounded number of calls per tick.
 */
function requestCommentData(comments: ForgejoTimelineComment[]) {
  for (const comment of comments) {
    if (comment.id !== undefined) {
      state.loadCommentReactions(props.instanceId, props.owner, props.repo, comment.id);
    }
    const key = commentKey(comment);
    if (!comment.body) {
      continue;
    }
    if (renderedBodies[key] && renderedBodySources[key] === comment.body) {
      continue;
    }
    const queued = queuedCommentRenders.findIndex((candidate) => commentKey(candidate) === key);
    if (queued >= 0) {
      // The body changed while the row was still waiting for a render slot:
      // keep it pending, but render the newer body when its turn comes.
      queuedCommentRenders[queued] = comment;
      continue;
    }
    if (pendingRenderIds.value.has(key)) {
      // Already queued or being rendered.
      continue;
    }
    pendingRenderIds.value.add(key);
    queuedCommentRenders.push(comment);
  }
  pumpCommentRenders();
}

// Re-runs when the timeline arrives, when a body is edited in place, and when
// the set of rendered rows changes — the render window growing *or a sort flip
// re-slicing it*. The rows themselves are read from the computed, so what is
// queued follows what is rendered rather than a pair of dependencies that only
// approximates it. Each run queues only what the visible rows still need, and
// never more than MAX_MARKDOWN_RENDERS_IN_FLIGHT renders at once.
watch(
  [() => props.comments, visibleCommentRenderKeys],
  () => {
    requestCommentData(visibleComments.value);
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

interface PushEventData {
  is_force_push?: boolean;
  commit_ids?: string[];
}

function getPushEvent(comment: ForgejoTimelineComment): PushEventData | undefined {
  if (comment.type !== 'pull_push' || !comment.body) {
    return undefined;
  }
  try {
    return JSON.parse(comment.body) as PushEventData;
  } catch {
    return undefined;
  }
}

function commitUrl(sha: string): string {
  const base = props.baseUrl?.replace(/\/$/, '') ?? '';
  return `${base}/${props.owner}/${props.repo}/commit/${sha}`;
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

const menuRefs = ref<Map<number, HTMLElement>>(new Map());

function openExternal(url: string) {
  state.openExternal(url);
}

function isOwnComment(comment: ForgejoTimelineComment): boolean {
  return comment.user?.login === currentUsername.value && comment.id !== undefined;
}

/**
 * A rejected delete (403/404/offline) leaves the comment on screen: the host
 * answers with an error and it is stored under the comment's delete-form key
 * (see handleIssueCommentDeleted). The row has to show it, or the comment just
 * refuses to disappear with no reason given.
 */
function commentDeleteError(comment: ForgejoTimelineComment): string | undefined {
  if (comment.id === undefined) {
    return undefined;
  }
  return state.errors.get(issueCommentDeleteFormKey(props.instanceId, props.owner, props.repo, comment.id));
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
  attachmentDeleteNotice.value = undefined;
}

function closeEdit() {
  editingComment.value = undefined;
  editBody.value = '';
  pendingDeleteAttachmentIds.value = [];
  isSavingEdit.value = false;
}

/**
 * Closes the edit dialog on the user's explicit request (the Cancel button).
 *
 * Cancel is a discard path exactly like Esc and ×, so it asks the same question
 * over the same state: `editCloseNeedsConfirm` covers both the edited body and an
 * image upload in flight (whose markdown is inserted into the body only when it
 * answers). Confirming only the upload left a typed, unsaved body to disappear
 * without a word - the modal's own Esc/× guard already reported itself dirty
 * through `is-dirty`, so only Cancel was inconsistent. The dialog is deliberately
 * not left in ModalDialog's `loading` state for an upload: `loading` hides the X
 * and swallows Esc, which left the user with no way to close the dialog until the
 * request timed out. Only a submit already on its way (`editSubmitting`) blocks
 * closing, and a late upload reply after a close is dropped by
 * `handleUploadImageForEdit`, which checks that the editor still holds the
 * comment the upload was started from.
 */
async function requestEditClose() {
  if (editCloseNeedsConfirm.value && !(await state.showConfirm(t('common.discardChangesConfirm')))) {
    return;
  }
  closeEdit();
}

async function saveEdit() {
  // The editor inserts the uploaded image's markdown from the upload's success
  // callback, so a save that reads the body first would store a comment without
  // the image the user had just inserted. The button is disabled meanwhile, but
  // a save that still gets through must wait for the uploads.
  if (pendingEditUploads.isPending()) {
    isAwaitingEditUploads.value = true;
    try {
      await pendingEditUploads.waitForIdle();
    } finally {
      isAwaitingEditUploads.value = false;
    }
  }
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
      // A declined confirmation resolves to false and a failure rejects; both
      // leave the attachment in place, so collect them instead of dropping the
      // edit form without a word (previously the results were ignored).
      let declined = 0;
      let failed = 0;
      const results = await Promise.allSettled(
        idsToDelete.map((attachmentId) =>
          state
            .deleteIssueCommentAttachment(props.instanceId, props.owner, props.repo, commentId, attachmentId)
            .finally(() => deletingAttachmentIds.value.delete(attachmentId)),
        ),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          failed += 1;
        } else if (!result.value) {
          declined += 1;
        }
      }
      const notice = attachmentDeleteNoticeFor({ declined, failed });
      attachmentDeleteNotice.value = notice ? t(`dashboard.detail.${notice.key}`, { count: notice.count }) : undefined;
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
  // Registered like the editor's own upload: a save issued while this request
  // runs must wait for it, or it would close the form on a comment that does
  // not list the attachment the user just added (see saveEdit).
  const upload = pendingEditUploads.begin();
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
    if (attachment) {
      appendAttachmentToComment(commentId, attachment);
    }
    return attachment;
  } catch (error) {
    uploadErrors[commentId] = error instanceof Error ? error.message : String(error);
    return undefined;
  } finally {
    // Released after the list above has been updated: a save waiting for this
    // upload must see the attachment it added.
    pendingEditUploads.end(upload);
    uploadingCommentCount.value -= 1;
  }
}

/**
 * Adds `attachment` to `commentId`'s attachment list - the comment the upload
 * was started from, which is not necessarily the one the edit form is showing
 * now: the form is a single shared editor, so the user can have moved on to
 * another comment while the request was in flight. Writing to whatever
 * `editingComment` holds then would list the upload under the wrong comment.
 */
function appendAttachmentToComment(commentId: number, attachment: ForgejoIssueAttachment) {
  const targets = new Set<ForgejoTimelineComment>();
  const inTimeline = props.comments.find((comment) => comment.id === commentId);
  if (inTimeline) {
    targets.add(inTimeline);
  }
  if (editingComment.value?.id === commentId) {
    targets.add(editingComment.value);
  }
  for (const comment of targets) {
    comment.assets = [...(comment.assets ?? []), attachment];
  }
}

async function handleUploadImageForEdit(
  file: File,
  onSuccess: (url: string) => void,
  onError: (error: string) => void,
) {
  // The comment this upload belongs to. The editor itself is shared by every
  // comment's form, so its `onSuccess` inserts into whichever body it holds when
  // the request returns.
  const commentId = editingComment.value?.id;
  // Registered so a save issued while the upload runs waits for it (the editor
  // inserts the image markdown from `onSuccess`, so saving first would store a
  // body without it — see saveEdit).
  const upload = pendingEditUploads.begin();
  try {
    const attachment = await uploadAttachmentForEdit(file);
    const url = attachment?.uuid ? `/attachments/${attachment.uuid}` : (attachment?.browser_download_url ?? '');
    if (!url) {
      // `uploadAttachmentForEdit` already recorded the host's reason for the
      // per-comment notice. Reporting `common.imageUploadFailed` here as well
      // made the editor say "Image upload failed: Failed to upload image" next
      // to that notice's real cause: the same failure twice, one of the two
      // messages saying nothing. The editor's line is the one next to the image
      // picker (and the only report the attachment-list path does not produce),
      // so the real reason goes there and the duplicate notice is dropped.
      const reason = commentId === undefined ? undefined : uploadErrors[commentId];
      if (commentId !== undefined) {
        delete uploadErrors[commentId];
      }
      onError(reason || t('common.imageUploadFailed'));
      return;
    }
    // The user opened another comment's form while the upload was in flight:
    // the shared editor now holds that body, so inserting here would write this
    // comment's image markdown into the other one. The attachment is already
    // listed on the comment the upload was started from.
    if (editingComment.value?.id !== commentId) {
      return;
    }
    onSuccess(url);
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  } finally {
    // The editor inserts the markdown inside `onSuccess`, so the upload stays
    // pending until that has run.
    pendingEditUploads.end(upload);
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
  <div v-if="listTruncated" class="list-truncated">
    {{ t('dashboard.detail.commentsTruncated') }}
  </div>
  <div class="comment-timeline">
    <div v-if="attachmentDeleteNotice" class="timeline-notice">
      {{ attachmentDeleteNotice }}
    </div>
    <div v-if="comments.length > 0" class="timeline-sort">
      <vscode-button secondary icon="sort-precedence" @click="toggleSortOrder">
        {{ sortOrder === 'asc' ? t('dashboard.detail.sortOldestFirst') : t('dashboard.detail.sortNewestFirst') }}
      </vscode-button>
    </div>
    <div v-if="comments.length === 0" class="empty">{{ t('dashboard.detail.noComments') }}</div>
    <div v-for="comment in visibleComments" :key="commentKey(comment)" class="timeline-item">
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
        <div v-if="isOwnComment(comment) && comment.type === 'comment'" class="comment-menu-wrapper">
          <IconActionButton
            name="kebab-vertical"
            :label="t('dashboard.actions.more')"
            @click="openMenu(comment, $event)"
          />
          <vscode-context-menu
            :ref="(el: unknown) => setMenuRef(comment, el)"
            @vsc-context-menu-select="handleMenuSelect($event, comment)"
          />
        </div>
      </div>
      <div v-if="commentDeleteError(comment)" class="error comment-delete-error">
        {{ t('dashboard.error', { message: commentDeleteError(comment) }) }}
      </div>
      <div v-if="comment.type === 'pull_push'" class="push-event">
        <div v-if="getPushEvent(comment)?.is_force_push" class="force-push-badge">
          {{ t('dashboard.detail.forcePushed') }}
        </div>
        <div v-if="getPushEvent(comment)?.commit_ids?.length" class="push-commits">
          <a
            v-for="sha in getPushEvent(comment)?.commit_ids"
            :key="sha"
            class="commit-link"
            href="javascript:void(0)"
            @click.prevent.stop="openExternal(commitUrl(sha))"
          >
            {{ sha.slice(0, 7) }}
          </a>
        </div>
      </div>
      <div v-else-if="comment.body" class="comment-body">
        <div v-if="pendingRenderIds.has(commentKey(comment))" class="loading">
          {{ t('dashboard.detail.renderingBody') }}
        </div>
        <!-- A failed render is not the rendered body: saying nothing (or showing
             the raw markdown as if it were the result) hid the failure, and the
             row stayed like that for the session. The body is shown as written,
             labelled, with a Retry that re-requests the render. -->
        <div v-else-if="renderFailureFor(comment)" class="comment-body-render-failed">
          <div class="render-failed-notice">
            <vscode-icon name="warning" />
            <span>{{
              t('dashboard.detail.markdownRenderFailed', { message: renderFailureFor(comment)?.message })
            }}</span>
            <vscode-button secondary @click="retryCommentRender(comment)">{{ t('dashboard.retry') }}</vscode-button>
          </div>
          <pre class="render-failed-source">{{ comment.body }}</pre>
        </div>
        <MarkdownBody
          v-else
          :html="renderedBodies[commentKey(comment)] ?? ''"
          :base-url="props.baseUrl"
          :instance-id="props.instanceId"
          @open-external="state.openExternal($event)"
        />
      </div>
      <div v-else-if="comment.ref_commit_sha || comment.ref_comment" class="event-detail">
        <span v-if="comment.ref_commit_sha" class="commit-ref">{{ comment.ref_commit_sha.slice(0, 7) }}</span>
        <span v-else-if="comment.ref_comment" class="comment-ref">#{{ comment.ref_comment.id }}</span>
      </div>
      <!-- The attachment lookup for this comment failed, so the empty list is not
           an answer: saying nothing read as "this comment has no attachments"
           and the user concluded their attachment had been deleted. -->
      <div v-if="comment.attachmentsUnavailable" class="comment-attachments comment-attachments-unavailable">
        <vscode-icon name="warning" />
        <span>{{ t('dashboard.detail.attachmentsUnavailable') }}</span>
      </div>
      <div v-else-if="comment.id !== undefined && comment.assets?.length" class="comment-attachments">
        <AttachmentList
          :assets="comment.assets"
          :allow-upload="false"
          :allow-delete="false"
          :show-header="false"
          @open-external="openExternal"
        />
      </div>
      <ReactionBar
        v-if="comment.id !== undefined"
        class="comment-reactions"
        :reactions="getCommentReactions(comment)"
        :current-username="currentUsername"
        :loading="getCommentReactionsLoading(comment)"
        @toggle="(content, add) => handleCommentReactionToggle(comment, content, add)"
      />
    </div>

    <div v-if="hiddenCommentCount > 0" class="timeline-more">
      <vscode-button secondary icon="chevron-down" @click="showMoreComments">
        {{ t('dashboard.detail.showMoreComments', { count: nextCommentBatchCount }) }}
      </vscode-button>
    </div>

    <ModalDialog
      :open="editingComment !== undefined"
      :title="t('dashboard.detail.editComment')"
      :loading="editSubmitting"
      :confirm-close-if-dirty="true"
      :is-dirty="editCloseNeedsConfirm"
      @close="closeEdit"
    >
      <div class="edit-comment-form">
        <EasyMdeEditor
          :key="editingComment?.id ?? 'new-comment'"
          v-model="editBody"
          :placeholder="t('dashboard.detail.addCommentPlaceholder')"
          :disabled="editLoading"
          :upload-image="handleUploadImageForEdit"
          :instance-id="props.instanceId"
          :owner="props.owner"
          :repo="props.repo"
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
          <vscode-button :disabled="editBusy" @click="saveEdit">
            {{ editBusy ? t('dashboard.form.saving') : t('dashboard.form.save') }}
          </vscode-button>
          <!-- Not `editBusy`: an upload in flight must not trap the user in the
               dialog. Closing then asks for confirmation (see requestEditClose);
               only a submit already on its way disables Cancel. -->
          <vscode-button secondary :disabled="editSubmitting" @click="requestEditClose">
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

/* Neutral feedback (e.g. an attachment that survived a declined confirmation):
   informative, not an error. */
.timeline-notice {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.empty {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.timeline-more {
  display: flex;
  justify-content: center;
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

.comment-body-render-failed {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.render-failed-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85em;
  color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
}

.render-failed-source {
  margin: 0;
  padding: 8px;
  font-family: inherit;
  font-size: 0.9em;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background-color: var(--vscode-textCodeBlock-background, var(--vscode-editor-inactiveSelectionBackground));
  color: var(--vscode-foreground);
}

.loading {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.event-detail {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.push-event {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.9em;
}

.force-push-badge {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.85em;
}

.push-commits {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.commit-link {
  color: var(--vscode-textLink-foreground);
  font-family: var(--vscode-editor-font-family), monospace;
  font-size: 0.85em;
  text-decoration: none;
}

.commit-link:hover {
  text-decoration: underline;
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

.comment-attachments-unavailable {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
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

.comment-menu-wrapper .icon-action-button {
  opacity: 0.7;
}

.comment-menu-wrapper .icon-action-button:hover {
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
