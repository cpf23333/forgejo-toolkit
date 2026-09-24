<script setup lang="ts">
import { computed, onActivated, onUnmounted, ref, watch } from 'vue';
import { isListTruncated } from '@cpf23333-forgejo-toolkit/shared/limits';
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
import { uploadFilesKeepingFailures } from '../utils/uploadFilesKeepingFailures';
import { removePendingImageFromBody } from '../utils/pendingImageMarkdown';

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
// The host caps a paged list at LIST_ITEM_LIMIT and reports no total, so the list
// says it may be incomplete instead of looking complete.
const listTruncated = computed(() => isListTruncated(items.value));
const loading = computed(() => state.loading.get(key.value) ?? false);
const error = computed(() => state.errors.get(key.value));

// The route path this instance was created for, i.e. the path the app keys the
// keep-alive cache with. Under keep-alive this view is deactivated (not
// unmounted) when navigating away and `route` then follows the global route, so
// its own route is only recognizable by that path. Comparing the live path with
// it is synchronous, which the guard below needs: `route.path` already points at
// the new route while `onDeactivated` has not run yet, and a watcher is a
// pre-flush watcher — it is flushed before the lifecycle hooks of the very route
// change that hides this view. An `isActive` flag set in a lifecycle hook would
// therefore still read `true` at that moment.
const ownPath = route.path;
const isActive = computed(() => route.path === ownPath);

// Keep the previous list on screen while a newly selected key (state filter,
// search query) loads; swap only when fresh data or an error lands, so the
// list never flashes a loading placeholder in place of the old items. Guarded
// on `isActive`: a deactivated keep-alive instance keeps running its watchers
// while `route.params` follows the global route, so an unguarded swap would
// adopt the rows of the repository the user navigated to — and since the
// keep-alive cache keeps whichever view activates last, the abandoned instance
// could win that race and render the other repository's rows under its own
// header.
const displayItems = ref<ForgejoIssue[]>([]);
function syncDisplayItems() {
  if (!isActive.value) {
    return;
  }
  if (!loading.value || error.value) {
    displayItems.value = items.value;
  }
}
// `isActive` is watched as well, so that coming back re-adopts the rows: a reply
// that arrived while this view was off screen was dropped by the guard, and
// returning does not have to change the list key (opening an issue of the same
// repository keeps it), so no other source would change and the list would stay
// empty until a manual refresh. Watching it also runs the sync in the same
// pre-flush pass as the reactivation, i.e. before the view is rendered again.
watch([items, loading, error, isActive], syncDisplayItems, { immediate: true });

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
// Number of the issue this form already created. Creation and attachment
// upload are separate steps, so a failed upload must not lead to a second
// issue when the user submits again.
const createdIssueNumber = ref<number | undefined>(undefined);
// Object URL -> attachment URL for uploads that already succeeded. Accumulated
// across retries so the body is rewritten once, when every file is uploaded.
const uploadedImageReplacements = ref<Map<string, string>>(new Map());

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

let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;

function applySearchQuery() {
  appliedQuery.value = searchInput.value.trim();
  if (hasIssues.value) {
    state.loadRepoIssues(instanceId.value, owner.value, repo.value, stateParam.value, appliedQuery.value);
  }
}

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
  // A debounced search dropped while this view was deactivated (isActive
  // guard in the debounce callback) leaves the input ahead of the applied
  // query; re-apply it so the list matches what the input still shows.
  if (searchInput.value.trim() !== appliedQuery.value) {
    clearTimeout(searchDebounceTimer);
    applySearchQuery();
  }
  // Params may have changed back before this hook ran; make sure data for the
  // current route is loaded (loaders dedup via their caches).
  loadListData();
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

watch(searchInput, () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    // The view may have been deactivated (or the route switched) during the
    // debounce window; applying the query then would fire a request with the
    // new route's params. onActivated re-applies the dropped input.
    if (!isActive.value) {
      return;
    }
    applySearchQuery();
  }, 300);
});

