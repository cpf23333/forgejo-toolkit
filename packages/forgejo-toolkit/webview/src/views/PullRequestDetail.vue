<script setup lang="ts">
import { computed, onActivated, onDeactivated, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import MarkdownBody from '../components/MarkdownBody.vue';
import AttachmentList from '../components/AttachmentList.vue';
import PendingAttachmentList from '../components/PendingAttachmentList.vue';
import DiffFileList from '../components/DiffFileList.vue';
import CommentTimeline from '../components/CommentTimeline.vue';
import CommitDiffList from '../components/CommitDiffList.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PullRequestForm from '../components/PullRequestForm.vue';
import EasyMdeEditor from '../components/EasyMdeEditor.vue';
import { stateLabel } from '../utils/stateLabel';
import { functionalInstanceBase } from '../utils/instanceUrl';
import { attachmentDeleteNoticeFor } from '../utils/attachmentDeleteNotice';
import { uploadFilesKeepingFailures } from '../utils/uploadFilesKeepingFailures';
import { createPendingUploads } from '../utils/pendingUploads';
import { isListTruncated } from '@cpf23333-forgejo-toolkit/shared/limits';
import ReactionBar from '../components/ReactionBar.vue';
import { CollapsibleSection } from '../vscode-controls';
import DateTimePicker from '../components/DateTimePicker.vue';
import {
  useAppState,
  pullRequestDetailKey,
  pullRequestFilesKey,
  pullRequestCommentsKey,
  pullRequestCommitsKey,
  pullRequestFormKey,
  pullRequestStateKey,
  pullRequestDueDateKey,
  pullRequestMergeFormKey,
  issueCommentFormKey,
  repoDetailKey,
  repoLabelsKey,
  repoAssigneesKey,
  repoMilestonesKey,
  repoIssuesKey,
  issueSubscriptionKey,
  issueTrackedTimesKey,
  userStopwatchesKey,
  issueDependenciesKey,
  issueReactionsKey,
} from '../composables/useAppState';
import { canDeleteTrackedTime, findStopwatchElsewhere, isTrackedTimeTotal } from '../utils/trackedTime';
import type { ForgejoIssueAttachment, MergeBlocker } from '../types/api';

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
// The functional base URL, not the display one: it feeds the markdown
// renderer's relative-URL resolution (`sanitizeMarkdownHtml`) and the commit
// links `CommentTimeline` builds, and a base carrying the credential mask
// (`https://***@host/`) produces links that resolve to a dead host.
const baseUrl = computed(() => functionalInstanceBase(state.instances.value.find((i) => i.id === instanceId.value)));
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

const filesKey = computed(() =>
  pullRequestFilesKey(
    instanceId.value,
    owner.value,
    repo.value,
    index.value,
    detail.value?.merge_base ?? detail.value?.base?.sha,
    detail.value?.head?.sha,
  ),
);
const files = computed(() => state.pullRequestFiles.value.get(filesKey.value) ?? []);
const filesError = computed(() => state.errors.get(filesKey.value));
// Keyed on presence, not length: a PR with zero changed files loads
// successfully into an empty array and must not spin forever.
const filesLoading = computed(() => !state.pullRequestFiles.value.has(filesKey.value) && !filesError.value);

const commentsKey = computed(() => pullRequestCommentsKey(instanceId.value, owner.value, repo.value, index.value));
const comments = computed(() => state.pullRequestComments.value.get(commentsKey.value) ?? []);
const commentsError = computed(() => state.errors.get(commentsKey.value));
const commentsLoading = computed(() => !state.pullRequestComments.value.has(commentsKey.value) && !commentsError.value);

const commitsKey = computed(() => pullRequestCommitsKey(instanceId.value, owner.value, repo.value, index.value));
const commits = computed(() => state.pullRequestCommits.value.get(commitsKey.value) ?? []);
const commitsError = computed(() => state.errors.get(commitsKey.value));
const commitsLoading = computed(() => !state.pullRequestCommits.value.has(commitsKey.value) && !commitsError.value);

const labelsKey = computed(() => repoLabelsKey(instanceId.value, owner.value, repo.value));
const assigneesKey = computed(() => repoAssigneesKey(instanceId.value, owner.value, repo.value));
const milestonesKey = computed(() => repoMilestonesKey(instanceId.value, owner.value, repo.value));
const subscriptionKey = computed(() => issueSubscriptionKey(instanceId.value, owner.value, repo.value, index.value));
const trackedTimesKey = computed(() => issueTrackedTimesKey(instanceId.value, owner.value, repo.value, index.value));
const stopwatchesKey = computed(() => userStopwatchesKey(instanceId.value));
const dependenciesKey = computed(() => issueDependenciesKey(instanceId.value, owner.value, repo.value, index.value));
const repoIssuesKeyValue = computed(() => repoIssuesKey(instanceId.value, owner.value, repo.value, 'open'));
const reactionsKey = computed(() => issueReactionsKey(instanceId.value, owner.value, repo.value, index.value));

const labels = computed(() => state.repoLabels.value.get(labelsKey.value) ?? []);
const assignees = computed(() => state.repoAssignees.value.get(assigneesKey.value) ?? []);
const milestones = computed(() => state.repoMilestones.value.get(milestonesKey.value) ?? []);
const subscription = computed(() => state.issueSubscriptions.value.get(subscriptionKey.value));
const subscriptionError = computed(() => state.errors.get(subscriptionKey.value));
const trackedTimes = computed(() => state.issueTrackedTimes.value.get(trackedTimesKey.value) ?? []);
const trackedTimesError = computed(() => state.errors.get(trackedTimesKey.value));
const trackedTimesSaving = computed(() => state.loading.get(trackedTimesKey.value) ?? false);
const stopwatches = computed(() => state.userStopwatches.value.get(stopwatchesKey.value) ?? []);
const isStopwatchRunning = computed(() =>
  stopwatches.value.some(
    (sw) => sw.repo_owner_name === owner.value && sw.repo_name === repo.value && sw.issue_index === index.value,
  ),
);
const canSeeAllTrackedTimes = computed(() =>
  isTrackedTimeTotal(trackedTimes.value, currentUsername.value, isPullRequestAuthor.value),
);
const stopwatchElsewhere = computed(() =>
  findStopwatchElsewhere(stopwatches.value, { owner: owner.value, repo: repo.value, index: index.value }),
);
const stopwatchElsewhereLabel = computed(() => {
  const stopwatch = stopwatchElsewhere.value;
  return stopwatch ? [stopwatch.repo_name, stopwatch.issue_index].filter((part) => part !== undefined).join('#') : '';
});
const dependencies = computed(() => state.issueDependencies.value.get(dependenciesKey.value) ?? []);
// The dependency section had no error branch at all: a failed load rendered "No
// dependencies" (claiming the pull request has none) and a failed add/remove
// rendered nothing, leaving the row the user tried to remove in place with no
// reason. The host sends no toast for either, so the section is where both must
// appear.
const dependenciesError = computed(() => state.errors.get(dependenciesKey.value) ?? '');
/**
 * The dependency number the add is waiting on, kept until the request settles so
 * a failure leaves the pick in place for a retry (see addDependency).
 */
const dependencyPending = ref<number | undefined>(undefined);
const repoIssues = computed(() => state.repoIssues.value.get(repoIssuesKeyValue.value) ?? []);
const repoIssuesLoading = computed(() => state.loading.get(repoIssuesKeyValue.value) ?? false);

// The dependency picker is the only consumer of the repository issue list, and that
// list is paged (one request per 50 issues), so loading it for every opened issue or
// pull request cost ten requests on a busy repository. It loads when the picker is
// first used, and the empty state waits until then.
const repoIssuesFetched = computed(() => state.repoIssuesFetchedAt.has(repoIssuesKeyValue.value));
// The list is capped by the paged endpoint (LIST_ITEM_LIMIT): at the cap some issues
// are missing, which the panel has to say out loud (same notice other lists use).
const repoIssuesTruncated = computed(() => isListTruncated(repoIssues.value));
// The freshness check (TTL + in-flight dedup) lives in the composable, so the
// picker's own `.has()` mark must not gate it: a list fetched once was otherwise
// never refreshed, and a dependency added from the pull request panel never showed up.
function ensureRepoIssuesLoaded() {
  state.loadRepoIssues(instanceId.value, owner.value, repo.value, 'open');
}

const availableDependencies = computed(() =>
  repoIssues.value.filter(
    (issue) => issue.number !== index.value && !dependencies.value.some((dep) => dep.number === issue.number),
  ),
);
const reactions = computed(() => state.issueReactions.value.get(reactionsKey.value) ?? []);
const reactionsLoading = computed(() => state.loading.get(reactionsKey.value) ?? false);
// A failed reaction load or toggle lands on the reactions key and the host sends
// no toast, so the bar is what has to show it (see ReactionBar's `error`).
const reactionsError = computed(() => state.errors.get(reactionsKey.value) ?? '');
const participants = computed(() => {
  const users = new Map<string, { login?: string; avatar_url?: string }>();
  if (detail.value?.user) {
    users.set(detail.value.user.login, detail.value.user);
  }
  for (const user of detail.value?.assignees ?? []) {
    if (user.login) {
      users.set(user.login, user);
    }
  }
  for (const comment of comments.value) {
    if (comment.user?.login) {
      users.set(comment.user.login, comment.user);
    }
  }
  return Array.from(users.values());
});
const prReference = computed(() => {
  const fullName = detail.value?.repository?.full_name ?? `${owner.value}/${repo.value}`;
  return `${fullName}#${detail.value?.number ?? index.value}`;
});

// Under keep-alive this view is deactivated (not unmounted) when navigating
// away; `route.params` then tracks the global route, not this view's own
// route. Guard all route-driven loading on isActive.
const isActive = ref(true);

function loadPullRequestData() {
  state.loadPullRequestDetail(instanceId.value, owner.value, repo.value, index.value);
  state.loadRepoLabels(instanceId.value, owner.value, repo.value);
  state.loadRepoAssignees(instanceId.value, owner.value, repo.value);
  state.loadRepoMilestones(instanceId.value, owner.value, repo.value);
  state.loadIssueSubscription(instanceId.value, owner.value, repo.value, index.value);
  state.loadIssueTrackedTimes(instanceId.value, owner.value, repo.value, index.value);
  state.loadUserStopwatches(instanceId.value);
  state.loadIssueDependencies(instanceId.value, owner.value, repo.value, index.value);
  state.loadIssueReactions(instanceId.value, owner.value, repo.value, index.value);
}

function loadDetailDependentData() {
  if (detail.value) {
    state.loadPullRequestFiles(
      instanceId.value,
      owner.value,
      repo.value,
      index.value,
      detail.value.merge_base ?? detail.value.base?.sha,
      detail.value.head?.sha,
    );
    state.loadPullRequestComments(instanceId.value, owner.value, repo.value, index.value);
    state.loadPullRequestCommits(instanceId.value, owner.value, repo.value, index.value);
  }
}

onActivated(() => {
  isActive.value = true;
  // Params may have changed back before this hook ran; make sure data for the
  // current route is loaded (loaders dedup via their caches).
  loadPullRequestData();
  loadDetailDependentData();
  renderBody();
});
onDeactivated(() => {
  isActive.value = false;
});

watch(
  [instanceId, owner, repo, index],
  () => {
    if (!isActive.value) {
      return;
    }
    loadPullRequestData();
  },
  { immediate: true },
);

watch(
  () => detail.value,
  () => {
    if (!isActive.value) {
      return;
    }
    loadDetailDependentData();
  },
  { immediate: true },
);

const prUrl = computed(() => detail.value?.html_url ?? '');
const isEditing = ref(false);
const editFormDirty = ref(false);
// Remounts the edit form for every edit session. The dialog is a native
// `<dialog>`, so closing it keeps its content mounted and `PullRequestForm` kept
// the abandoned draft: discarding an edit closed the dialog but reopening it
// showed the typed title again — already dirty, so every later close asked for
// the discard confirmation again, and Save re-applied what the user had
// discarded. The sibling composers re-seed the same way (`RepoIssues`'s
// `createFormResetKey`, `CommentTimeline`'s body reset).
const editFormResetKey = ref(0);
// Guards the Cancel path's discard prompt so a double click cannot open two of
// them (see confirmCancelEdit).
let cancelEditConfirmInFlight = false;
const uploadingAttachmentCount = ref(0);
const deletingAttachmentId = ref<number | undefined>(undefined);
const isDeletingAttachments = ref(false);
const pendingDeleteAttachmentIds = ref<number[]>([]);
// Attachments still uploading in the edit dialog (the editor's image picker and
// the attachment list both register here; see handleUploadImage and
// handleAttachmentUpload).
const pendingEditUploads = createPendingUploads();
// The submit handler set the dialog busy to wait for those uploads.
const isAwaitingUploads = ref(false);
// Images still uploading from the edit dialog's editor. `PullRequestForm` tracks
// them for its own submit button, but its `dirty` output only covers the fields -
// unlike `IssueForm`, which counts an in-flight upload. The editor inserts the
// image's markdown into the body only when the request returns, so the dialog
// must ask before closing during one: mirrored here, where the modal's `is-dirty`
// guard is decided.
const uploadingEditImageCount = ref(0);
const editDialogDirty = computed(() => editFormDirty.value || uploadingEditImageCount.value > 0);
// Feedback for attachments that survived the save: the host asks for a
// confirmation per attachment, so a declined one must not disappear silently.
const attachmentDeleteNotice = ref<string | undefined>(undefined);
const editFormKey = computed(() => pullRequestFormKey(instanceId.value, owner.value, repo.value, index.value));
const editLoading = computed(() => state.loading.get(editFormKey.value) ?? false);
const editError = computed(() => state.errors.get(editFormKey.value));
const formLoading = computed(() => editLoading.value || isDeletingAttachments.value || isAwaitingUploads.value);

const commentFormKey = computed(() => issueCommentFormKey(instanceId.value, owner.value, repo.value, index.value));
const commentLoading = computed(() => state.loading.get(commentFormKey.value) ?? false);
const commentError = computed(() => state.errors.get(commentFormKey.value));
const commentBody = ref('');
const pendingCommentAttachments = ref<File[]>([]);
const uploadingCommentAttachmentCount = ref(0);
// Comment this form already posted, with the body it was posted with. A failed
// attachment upload must only retry the uploads, never post the comment twice;
// editing the body afterwards means a new comment is intended.
const createdCommentId = ref<number | undefined>(undefined);
const createdCommentBody = ref<string | undefined>(undefined);
// Images still uploading from the comment editor. The editor inserts
// `![image](url)` into the body only when the upload returns, so a comment
// posted meanwhile would carry a body that predates the image (see
// handleCommentImageUpload and handleCommentSubmit).
const pendingCommentUploads = createPendingUploads();
// Mirrors the tracker so the form can show that the post is waiting on an
// upload instead of appearing to do nothing.
const uploadingCommentImageCount = ref(0);
// True from the click that starts a post until that post has finished,
// including its wait for the editor's in-flight image uploads. The button is
// disabled while it is set, and the handler refuses a re-entrant click as well:
// two submits would both pass the upload wait and post the same body twice.
const commentSubmitting = ref(false);
// The post button's busy state: the post itself (including its wait for the
// editor's image uploads) and the attachment list's own uploads.
const commentFormBusy = computed(
  () => commentSubmitting.value || commentLoading.value || uploadingCommentAttachmentCount.value > 0,
);

const manualTimeHours = ref(0);
const manualTimeMinutes = ref(0);
// Whether the manual form's values are waiting for their request's reply. They
// stay in the form until it succeeds: clearing them on the click throws away
// what the user typed the moment the request fails.
const manualTimePending = ref(false);
const selectedDependencyNumber = ref<number | undefined>(undefined);
const isEditingDueDate = ref(false);
const dueDateValue = ref<string | null>(null);

function handleCommentAttachmentUpload(file: File) {
  pendingCommentAttachments.value.push(file);
}

function removePendingCommentAttachment(index: number) {
  pendingCommentAttachments.value.splice(index, 1);
}

async function handleCommentImageUpload(
  file: File,
  onSuccess: (url: string) => void,
  onError: (error: string) => void,
) {
  const upload = pendingCommentUploads.begin();
  uploadingCommentImageCount.value += 1;
  const settle = () => {
    pendingCommentUploads.end(upload);
    uploadingCommentImageCount.value = Math.max(0, uploadingCommentImageCount.value - 1);
  };
  try {
    const attachment = await state.uploadIssueAttachment(instanceId.value, owner.value, repo.value, index.value, file);
    const url = attachment.uuid ? `/attachments/${attachment.uuid}` : (attachment.browser_download_url ?? '');
    if (!url) {
      onError(t('common.imageUploadFailed'));
      return;
    }
    onSuccess(url);
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  } finally {
    // The editor inserts the markdown inside `onSuccess`, so the upload must
    // stay pending until that has run.
    settle();
  }
}

async function handleCommentSubmit() {
  // A click while this post is still running — waiting for an image upload, or
  // for the comment request itself — must not start a second post: it would
  // pass the same upload wait and submit the same body again.
  if (commentSubmitting.value) {
    return;
  }
  commentSubmitting.value = true;
  try {
    // The uploads insert their markdown into the editor only when their request
    // returns. Waiting for them before reading the body is what keeps a post
    // issued while an image was still uploading from dropping that image.
    if (pendingCommentUploads.isPending()) {
      await pendingCommentUploads.waitForIdle();
    }
    const body = commentBody.value.trim();
    if (!body) {
      return;
    }
    // Capture the target before the first await. Posting the comment and
    // uploading its attachments are separate round-trips, and `route.params`
    // follows the global route: reading it again after an await would attach the
    // files to whatever pull request the user navigated to in the meantime — and
    // would report a later failure on the form of the pull request the user is
    // looking at now instead of the one that was submitted.
    const target = { instanceId: instanceId.value, owner: owner.value, repo: repo.value, index: index.value };
    const formKey = issueCommentFormKey(target.instanceId, target.owner, target.repo, target.index);
    try {
      let commentId = createdCommentId.value;
      // Retry mode: this exact body was already posted and the remaining
      // attachments are still queued. An edited body means a new comment.
      if (commentId === undefined || createdCommentBody.value !== body) {
        commentId = undefined;
      }
      if (commentId === undefined) {
        const comment = await state.createIssueComment(
          target.instanceId,
          target.owner,
          target.repo,
          target.index,
          body,
        );
        if (comment.id === undefined) {
          throw new Error(t('common.commentCreationFailed'));
        }
        commentId = comment.id;
        createdCommentId.value = commentId;
        createdCommentBody.value = body;
      }
      // The comment exists from here on: upload the files that are still pending
      // and keep only the failures queued, so a resubmit adds the missing
      // attachments to that comment instead of posting a duplicate comment.
      const remaining = await uploadFilesKeepingFailures(pendingCommentAttachments.value, async (file) => {
        uploadingCommentAttachmentCount.value += 1;
        try {
          await state.uploadIssueCommentAttachment(
            target.instanceId,
            target.owner,
            target.repo,
            target.index,
            commentId,
            file,
          );
        } finally {
          uploadingCommentAttachmentCount.value -= 1;
        }
      });
      if (remaining.length > 0) {
        pendingCommentAttachments.value = remaining;
        state.errors.set(formKey, t('dashboard.detail.commentAttachmentUploadFailed', { count: remaining.length }));
        return;
      }
      commentBody.value = '';
      pendingCommentAttachments.value = [];
      createdCommentId.value = undefined;
      createdCommentBody.value = undefined;
      // The notice an earlier failed upload left is over: retry mode skips
      // `createIssueComment`, which is what clears this key's error otherwise.
      state.errors.delete(formKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.errors.set(formKey, message);
    }
  } finally {
    commentSubmitting.value = false;
  }
}

const mergeFormKey = computed(() => pullRequestMergeFormKey(instanceId.value, owner.value, repo.value, index.value));
const mergeLoading = computed(() => state.loading.get(mergeFormKey.value) ?? false);
const mergeError = computed(() => state.errors.get(mergeFormKey.value));
const mergeStrategy = ref<'merge' | 'rebase' | 'squash'>('merge');

function onMergeStrategyChange(event: Event) {
  mergeStrategy.value = (event.target as HTMLSelectElement).value as 'merge' | 'rebase' | 'squash';
}

// Destructive commands are confirmed host-side (viewProvider re-prompts
// before executing); the webview must not add its own confirmation.
function handleDeleteTime(timeId: number) {
  state.deleteIssueTime(instanceId.value, owner.value, repo.value, index.value, timeId);
}

const canMerge = computed(() => detail.value?.state === 'open' && !detail.value?.merged && canManagePullRequest.value);
const isMergeable = computed(() => detail.value?.mergeable === true);
const mergeBlockers = computed(() => detail.value?.mergeBlockers ?? []);
const hasMergeBlockers = computed(() => mergeBlockers.value.length > 0);
// The base branch's rules are admin-only upstream: when they could not be read
// the status above cannot claim the PR is ready to merge.
const protectionUnknown = computed(() => detail.value?.protectionUnknown === true);

/**
 * The localized wording for one status-check state.
 *
 * The blocker line used to print the raw Forgejo enum (`failure`, `pending`,
 * ...) while the checks panel one screen above translated the very same values
 * through `dashboard.detail.checksState.*`, so one state read differently
 * depending on where the user looked. A value this webview has no wording for
 * falls back to the neutral `unknown` label instead of the missing key.
 */
function statusStateLabel(state: string): string {
  const key = `dashboard.detail.checksState.${state}`;
  const label = t(key);
  return label === key ? t('dashboard.detail.checksState.unknown') : label;
}

function blockerText(blocker: MergeBlocker): string {
  switch (blocker.type) {
    case 'required_approvals':
      return t('dashboard.detail.mergeableStatus.blocker.required_approvals', {
        count: blocker.requiredApprovals ?? 0,
      });
    case 'required_status_checks': {
      const state = blocker.statusState;
      // The sibling host fix drops this blocker when the status probe failed, so
      // an absent state should not happen. If it still does, say so honestly
      // rather than printing a bare "-" that reads like a real state.
      if (!state) {
        return t('dashboard.detail.mergeableStatus.blocker.required_status_checks_no_state');
      }
      return t('dashboard.detail.mergeableStatus.blocker.required_status_checks', {
        state: statusStateLabel(state),
      });
    }
    default:
      return t(`dashboard.detail.mergeableStatus.blocker.${blocker.type}`);
  }
}

const statusChecks = computed(() => detail.value?.statusChecks);
const hasStatusChecks = computed(() => statusChecks.value !== undefined);

function checkStatusIcon(status?: string): string {
  switch (status) {
    case 'success':
      return 'check';
    case 'pending':
      return 'watch';
    case 'failure':
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'question';
  }
}

function checkStatusClass(status?: string): string {
  return status ?? 'unknown';
}

function handleMerge() {
  if (!canMerge.value) {
    return;
  }
  state.mergePullRequest(instanceId.value, owner.value, repo.value, index.value, mergeStrategy.value);
}

const canRevertMerge = computed(() => detail.value?.merged === true && canManagePullRequest.value);
const revertMergeFormKey = computed(
  () => `revert-merge:${instanceId.value}:${owner.value}/${repo.value}#${index.value}`,
);
const revertMergeLoading = computed(() => state.loading.get(revertMergeFormKey.value) ?? false);
const revertMergeError = computed(() => state.errors.get(revertMergeFormKey.value));

function handleRevertMerge() {
  if (!canRevertMerge.value) {
    return;
  }
  state.revertMergeCommit(instanceId.value, owner.value, repo.value, index.value);
}

const repoKey = computed(() => repoDetailKey(instanceId.value, owner.value, repo.value));
const repoDetail = computed(() => state.repoDetails.value.get(repoKey.value));
const branches = computed(() => repoDetail.value?.branches ?? []);

function openEdit() {
  state.loadRepoDetail(instanceId.value, owner.value, repo.value);
  state.loadPullRequestDetail(instanceId.value, owner.value, repo.value, index.value);
  attachmentDeleteNotice.value = undefined;
  // A new edit session starts with no marked deletions. Clearing them here
  // (rather than on close) is what lets `closeEdit` keep the marks of a save
  // that is already in flight: the save's reply still has to delete them.
  pendingDeleteAttachmentIds.value = [];
  // A new session starts from the stored pull request, not from whatever the
  // last one left in the form (see editFormResetKey).
  editFormResetKey.value += 1;
  editFormDirty.value = false;
  isEditing.value = true;
}

function closeEdit() {
  // The marks deliberately survive closing the dialog: a save whose edit was
  // already dispatched still runs its deletions when the host answers. Clearing
  // them here is what used to make Save-then-Cancel drop the user's marked
  // attachments without reporting anything. `openEdit` clears them for the next
  // session, and the save reply clears them once they were applied.
  isEditing.value = false;
}

/**
 * Cancel routes through the same discard confirmation Esc and × use. The modal
 * asks for them itself (`confirmCloseIfDirty` + `is-dirty`), but the form's
 * Cancel button is its own control: it emitted `close` directly, so a typed,
 * unsaved edit disappeared without a word while the other two exits asked.
 * `RepoRefs.confirmCancelDialog` is the same shape.
 */
async function confirmCancelEdit() {
  if (!editFormDirty.value) {
    closeEdit();
    return;
  }
  // Guards against a second prompt while one is already open (the Cancel button
  // stays enabled behind the native dialog).
  if (cancelEditConfirmInFlight) {
    return;
  }
  cancelEditConfirmInFlight = true;
  try {
    if (await state.showConfirm(t('common.discardChangesConfirm'))) {
      closeEdit();
    }
  } finally {
    cancelEditConfirmInFlight = false;
  }
}

async function handleEditSubmit(data: {
  title: string;
  body: string;
  base?: string;
  assignees: string[];
  labels: number[];
  milestone?: number;
  dueDate?: string;
}) {
  // Capture the target before the first await, like the other handlers.
  const target = { instanceId: instanceId.value, owner: owner.value, repo: repo.value, index: index.value };
  // An upload inserts its markdown into the editor only when its request
  // returns: saving before that would submit a body missing the image the user
  // just inserted. The submit button is disabled meanwhile; this covers a
  // submit that still gets through.
  if (pendingEditUploads.isPending()) {
    isAwaitingUploads.value = true;
    try {
      await pendingEditUploads.waitForIdle();
    } finally {
      isAwaitingUploads.value = false;
    }
  }
  // The dialog may have been cancelled while the uploads were being awaited;
  // dispatching then would land an edit the user already abandoned. The
  // Cancel/X/Esc paths are blocked while the dialog is busy (see `formLoading`),
  // so this covers a close that got through anyway (a programmatic one, or a
  // host-side close).
  if (!isEditing.value) {
    return;
  }
  state.editPullRequest(target.instanceId, target.owner, target.repo, target.index, {
    title: data.title,
    body: data.body,
    base: data.base,
    assignees: data.assignees,
    labels: data.labels,
    milestone: data.milestone,
    dueDate: data.dueDate,
  });
}

/**
 * The detail the upload and attachment-delete handlers must write to: the pull
 * request the form that started them was opened for. `route.params` follows the
 * global route, so the `detail` computed may already be the pull request the
 * user navigated to by the time one of those requests returns.
 */
function detailFor(target: { instanceId: string; owner: string; repo: string; index: number }) {
  return state.pullRequestDetails.value.get(
    pullRequestDetailKey(target.instanceId, target.owner, target.repo, target.index),
  );
}

async function deletePendingAttachments(target: {
  instanceId: string;
  owner: string;
  repo: string;
  index: number;
}): Promise<{ declined: number; failed: number }> {
  const ids = pendingDeleteAttachmentIds.value;
  if (ids.length === 0) {
    return { declined: 0, failed: 0 };
  }
  // The target is passed in, not read from the live route: the deletes are
  // separate round-trips and `route.params` follows the global route, so
  // reading it again would delete the marked attachments of whatever pull
  // request the user navigated to in the meantime — and would drop them from
  // that pull request's local list instead of the one they were deleted from.
  isDeletingAttachments.value = true;
  deletingAttachmentId.value = ids[0];
  try {
    // allSettled: one declined confirmation (resolves false) or one failed
    // delete must not hide the outcome of the others.
    const results = await Promise.allSettled(
      ids.map((id) => state.deleteIssueAttachment(target.instanceId, target.owner, target.repo, target.index, id)),
    );
    // A declined host-side confirmation resolves to false: that attachment
    // still exists, so it must stay in the local list.
    const deletedIds: number[] = [];
    let declined = 0;
    let failed = 0;
    results.forEach((result, position) => {
      if (result.status === 'rejected') {
        failed += 1;
      } else if (result.value) {
        deletedIds.push(ids[position]);
      } else {
        declined += 1;
      }
    });
    const current = detailFor(target);
    if (current?.assets && deletedIds.length > 0) {
      current.assets = current.assets.filter((a) => a.id === undefined || !deletedIds.includes(a.id));
    }
    return { declined, failed };
  } finally {
    isDeletingAttachments.value = false;
    deletingAttachmentId.value = undefined;
  }
}

async function handleUploadImage(file: File, onSuccess: (url: string) => void, onError: (error: string) => void) {
  // Capture the pull request before the await. The file belongs to the pull
  // request the form was opened for, not to whatever the route points at when
  // the upload returns.
  const target = { instanceId: instanceId.value, owner: owner.value, repo: repo.value, index: index.value };
  // Registered so a save issued while this upload runs waits for it.
  const upload = pendingEditUploads.begin();
  uploadingEditImageCount.value += 1;
  try {
    const attachment = await state.uploadIssueAttachment(
      target.instanceId,
      target.owner,
      target.repo,
      target.index,
      file,
    );
    const current = detailFor(target);
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
  } finally {
    // The editor inserts the markdown inside `onSuccess`, so the upload counts as
    // unsaved work until that has run.
    uploadingEditImageCount.value = Math.max(0, uploadingEditImageCount.value - 1);
    pendingEditUploads.end(upload);
  }
}

async function handleAttachmentUpload(file: File) {
  // Same target capture as `handleUploadImage`: the edit dialog's attachment
  // list belongs to the pull request the form was opened for.
  const target = { instanceId: instanceId.value, owner: owner.value, repo: repo.value, index: index.value };
  const upload = pendingEditUploads.begin();
  uploadingAttachmentCount.value += 1;
  try {
    const attachment = await state.uploadIssueAttachment(
      target.instanceId,
      target.owner,
      target.repo,
      target.index,
      file,
    );
    const current = detailFor(target);
    if (current) {
      if (!current.assets) {
        current.assets = [];
      }
      current.assets.push(attachment);
    }
  } catch (error) {
    // Surface the failure in the edit dialog instead of swallowing it.
    const message = error instanceof Error ? error.message : String(error);
    state.errors.set(
      pullRequestFormKey(target.instanceId, target.owner, target.repo, target.index),
      t('dashboard.form.error', { message }),
    );
  } finally {
    uploadingAttachmentCount.value -= 1;
    pendingEditUploads.end(upload);
  }
}

function handleAttachmentDelete(asset: ForgejoIssueAttachment) {
  const attachmentId = asset.id;
  if (attachmentId === undefined) {
    return;
  }
  const idx = pendingDeleteAttachmentIds.value.indexOf(attachmentId);
  if (idx >= 0) {
    pendingDeleteAttachmentIds.value.splice(idx, 1);
  } else {
    pendingDeleteAttachmentIds.value.push(attachmentId);
  }
}

function toggleState() {
  const nextState = detail.value?.state === 'open' ? 'closed' : 'open';
  state.togglePullRequestState(instanceId.value, owner.value, repo.value, index.value, nextState);
}

// Close/reopen reports against its own key: the error renders next to the
// button instead of disappearing into the edit form's key.
const stateToggleKey = computed(() => pullRequestStateKey(instanceId.value, owner.value, repo.value, index.value));
const stateToggleError = computed(() => state.errors.get(stateToggleKey.value));
const stateToggleLoading = computed(() => state.loading.get(stateToggleKey.value) ?? false);

function toggleSubscription() {
  const user = currentUsername.value;
  if (!user) {
    return;
  }
  const subscribe = !subscription.value?.subscribed;
  state.changeIssueSubscription(instanceId.value, owner.value, repo.value, index.value, user, subscribe);
}

// A failed check leaves no payload, so the panel would keep its "Loading..."
// state forever; the error branch of the template takes over instead.
function reloadSubscription() {
  state.loadIssueSubscription(instanceId.value, owner.value, repo.value, index.value, true);
}

function handleIssueReactionToggle(content: string, add: boolean) {
  state.changeIssueReaction(instanceId.value, owner.value, repo.value, index.value, content, add);
}

function addManualTime() {
  const hours = manualTimeHours.value || 0;
  const minutes = manualTimeMinutes.value || 0;
  const seconds = hours * 3600 + minutes * 60;
  if (seconds <= 0) {
    return;
  }
  manualTimePending.value = true;
  state.addIssueTime(instanceId.value, owner.value, repo.value, index.value, seconds);
}

// The form clears only once the server accepted what was typed. A failure keeps
// the values (and shows the error below) so a retry needs no retyping.
watch(trackedTimesSaving, (saving, wasSaving) => {
  if (manualTimePending.value && wasSaving && !saving && !trackedTimesError.value) {
    manualTimePending.value = false;
    manualTimeHours.value = 0;
    manualTimeMinutes.value = 0;
  }
});

function addDependency() {
  const dependencyIndex = selectedDependencyNumber.value;
  if (dependencyIndex === undefined || dependencyIndex <= 0) {
    return;
  }
  // The pick is cleared only once the change has settled and succeeded: the
  // composable reloads the dependency list after a successful change (and a
  // failed one leaves the pick, which the error below explains), so the reloaded
  // payload is the settle signal. The `loading` flag cannot be: it goes straight
  // back to true for the reload, so a watcher on it never sees the settle.
  dependencyPending.value = dependencyIndex;
  state.createIssueDependency(instanceId.value, owner.value, repo.value, index.value, dependencyIndex);
}

watch(dependencies, (list) => {
  if (dependencyPending.value === undefined) {
    return;
  }
  // The list changed while an add was in flight, which only a successful change
  // does (see handleIssueDependencyChanged). A failed change leaves the payload
  // untouched, and its error is what keeps the pick for the retry.
  dependencyPending.value = undefined;
  selectedDependencyNumber.value = undefined;
  void list;
});

// Same as the issue detail view: the host confirms the removal, so a single
// misclick cannot fire it silently, and the webview adds no second prompt.
function handleRemoveDependency(depNumber: number) {
  state.removeIssueDependency(instanceId.value, owner.value, repo.value, index.value, depNumber);
}

function startEditDueDate() {
  dueDateValue.value = detail.value?.due_date ?? null;
  state.errors.delete(dueDateKey.value);
  isEditingDueDate.value = true;
}

function cancelEditDueDate() {
  isEditingDueDate.value = false;
  dueDateValue.value = null;
  state.errors.delete(dueDateKey.value);
}

// Same own-key pattern as stateToggleKey: the inline editor stays open while
// saving, closes on success, and shows failures next to itself.
const dueDateKey = computed(() => pullRequestDueDateKey(instanceId.value, owner.value, repo.value, index.value));
const dueDateError = computed(() => state.errors.get(dueDateKey.value));
const dueDateSaving = computed(() => state.loading.get(dueDateKey.value) ?? false);

watch(dueDateSaving, (saving, wasSaving) => {
  if (wasSaving && !saving && !dueDateError.value) {
    isEditingDueDate.value = false;
    dueDateValue.value = null;
  }
});

function saveDueDate() {
  state.updatePullRequestDueDate(instanceId.value, owner.value, repo.value, index.value, {
    dueDate: dueDateValue.value || undefined,
  });
}

function clearDueDate() {
  state.updatePullRequestDueDate(instanceId.value, owner.value, repo.value, index.value, {
    unsetDueDate: true,
  });
}

// The pull request this view exists for, captured once: under keep-alive a view
// of another pull request stays mounted (cached) while the live route has moved
// on, so its `route.params` no longer describe it — but its own captured target
// still does. The live route is deliberately not consulted: which route is live
// says nothing about which pull request a save reply belongs to.
const ownPullRequestKey = pullRequestDetailKey(instanceId.value, owner.value, repo.value, index.value);

watch(
  () => state.lastSavedPullRequest.value,
  async (saved) => {
    // Only the view that owns the saved pull request may act on its report.
    // Several detail views stay cached under keep-alive and each keeps its own
    // `pendingDeleteAttachmentIds`, while `lastSavedPullRequest` is a single
    // shared slot: without this guard, saving PR B makes every cached view
    // delete *its own* marked attachments against B.
    //
    // Ownership is decided by the reply's target, not by the live route: a save
    // reported after the user navigated away still belongs to the pull request
    // that was saved, and that pull request's view must still clean up its
    // marked attachments. A live view of *another* pull request must not react,
    // and neither must a cached view of another pull request.
    if (!saved) {
      return;
    }
    const target = {
      instanceId: saved.instanceId,
      owner: saved.owner,
      repo: saved.repo,
      index: saved.index,
    };
    const savedKey = pullRequestDetailKey(target.instanceId, target.owner, target.repo, target.index);
    if (savedKey !== ownPullRequestKey) {
      // Being the live route is not ownership: the live view of PR A also
      // renders while PR B is being saved elsewhere, and it must not delete
      // A's marked attachments against B.
      return;
    }
    // The saved pull request itself is the target, not the live route: the host
    // can report a save after the user navigated away, and reading
    // `route.params` again would make a late save drop (and mis-address) the
    // marked attachment deletes of the pull request that was actually saved.
    try {
      const outcome = await deletePendingAttachments(target);
      state.loadPullRequestDetail(target.instanceId, target.owner, target.repo, target.index, true);
      pendingDeleteAttachmentIds.value = [];
      isEditing.value = false;
      // The pull request was saved; tell the user why a marked attachment is
      // still there instead of closing the dialog without a word.
      const notice = attachmentDeleteNoticeFor(outcome);
      attachmentDeleteNotice.value = notice ? t(`dashboard.detail.${notice.key}`, { count: notice.count }) : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.errors.set(
        pullRequestFormKey(target.instanceId, target.owner, target.repo, target.index),
        t('dashboard.form.error', { message }),
      );
    }
  },
);

function handleOpenDiff(filename: string, status: string, previousFilename?: string) {
  const baseSha = detail.value?.merge_base ?? detail.value?.base?.sha;
  const headSha = detail.value?.head?.sha;
  if (!baseSha || !headSha) {
    return;
  }
  state.openPullRequestDiff(
    instanceId.value,
    owner.value,
    repo.value,
    index.value,
    filename,
    status,
    baseSha,
    headSha,
    previousFilename,
  );
}

function handleOpenSelectedDiffs(selectedFiles: { filename: string; status: string; previous_filename?: string }[]) {
  const baseSha = detail.value?.merge_base ?? detail.value?.base?.sha;
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

function handleCommitOpenDiff(payload: {
  filename: string;
  status: string;
  previousFilename?: string;
  baseSha: string;
  headSha: string;
}) {
  state.openPullRequestDiff(
    instanceId.value,
    owner.value,
    repo.value,
    index.value,
    payload.filename,
    payload.status,
    payload.baseSha,
    payload.headSha,
    payload.previousFilename,
  );
}

function handleCommitOpenSelectedDiffs(payload: {
  files: { filename: string; status: string; previous_filename?: string }[];
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
// The PR whose worktree open is in flight, captured when the open starts.
// `route.params` follows the global route, so this view's live params stop
// describing its own PR as soon as the user opens another one — and under
// keep-alive this instance stays mounted (deactivated) while that happens. The
// captured target is what worktree replies are matched against.
const worktreeTarget = ref<{ instanceId: string; owner: string; repo: string; index: number } | undefined>(undefined);

const renderedBody = ref('');
const bodyLoading = ref(false);
const bodyError = ref('');

// Last-request-wins guard: consecutive body changes trigger concurrent
// renderMarkdown calls; only the latest request may write back.
let renderBodyToken = 0;

async function renderBody() {
  const token = ++renderBodyToken;
  renderedBody.value = '';
  bodyError.value = '';
  if (!detail.value?.body) {
    return;
  }
  bodyLoading.value = true;
  try {
    const context = `${owner.value}/${repo.value}`;
    const html = await state.renderMarkdown(instanceId.value, detail.value.body, context);
    if (token === renderBodyToken) {
      renderedBody.value = html;
    }
  } catch (error) {
    if (token === renderBodyToken) {
      bodyError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (token === renderBodyToken) {
      bodyLoading.value = false;
    }
  }
}

watch(
  () => detail.value?.body,
  () => {
    if (!isActive.value) {
      return;
    }
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

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(t('dashboard.detail.durationHours', { count: hours }));
  }
  if (minutes > 0 || (hours > 0 && secs > 0)) {
    parts.push(t('dashboard.detail.durationMinutes', { count: minutes }));
  }
  if (secs > 0 && hours === 0) {
    parts.push(t('dashboard.detail.durationSeconds', { count: secs }));
  }
  return parts.length > 0 ? parts.join(' ') : t('dashboard.detail.durationSeconds', { count: 0 });
}

function formatAbsoluteDate(date: string): string {
  try {
    // Formatted with the UI locale, not the host browser's (see IssueDetail).
    return new Date(date).toLocaleDateString(state.locale.value);
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
    return t('dashboard.state.merged');
  }
  return stateLabel(state, t);
}

const hasWorktree = computed(() =>
  state.worktrees.value.some(
    (w) =>
      (w.kind ?? 'pr') === 'pr' &&
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

/**
 * Whether a worktree reply (opened / cancelled / error) describes the PR this
 * instance is waiting for. While an open is in flight the captured target
 * decides, because the live route may already point at another PR; without a
 * pending open the live route does, so an unrelated reply cannot be mistaken for
 * this view's own.
 */
function isWorktreeReplyForThisView(reply: {
  instanceId?: string;
  owner?: string;
  repo?: string;
  index?: number;
}): boolean {
  const expected = worktreeTarget.value ?? {
    instanceId: instanceId.value,
    owner: owner.value,
    repo: repo.value,
    index: index.value,
  };
  return (
    reply.instanceId === expected.instanceId &&
    reply.owner === expected.owner &&
    reply.repo === expected.repo &&
    reply.index === expected.index
  );
}

/**
 * Ends the wait for a worktree open this instance actually asked for. Only the
 * reply that matches the captured target may clear the flag: `lastWorktreeCancelled`
 * is shared by every cached PR view, so clearing on another view's cancel would
 * stop this one's spinner while its own open is still in flight, and the
 * "opened" reply that follows could no longer report success.
 */
function finishWorktreeWait() {
  worktreeLoading.value = false;
  worktreeTarget.value = undefined;
}

function openInWorktree() {
  worktreeTarget.value = { instanceId: instanceId.value, owner: owner.value, repo: repo.value, index: index.value };
  worktreeLoading.value = true;
  setWorktreeStatus(t('dashboard.worktree.opening'), 'idle');
  state.openPrWorktree(instanceId.value, owner.value, repo.value, index.value);
}

// Watch this PR's worktree entry by reference: the state handler replaces the
// entry object when this PR's worktreeOpened arrives, while unrelated
// worktree list mutations keep the same reference and must not fire.
watch(
  () =>
    state.worktrees.value.find(
      (w) =>
        (w.kind ?? 'pr') === 'pr' &&
        isWorktreeReplyForThisView({
          instanceId: w.instanceId,
          owner: w.owner,
          repo: w.repo,
          index: w.prIndex,
        }),
    ),
  (worktree, previous) => {
    if (worktree && worktree !== previous && worktreeLoading.value) {
      finishWorktreeWait();
      setWorktreeStatus(t('dashboard.worktree.opened'), 'success');
    }
  },
);

watch(
  () => state.lastWorktreeCancelled.value,
  (cancelled) => {
    if (!cancelled || !worktreeLoading.value) {
      return;
    }
    // Declining the host-side confirmation ends the open of the PR the reply
    // names. This instance only stops waiting when that is the PR it asked for:
    // another cached view's cancel must not clear a spinner whose own reply is
    // still on its way (and `finishWorktreeWait` clears on that reply instead).
    if (isWorktreeReplyForThisView(cancelled)) {
      finishWorktreeWait();
      worktreeStatus.value = '';
      worktreeStatusType.value = 'idle';
    }
  },
);

// A failed openPrWorktree (host replied worktreeError) must clear the loading
// state and surface the error, or the button would spin forever. Only this
// view's own error ends its wait; another PR's error is ignored (see the
// cancel watcher), while this view's own reply always matches the captured
// `worktreeTarget` first.
watch(
  () => state.lastWorktreeError.value,
  (worktreeError) => {
    if (worktreeError?.operation !== 'open' || !worktreeLoading.value) {
      return;
    }
    if (!isWorktreeReplyForThisView(worktreeError)) {
      return;
    }
    finishWorktreeWait();
    setWorktreeStatus(worktreeError.error, 'error');
  },
);

function reloadPullRequest() {
  state.loadPullRequestDetail(instanceId.value, owner.value, repo.value, index.value, true);
  state.loadPullRequestComments(instanceId.value, owner.value, repo.value, index.value, true);
}
</script>

<template>
  <div class="pr-detail">
    <div v-if="loading" class="loading-state">
      <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
    </div>
    <div v-else-if="error" class="error-state">
      <span>{{ t('dashboard.error', { message: error }) }}</span>
      <vscode-button icon="refresh" @click="reloadPullRequest" secondary>
        {{ t('dashboard.retry') }}
      </vscode-button>
    </div>
    <div v-else-if="detail" class="detail-content">
      <div class="detail-main">
        <div class="detail-header">
          <h2 class="detail-title">
            <span class="detail-number">#{{ detail.number }}</span>
            {{ detail.title }}
          </h2>
          <div class="header-actions">
            <span class="state-badge" :class="prStateClass(detail.state, detail.merged)">
              {{ prStateText(detail.state, detail.merged) }}
            </span>
            <vscode-button
              icon="link-external"
              :title="t('dashboard.detail.openPullRequest')"
              :aria-label="t('dashboard.detail.openPullRequest')"
              @click="state.openExternal(prUrl)"
              icon-only
            />
            <vscode-button
              icon="copy"
              :title="t('dashboard.detail.copyLink')"
              :aria-label="t('dashboard.detail.copyLink')"
              @click="state.copyToClipboard(prUrl)"
              icon-only
            />
            <template v-if="canManagePullRequest">
              <vscode-button
                icon="edit"
                :title="t('dashboard.actions.edit')"
                :aria-label="t('dashboard.actions.edit')"
                @click="openEdit"
                icon-only
              />
              <vscode-button
                :icon="detail.state === 'open' ? 'close' : 'refresh'"
                :title="detail.state === 'open' ? t('dashboard.actions.close') : t('dashboard.actions.reopen')"
                :aria-label="detail.state === 'open' ? t('dashboard.actions.close') : t('dashboard.actions.reopen')"
                :disabled="stateToggleLoading"
                @click="toggleState"
                icon-only
              />
            </template>
          </div>
        </div>

        <div v-if="stateToggleError" class="state-toggle-error">
          {{ t('dashboard.error', { message: stateToggleError }) }}
        </div>
        <div v-if="attachmentDeleteNotice" class="detail-notice">
          {{ attachmentDeleteNotice }}
        </div>

        <div class="detail-meta">
          <img
            v-if="detail.user?.avatar_url"
            :src="detail.user.avatar_url"
            :alt="detail.user.login"
            class="user-avatar"
          />
          <vscode-icon
            v-else-if="detail.user"
            name="account"
            class="user-avatar avatar-fallback"
            :title="detail.user.login"
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
            :instance-id="instanceId"
            @open-external="state.openExternal($event)"
          />
          <ReactionBar
            class="issue-reactions"
            :reactions="reactions"
            :current-username="currentUsername"
            :loading="reactionsLoading"
            :error="reactionsError"
            @toggle="handleIssueReactionToggle"
          />
        </div>

        <AttachmentList
          :assets="detail.assets"
          :attachments-unavailable="detail.attachmentsUnavailable === true"
          @open-external="state.openExternal($event)"
        />

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
              :instance-id="instanceId"
              :owner="owner"
              :repo="repo"
            />
            <div class="comment-form-attachments">
              <AttachmentList
                :assets="[]"
                :allow-upload="true"
                :allow-delete="false"
                :uploading="uploadingCommentAttachmentCount > 0"
                @upload="handleCommentAttachmentUpload($event)"
              />
              <PendingAttachmentList
                :files="pendingCommentAttachments"
                @remove="removePendingCommentAttachment($event)"
              />
            </div>
            <div class="comment-form-actions">
              <vscode-button :disabled="!commentBody.trim() || commentFormBusy" @click="handleCommentSubmit">
                {{ commentFormBusy ? t('dashboard.form.saving') : t('dashboard.detail.postComment') }}
              </vscode-button>
            </div>
            <div v-if="commentError" class="error">{{ t('dashboard.error', { message: commentError }) }}</div>
          </div>
        </div>

        <div class="actions">
          <button type="button" class="action-link link-button" @click="state.openExternal(prUrl)">
            {{ t('dashboard.detail.openPullRequest') }}
          </button>
          <button type="button" class="action-link link-button" @click="state.copyToClipboard(prUrl)">
            {{ t('dashboard.detail.copyLink') }}
          </button>
          <button
            type="button"
            class="action-link link-button"
            :class="{ disabled: worktreeLoading }"
            :disabled="worktreeLoading"
            @click="openInWorktree"
          >
            {{
              worktreeLoading
                ? t('dashboard.worktree.opening')
                : hasWorktree
                  ? t('dashboard.worktree.openExisting')
                  : t('dashboard.worktree.openInWorktree')
            }}
          </button>
        </div>

        <div v-if="hasStatusChecks" class="checks-section">
          <h3>{{ t('dashboard.detail.checks') }}</h3>
          <div class="checks-summary">
            <vscode-icon
              :class="['check-icon', checkStatusClass(statusChecks?.state)]"
              :name="checkStatusIcon(statusChecks?.state)"
            />
            <span>{{ t(`dashboard.detail.checksState.${statusChecks?.state ?? 'unknown'}`) }}</span>
          </div>
          <div class="checks-list">
            <div v-if="(statusChecks?.statuses.length ?? 0) === 0" class="empty-state">
              {{ t('dashboard.detail.noStatusChecks') }}
            </div>
            <div v-for="check in statusChecks?.statuses" :key="check.id ?? check.context" class="check-item">
              <!-- A raw `:href` fed by the server's `target_url` bypassed the
                   host's http/https allowlist: the click path asked the host to
                   open the URL, but middle-click and "open link" followed the
                   raw scheme. The button is the app's link-styled control and
                   never navigates on its own (see `link-button`). -->
              <button
                v-if="check.target_url"
                type="button"
                class="check-row link-button"
                @click="state.openExternal(check.target_url)"
              >
                <vscode-icon
                  :class="['check-icon', checkStatusClass(check.status)]"
                  :name="checkStatusIcon(check.status)"
                />
                <span class="check-context">{{ check.context }}</span>
              </button>
              <div v-else class="check-row">
                <vscode-icon
                  :class="['check-icon', checkStatusClass(check.status)]"
                  :name="checkStatusIcon(check.status)"
                />
                <span class="check-context">{{ check.context }}</span>
              </div>
              <span v-if="check.description" class="check-description">{{ check.description }}</span>
            </div>
          </div>
        </div>

        <div v-if="canMerge" class="merge-section">
          <h3>{{ t('dashboard.detail.mergePullRequest') }}</h3>
          <div class="merge-status-list">
            <div v-if="!hasMergeBlockers && isMergeable" class="merge-status mergeable">
              <vscode-icon name="check" />
              <span>{{ t('dashboard.detail.mergeableStatus.mergeable') }}</span>
            </div>
            <div
              v-for="(blocker, blockerIndex) in mergeBlockers"
              :key="blockerIndex"
              :class="['merge-status', 'blocked', blocker.type]"
            >
              <vscode-icon :name="blocker.type === 'conflicts' ? 'warning' : 'error'" />
              <span>{{ blockerText(blocker) }}</span>
            </div>
            <div v-if="!hasMergeBlockers && !isMergeable" class="merge-status unknown">
              <vscode-icon name="question" />
              <span>{{ t('dashboard.detail.mergeableStatus.unknown') }}</span>
            </div>
            <div v-if="protectionUnknown" class="merge-status unknown">
              <vscode-icon name="info" />
              <span>{{ t('dashboard.detail.mergeableStatus.protectionUnknown') }}</span>
            </div>
          </div>
          <div class="merge-form">
            <vscode-single-select
              :value="mergeStrategy"
              :label="t('dashboard.detail.merge')"
              @change="onMergeStrategyChange"
            >
              <vscode-option value="merge">{{ t('dashboard.detail.mergeStrategy.merge') }}</vscode-option>
              <vscode-option value="squash">{{ t('dashboard.detail.mergeStrategy.squash') }}</vscode-option>
              <vscode-option value="rebase">{{ t('dashboard.detail.mergeStrategy.rebase') }}</vscode-option>
            </vscode-single-select>
            <vscode-button :disabled="mergeLoading || !isMergeable || hasMergeBlockers" @click="handleMerge">
              {{ mergeLoading ? t('dashboard.detail.merging') : t('dashboard.detail.merge') }}
            </vscode-button>
          </div>
          <div v-if="mergeError" class="error">{{ t('dashboard.error', { message: mergeError }) }}</div>
        </div>

        <div v-if="canRevertMerge" class="merge-section revert-section">
          <h3>{{ t('dashboard.detail.revertMerge') }}</h3>
          <vscode-button
            secondary
            icon="arrow-counter-clockwise"
            :disabled="revertMergeLoading"
            @click="handleRevertMerge"
          >
            {{ revertMergeLoading ? t('dashboard.loading') : t('dashboard.detail.revertMerge') }}
          </vscode-button>
          <div v-if="revertMergeError" class="error">{{ t('dashboard.error', { message: revertMergeError }) }}</div>
        </div>

        <div v-if="worktreeStatus" :class="['worktree-status', worktreeStatusType]">{{ worktreeStatus }}</div>
      </div>

      <div class="detail-sidebar">
        <CollapsibleSection v-if="detail.labels?.length" :title="t('dashboard.detail.labels')">
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
        </CollapsibleSection>

        <CollapsibleSection v-if="detail.milestone" :title="t('dashboard.detail.milestone')">
          <span class="milestone-tag">{{ detail.milestone.title }}</span>
        </CollapsibleSection>

        <CollapsibleSection v-if="detail.assignees?.length" :title="t('dashboard.detail.assignees')">
          <div class="assignee-list">
            <div v-for="user in detail.assignees" :key="user.login" class="assignee-item">
              <img v-if="user.avatar_url" :src="user.avatar_url" :alt="user.login" class="user-avatar-small" />
              <vscode-icon v-else name="account" class="user-avatar-small avatar-fallback" />
              <span class="assignee-name">{{ user.login }}</span>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.dueDate')">
          <div v-if="isEditingDueDate" class="due-date-edit">
            <DateTimePicker
              v-model="dueDateValue"
              type="date"
              :disabled="dueDateSaving"
              :label="t('dashboard.detail.dueDate')"
            />
            <div class="due-date-edit-actions">
              <button
                type="button"
                class="link-button"
                :title="t('dashboard.actions.save')"
                :aria-label="t('dashboard.actions.save')"
                :disabled="dueDateSaving"
                @click="saveDueDate"
              >
                <vscode-icon name="check" />
              </button>
              <button
                type="button"
                class="link-button"
                :title="t('dashboard.actions.cancel')"
                :aria-label="t('dashboard.actions.cancel')"
                @click="cancelEditDueDate"
              >
                <vscode-icon name="close" />
              </button>
            </div>
          </div>
          <div v-else class="due-date-row">
            <template v-if="detail.due_date">
              <vscode-icon name="calendar" />
              <span class="due-date">{{ formatAbsoluteDate(detail.due_date) }}</span>
              <button
                v-if="canManagePullRequest"
                type="button"
                class="link-button"
                :title="t('dashboard.actions.edit')"
                :aria-label="t('dashboard.actions.edit')"
                @click="startEditDueDate"
              >
                <vscode-icon name="edit" />
              </button>
              <button
                v-if="canManagePullRequest"
                type="button"
                class="link-button"
                :title="t('dashboard.actions.delete')"
                :aria-label="t('dashboard.actions.delete')"
                @click="clearDueDate"
              >
                <vscode-icon name="trash" />
              </button>
            </template>
            <template v-else>
              <span class="due-date-empty">{{ t('dashboard.detail.noDueDate') }}</span>
              <button
                v-if="canManagePullRequest"
                type="button"
                class="link-button"
                :title="t('dashboard.actions.set')"
                :aria-label="t('dashboard.actions.set')"
                @click="startEditDueDate"
              >
                <vscode-icon name="edit" />
              </button>
            </template>
          </div>
          <div v-if="dueDateError" class="error state-toggle-error">
            {{ t('dashboard.error', { message: dueDateError }) }}
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.participants', { count: participants.length })">
          <div class="participant-list">
            <template v-for="user in participants" :key="user.login">
              <img
                v-if="user.avatar_url"
                :src="user.avatar_url"
                :alt="user.login"
                class="user-avatar-small"
                :title="user.login"
              />
              <vscode-icon v-else name="account" class="user-avatar-small avatar-fallback" :title="user.login" />
            </template>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.references')">
          <div class="reference-row">
            <span class="reference-text">{{ prReference }}</span>
            <button
              type="button"
              class="link-button"
              :title="t('dashboard.actions.copyUrl')"
              :aria-label="t('dashboard.actions.copyUrl')"
              @click="state.copyToClipboard(prReference)"
            >
              <vscode-icon name="copy" />
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.subscription')">
          <div v-if="subscriptionError" class="subscription-error">
            <span class="error">{{ t('dashboard.error', { message: subscriptionError }) }}</span>
            <vscode-button icon="refresh" @click="reloadSubscription" secondary>
              {{ t('dashboard.retry') }}
            </vscode-button>
          </div>
          <div v-else-if="subscription === undefined" class="loading-inline">{{ t('dashboard.loading') }}</div>
          <div v-else class="subscription-actions">
            <vscode-button
              :icon="subscription.subscribed ? 'bell-slash' : 'bell'"
              @click="toggleSubscription"
              secondary
            >
              {{ subscription.subscribed ? t('dashboard.detail.unsubscribe') : t('dashboard.detail.subscribe') }}
            </vscode-button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.timeTracking')">
          <div class="time-tracking-summary">
            <span class="tracked-time">{{
              formatDuration(trackedTimes.reduce((sum, t) => sum + (t.time ?? 0), 0))
            }}</span>
            <span class="tracked-time-scope">{{
              t(canSeeAllTrackedTimes ? 'dashboard.detail.trackedTimeTotal' : 'dashboard.detail.trackedTimeMine')
            }}</span>
          </div>
          <p v-if="stopwatchElsewhere && !isStopwatchRunning" class="time-tracking-hint">
            {{ t('dashboard.detail.stopwatchRunningElsewhere', { issue: stopwatchElsewhereLabel }) }}
          </p>
          <div v-if="trackedTimesError" class="error time-tracking-error">
            {{ t('dashboard.error', { message: trackedTimesError }) }}
          </div>
          <div class="time-tracking-actions">
            <vscode-button
              v-if="!isStopwatchRunning"
              icon="play"
              @click="state.startIssueStopwatch(instanceId, owner, repo, index)"
              secondary
            >
              {{ t('dashboard.detail.startStopwatch') }}
            </vscode-button>
            <vscode-button
              v-else
              icon="debug-pause"
              @click="state.stopIssueStopwatch(instanceId, owner, repo, index)"
              secondary
            >
              {{ t('dashboard.detail.stopStopwatch') }}
            </vscode-button>
          </div>
          <div class="time-tracking-form">
            <vscode-textfield
              type="number"
              :value="String(manualTimeHours)"
              :min="0"
              :label="t('dashboard.detail.hours')"
              @input="manualTimeHours = Number(($event.target as HTMLInputElement).value)"
            />
            <span>{{ t('dashboard.detail.hours') }}</span>
            <vscode-textfield
              type="number"
              :value="String(manualTimeMinutes)"
              :min="0"
              :max="59"
              :label="t('dashboard.detail.minutes')"
              @input="manualTimeMinutes = Number(($event.target as HTMLInputElement).value)"
            />
            <span>{{ t('dashboard.detail.minutes') }}</span>
            <vscode-button icon="add" @click="addManualTime" secondary>
              {{ t('dashboard.detail.addTime') }}
            </vscode-button>
          </div>
          <div v-if="trackedTimes.length" class="tracked-time-list">
            <div v-for="time in trackedTimes" :key="time.id" class="tracked-time-item">
              <span>{{ formatDuration(time.time ?? 0) }}</span>
              <span v-if="time.user_name" class="tracked-time-user">{{ time.user_name }}</span>
              <button
                v-if="canDeleteTrackedTime(time.user_name, currentUsername)"
                type="button"
                class="link-button"
                :title="t('dashboard.actions.delete')"
                :aria-label="t('dashboard.actions.delete')"
                @click="handleDeleteTime(time.id ?? 0)"
              >
                <vscode-icon name="trash" />
              </button>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.dependencies')">
          <div v-if="dependencies.length" class="dependency-list">
            <div v-for="dep in dependencies" :key="dep.id" class="dependency-item">
              <button
                type="button"
                class="link-button"
                @click="state.openIssueDetail(instanceId, owner, repo, dep.number)"
              >
                #{{ dep.number }} {{ dep.title }}
              </button>
              <button
                type="button"
                class="link-button"
                :title="t('dashboard.actions.delete')"
                :aria-label="t('dashboard.actions.delete')"
                @click="handleRemoveDependency(dep.number ?? 0)"
              >
                <vscode-icon name="trash" />
              </button>
            </div>
          </div>
          <div v-else-if="dependenciesError" class="dependency-status error" role="status">
            {{ t('dashboard.detail.dependenciesLoadFailed', { message: dependenciesError }) }}
          </div>
          <div v-else class="empty-list">{{ t('dashboard.detail.noDependencies') }}</div>
          <div class="dependency-form">
            <!-- The control stays mounted while the list loads: unmounting it one
                 tick after the open would close the dropdown the user just opened,
                 and keyboard users (the element opens from its own keydown, with no
                 click) could never load the list at all. -->
            <vscode-single-select
              :value="selectedDependencyNumber === undefined ? '' : String(selectedDependencyNumber)"
              class="dependency-select"
              :label="t('dashboard.detail.dependencies')"
              @click="ensureRepoIssuesLoaded"
              @keydown="ensureRepoIssuesLoaded"
              @change="selectedDependencyNumber = Number(($event.target as HTMLSelectElement).value) || undefined"
            >
              <vscode-option value="">{{ t('dashboard.detail.dependencyPlaceholder') }}</vscode-option>
              <vscode-option v-for="issue in availableDependencies" :key="issue.id" :value="String(issue.number)">
                #{{ issue.number }} {{ issue.title }}
              </vscode-option>
            </vscode-single-select>
            <vscode-button
              icon="add"
              :disabled="repoIssuesLoading || !selectedDependencyNumber || availableDependencies.length === 0"
              @click="addDependency"
              secondary
            >
              {{ t('dashboard.detail.addDependency') }}
            </vscode-button>
            <div v-if="repoIssuesLoading" class="dependency-status">{{ t('dashboard.detail.dependencyLoading') }}</div>
            <div v-if="dependenciesError && dependencies.length" class="dependency-status error" role="status">
              {{ t('dashboard.detail.dependencyChangeFailed', { message: dependenciesError }) }}
            </div>
          </div>
          <div
            v-if="repoIssuesFetched && !repoIssuesLoading && availableDependencies.length === 0"
            class="dependency-status empty"
          >
            {{ t('dashboard.detail.dependencyEmpty') }}
          </div>
          <div v-if="repoIssuesFetched && !repoIssuesLoading && repoIssuesTruncated" class="dependency-status">
            {{ t('dashboard.detail.dependencyTruncated') }}
          </div>
        </CollapsibleSection>
      </div>

      <ModalDialog
        :open="isEditing"
        :title="t('dashboard.form.editPullRequest')"
        :loading="formLoading"
        :confirm-close-if-dirty="true"
        :is-dirty="editDialogDirty"
        @close="closeEdit"
      >
        <PullRequestForm
          :key="editFormResetKey"
          mode="edit"
          :initial-title="detail.title"
          :initial-body="detail.body"
          :initial-base="detail.base?.ref"
          :initial-head="detail.head?.ref"
          :initial-label-ids="
            (detail.labels ?? []).map((label) => label.id).filter((id): id is number => id !== undefined)
          "
          :initial-assignees="(detail.assignees ?? []).map((user) => user.login ?? '').filter(Boolean)"
          :initial-milestone-id="detail.milestone?.id"
          :initial-due-date="detail.due_date"
          :branches="branches"
          :labels="labels"
          :assignees="assignees"
          :milestones="milestones"
          :submit-label="t('dashboard.form.save')"
          :loading="formLoading"
          :error="editError"
          :upload-image="handleUploadImage"
          :instance-id="instanceId"
          :owner="owner"
          :repo="repo"
          @submit="handleEditSubmit"
          @cancel="confirmCancelEdit"
          @dirty="editFormDirty = $event"
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

.loading-state,
.error-state {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-descriptionForeground);
}

.error-state {
  flex-wrap: wrap;
}

.state-toggle-error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
  margin-bottom: 8px;
}

/* Neutral feedback (e.g. an attachment that survived a declined confirmation):
   informative, not an error. */
.detail-notice {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  margin-bottom: 8px;
}

.detail-content {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 24px;
  align-items: start;
}

@media (max-width: 720px) {
  .detail-content {
    grid-template-columns: 1fr;
  }
}

.detail-main {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.detail-sidebar {
  display: flex;
  flex-direction: column;
  gap: 0;
  position: sticky;
  top: 0;
  max-height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
}

.detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
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

.header-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.state-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.8em;
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

.state-merged {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-gitDecoration-addedResourceForeground, #8957e5);
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

/* Wraps the upload field and the pending list as one group. Both used to be
   direct children of `.comment-form`, so they took part in its 8px gap; the
   wrapper has to reproduce that spacing towards them and towards the action
   row, otherwise the form loses its rhythm. */
.comment-form-attachments {
  display: flex;
  flex-direction: column;
  gap: 8px;
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

.merge-status-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.merge-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9em;
}

.merge-status.mergeable {
  color: var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground));
}

.merge-status.blocked {
  color: var(--vscode-testing-iconFailed, var(--vscode-gitDecoration-conflictingResourceForeground));
}

.merge-status.blocked.conflicts {
  color: var(--vscode-editorWarning-foreground, var(--vscode-gitDecoration-conflictingResourceForeground));
}

.merge-status.unknown {
  color: var(--vscode-descriptionForeground);
}

.checks-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checks-section h3 {
  margin: 0;
  font-size: 0.95rem;
  color: var(--vscode-foreground);
}

.checks-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9em;
  font-weight: 600;
}

.checks-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.check-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9em;
}

.check-icon {
  flex-shrink: 0;
}

.check-icon.success {
  color: var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground));
}

.check-icon.pending {
  color: var(--vscode-descriptionForeground);
}

.check-icon.failure,
.check-icon.error {
  color: var(--vscode-testing-iconFailed, var(--vscode-gitDecoration-deletedResourceForeground));
}

.check-icon.warning {
  color: var(--vscode-editorWarning-foreground, var(--vscode-gitDecoration-untrackedResourceForeground));
}

.check-icon.unknown {
  color: var(--vscode-descriptionForeground);
}

.check-context {
  color: var(--vscode-foreground);
}

.check-description {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  margin-left: 22px;
}

.loading-inline {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.subscription-actions {
  display: flex;
  gap: 8px;
}

/* A failed subscription check: the message above its own retry, instead of a
   "Loading..." line that never ends. */
.subscription-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  font-size: 0.9em;
}

.time-tracking-error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
  margin-bottom: 8px;
}

.time-tracking-summary {
  font-size: 1.1em;
  font-weight: 600;
  margin-bottom: 8px;
}

.time-tracking-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.time-tracking-form {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.time-tracking-form vscode-textfield {
  width: 60px;
}

.tracked-time-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tracked-time-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9em;
}

.tracked-time-user {
  color: var(--vscode-descriptionForeground);
}

.dependency-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.dependency-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dependency-form {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dependency-form vscode-textfield {
  flex: 1;
}

.dependency-select {
  flex: 1;
  min-width: 0;
  font-size: 0.9em;
}

.dependency-status {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.dependency-status.empty {
  margin-top: 8px;
}

.assignee-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.assignee-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9em;
}

.user-avatar-small {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}

.user-avatar-small.avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.due-date {
  font-size: 0.9em;
  color: var(--vscode-foreground);
}

.due-date-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9em;
}

.due-date-empty {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.due-date-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.due-date-edit-actions {
  display: flex;
  gap: 8px;
}

.participant-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.reference-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9em;
}

.reference-text {
  font-family: var(--vscode-editor-font-family), monospace;
  color: var(--vscode-foreground);
  word-break: break-all;
}

.issue-reactions {
  margin-top: 12px;
}

.empty-list {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  margin-bottom: 12px;
}
.tracked-time-scope {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.time-tracking-hint {
  margin: 0 0 8px;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}
</style>