// `keep-alive :max="10"` evicts the least recently used view once the cache is
// full, which unmounts it. A debounce armed before that would still fire and
// post a search for a view that no longer exists (with the params it captured,
// for a repository the user has left).
onUnmounted(() => {
  clearTimeout(searchDebounceTimer);
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
  // The repository can have issues turned off (or be a mirror). The view already
  // says so instead of the list; opening the form anyway would let the user fill
  // in an issue whose labels/assignees/milestones cannot even be loaded
  // (`loadListData` is gated on the same flag) only to have the server reject it.
  if (!hasIssues.value) {
    return;
  }
  createInitialTitle.value = prefill?.title ?? '';
  createInitialBody.value = prefill?.body ?? '';
  createFormResetKey.value += 1;
  // A fresh form creates a fresh issue.
  createdIssueNumber.value = undefined;
  uploadedImageReplacements.value.clear();
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
  uploadedImageReplacements.value.clear();
  // The form is abandoned; a later create must start from a fresh issue.
  createdIssueNumber.value = undefined;
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

/**
 * How long the wait for a rewrite reply may take before it is reported as a
 * failure. Mirrors the webview's own request timeout for promise-based commands;
 * the rewrite is fire-and-forget, so nothing else bounds it.
 */
const BODY_REWRITE_TIMEOUT_MS = 60_000;
/** One retry, then the failure is reported instead of retried forever. */
const BODY_REWRITE_ATTEMPTS = 2;

/**
 * Waits for the host to answer an edit dispatched on `key`.
 *
 * `editIssue` is a fire-and-forget message: it reports its reply by clearing the
 * key's loading slot, and its failure on that key's error slot. Watching those two
 * is the only way to learn the outcome here, and the outcome is what decides
 * whether the session's `blob:` image URLs may be released. Resolves `false` when
 * the host never answered, so a lost reply is reported instead of hanging the
 * create flow.
 */
function waitForFormReply(key: string): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = watch(
      () => [state.loading.get(key) ?? false, state.errors.get(key)] as const,
      ([loadingNow]) => {
        if (loadingNow) {
          return;
        }
        if (timer) {
          clearTimeout(timer);
        }
        stop();
        resolve(true);
      },
    );
    timer = setTimeout(() => {
      stop();
      resolve(false);
    }, BODY_REWRITE_TIMEOUT_MS);
  });
}

/**
 * The failure notice for a rewrite that did not land. One sentence naming both
 * what failed and the state the issue is left in: the stored body still carries
 * this session's `blob:` image URLs, which no other reader can load.
 *
 * Falls back to the generic save error while the dedicated key is missing
 * (a missing key resolves to the key itself, and a raw key is not a message).
 */
function bodyRewriteFailureMessage(reason: string): string {
  const key = 'dashboard.repoIssues.bodyRewriteFailed';
  const message = t(key, { message: reason });
  return message === key ? t('dashboard.form.error', { message: reason }) : message;
}

/**
 * Rewrites the body of the issue that was just created, reporting the host's
 * reason when it fails. Returns undefined on success.
 *
 * The rewrite is a follow-up PUT of its own. It used to be dispatched without
 * being awaited, and its error was filed under the create form's key - rendered
 * only inside the dialog that was already closing - while the view revoked the
 * object URLs and navigated away. A failed rewrite therefore stored the issue
 * permanently with `blob:` image sources that no reader can load, and said
 * nothing about it.
 */
async function rewriteBodyAfterCreate(
  target: { instanceId: string; owner: string; repo: string },
  issueNumber: number,
  title: string,
  body: string,
): Promise<string | undefined> {
  const key = issueFormKey(target.instanceId, target.owner, target.repo, issueNumber);
  let failure = t('common.requestFailed');
  for (let attempt = 0; attempt < BODY_REWRITE_ATTEMPTS; attempt += 1) {
    state.errors.delete(key);
    state.editIssue(target.instanceId, target.owner, target.repo, issueNumber, { title, body });
    // `editIssue` marks the key busy before it posts. A key that is not busy has
    // nothing on the wire: either the host answered synchronously or no request
    // was registered at all, so there is no reply to wait for.
    const settled = (state.loading.get(key) ?? false) ? await waitForFormReply(key) : true;
    const reason = state.errors.get(key);
    if (settled && !reason) {
      return undefined;
    }
    failure = reason ?? t('common.requestTimeout');
  }
  return failure;
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
  // Capture the target repository before the first await. Creating the issue,
  // uploading its attachments and rewriting its body are separate round-trips,
  // and `route.params` follows the global route: reading it again after an await
  // would post an attachment to whatever repository the user switched to — and
  // would report a later failure on the form of the repository the user is
  // looking at now instead of the one that was submitted.
  const target = { instanceId: instanceId.value, owner: owner.value, repo: repo.value };
  const formKey = issueFormKey(target.instanceId, target.owner, target.repo, 0);
  try {
    let issueNumber = createdIssueNumber.value;
    if (issueNumber === undefined) {
      const issue = await state.createIssue(target.instanceId, target.owner, target.repo, data);
      issueNumber = issue.number;
      createdIssueNumber.value = issueNumber;
    }
    // The issue exists from here on: upload what is still pending and keep only
    // the failures queued, so a resubmit retries the uploads instead of
    // creating a duplicate issue (and never re-uploads a finished file).
    const remaining = await uploadFilesKeepingFailures(pendingIssueAttachments.value, async (file) => {
      uploadingIssueAttachmentCount.value += 1;
      try {
        const attachment = await state.uploadIssueAttachment(
          target.instanceId,
          target.owner,
          target.repo,
          issueNumber,
          file,
        );
        if (attachment.uuid) {
          for (const [objectUrl, pendingFile] of pendingImageObjectUrls.value) {
            if (pendingFile === file) {
              uploadedImageReplacements.value.set(objectUrl, `/attachments/${attachment.uuid}`);
              break;
            }
          }
        }
      } finally {
        uploadingIssueAttachmentCount.value -= 1;
      }
    });
    if (remaining.length > 0) {
      pendingIssueAttachments.value = remaining;
      state.errors.set(formKey, t('dashboard.repoIssues.attachmentUploadFailed', { count: remaining.length }));
      return;
    }
    // Everything queued is on the server now. The list is emptied before the
    // rewrite, so a resubmit after a failed rewrite does not upload the same
    // files a second time (only a still-failing upload stays queued).
    pendingIssueAttachments.value = [];
    let updatedBody = data.body;
    // Every pending image that still has no replacement entry was removed from
    // the attachment list (an uploaded one always has one), so only its session
    // `blob:` URL is left in the body. Strip it instead of storing a broken image.
    for (const objectUrl of pendingImageObjectUrls.value.keys()) {
      if (!uploadedImageReplacements.value.has(objectUrl)) {
        updatedBody = removePendingImageFromBody(updatedBody, objectUrl);
      }
    }
    for (const [objectUrl, attachmentUrl] of uploadedImageReplacements.value) {
      updatedBody = updatedBody.replaceAll(objectUrl, attachmentUrl);
    }
    if (updatedBody !== data.body) {
      // Await the rewrite (with one retry) before the URLs are released and the
      // view navigates: a failure has to be visible and recoverable, not filed
      // under the key of a dialog that is closing.
      const rewriteFailure = await rewriteBodyAfterCreate(target, issueNumber, data.title, updatedBody);
      if (rewriteFailure !== undefined) {
        // Keep everything a retry needs: the created issue's number (a resubmit
        // then rewrites instead of creating a duplicate issue), the session's
        // object URLs (the stored body still references them) and the dialog
        // itself, where this error is rendered.
        state.errors.set(formKey, bodyRewriteFailureMessage(rewriteFailure));
        return;
      }
    }
    for (const url of pendingImageObjectUrls.value.keys()) {
      URL.revokeObjectURL(url);
    }
    pendingImageObjectUrls.value.clear();
    pendingIssueAttachments.value = [];
    uploadedImageReplacements.value.clear();
    createdIssueNumber.value = undefined;
    isCreating.value = false;
    state.openIssueDetail(target.instanceId, target.owner, target.repo, issueNumber);
  } catch (error) {
    // Creating the issue itself failed: the form stays as it is for a retry.
    const message = error instanceof Error ? error.message : String(error);
    state.errors.set(formKey, message);
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
          :label="t('dashboard.repoIssues.searchPlaceholder')"
          @input="searchInput = ($event.target as HTMLInputElement).value"
        />
        <!-- The disabled-state message below already explains why; the action
             itself is only offered when the repository can take a new issue. -->
        <vscode-button v-if="hasIssues" icon="add" @click="openCreateIssue()">
          {{ t('dashboard.actions.newIssue') }}
        </vscode-button>
        <div class="state-filter">
          <button
            v-for="s in states"
            :key="s"
            type="button"
            class="filter-button"
            :class="{ active: stateParam === s }"
            :aria-pressed="stateParam === s"
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
    <div v-if="listTruncated" class="empty-list list-truncated">
      {{ t('dashboard.repoIssues.truncated') }}
    </div>

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
