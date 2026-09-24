<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { isListTruncated } from '@cpf23333-forgejo-toolkit/shared/limits';
import { useI18n } from 'vue-i18n';
import { useAppState, repoRefsKey } from '../composables/useAppState';
import RepoRefFormDialog, { type RepoRefFormMode } from './RepoRefFormDialog.vue';
import type { ForgejoRelease } from '../types/api';

const props = defineProps<{
  instanceId: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
}>();

const emit = defineEmits<{
  (e: 'select-branch', branch: string): void;
}>();

const { t } = useI18n();
const state = useAppState();

const activeTab = ref<'branches' | 'tags' | 'releases'>('branches');

// Branches, tags and releases are paged lists with a hard cap and no total, so the
// active tab says when its list was cut off.
const activeList = computed<unknown[]>(() => (data.value?.[activeTab.value] ?? []) as unknown[]);
const listTruncated = computed(() => isListTruncated(activeList.value));
// Computed, not a constant built once in setup: a constant captured the labels
// through `t(...)` at setup time, so a runtime locale change left the three tabs
// in the old language while the rest of the view re-rendered.
const tabs = computed(() => [
  { key: 'branches' as const, label: t('dashboard.repoRefs.branches') },
  { key: 'tags' as const, label: t('dashboard.repoRefs.tags') },
  { key: 'releases' as const, label: t('dashboard.repoRefs.releases') },
]);

const key = computed(() => repoRefsKey(props.instanceId, props.owner, props.repo));
const data = computed(() => state.repoRefs.value.get(key.value));
const loading = computed(() => state.loading.get(key.value) ?? false);
const error = computed(() => state.errors.get(key.value));

const dialogOpen = ref(false);
const dialogMode = ref<RepoRefFormMode>('branch');
const editingRelease = ref<ForgejoRelease | undefined>(undefined);
const isSubmitting = ref(false);
const submitError = ref<string | undefined>(undefined);
// Mirrors the open dialog's own dirty state so Esc/× and Cancel ask before
// discarding typed input (the dialog reports it through `dirty`).
const dialogDirty = ref(false);
// Guards against two discard prompts while one is pending.
let cancelConfirmInFlight = false;
const pendingReleaseAttachments = ref<File[]>([]);
const uploadingReleaseAttachmentCount = ref(0);
const isUploadingReleaseAttachments = ref(false);
// Remembered after a successful create so a retry only uploads the remaining
// attachments instead of creating a duplicate release (tag conflict).
const createdReleaseId = ref<number | undefined>(undefined);

watch(
  () => [props.instanceId, props.owner, props.repo],
  () => {
    state.loadRepoRefs(props.instanceId, props.owner, props.repo);
  },
  { immediate: true },
);

watch(loading, (value) => {
  if (value) {
    return;
  }
  if (isSubmitting.value && !isUploadingReleaseAttachments.value) {
    // The refs request this submit triggered has answered and there is no error
    // to show on the dialog: the operation is over, whether it succeeded or the
    // host answered without a message (a declined host-side confirmation).
    isSubmitting.value = false;
    if (!error.value) {
      closeDialog();
    }
  }
});

// A failed create only sets an error: it never reloads the refs, so `loading`
// stays false and the watcher above never runs. Without this the dialog stayed
// busy forever after a failure, and the next refs reload (e.g. when the user
// retried and the list was refreshed) hit the `!loading && isSubmitting` branch
// and closed a dialog the user still had open.
watch(error, (value) => {
  if (value && isSubmitting.value) {
    isSubmitting.value = false;
  }
});

function formatDate(date: string): string {
  try {
    return new Date(date).toLocaleDateString(state.locale.value);
  } catch {
    return date;
  }
}

function selectBranch(name?: string) {
  if (name) {
    emit('select-branch', name);
  }
}

// Rows are focusable and act as buttons, so Enter/Space must select the branch.
// Keydown bubbles from the row's own delete button; that control handles its own
// activation, so leave it alone instead of selecting the branch as well. The key
// names are normalised here because the target guard has to run before any
// preventDefault (a Vue `.space.prevent` modifier would swallow the inner
// button's own Space activation).
function onBranchKeydown(event: KeyboardEvent, name?: string) {
  const target = event.target as HTMLElement | null;
  if (target?.closest('.ref-delete-button')) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key !== 'enter' && key !== ' ' && key !== 'space') {
    return;
  }
  event.preventDefault();
  selectBranch(name);
}

function retryLoad() {
  state.loadRepoRefs(props.instanceId, props.owner, props.repo, true);
}

function openDialog(mode: RepoRefFormMode, release?: ForgejoRelease) {
  dialogMode.value = mode;
  editingRelease.value = release;
  pendingReleaseAttachments.value = [];
  submitError.value = undefined;
  createdReleaseId.value = undefined;
  dialogDirty.value = false;
  dialogOpen.value = true;
}

function closeDialog() {
  dialogOpen.value = false;
  dialogDirty.value = false;
  editingRelease.value = undefined;
  pendingReleaseAttachments.value = [];
  submitError.value = undefined;
  createdReleaseId.value = undefined;
  isSubmitting.value = false;
}

/**
 * Cancel in the dialog routes here instead of closing directly: like Esc and ×,
 * it must ask before discarding typed input. The prompt is the same
 * `common.discardChangesConfirm` the modal's own Esc/× path uses — the dialog's
 * Cancel button is its own control, so it cannot go through `ModalDialog`'s
 * private `requestClose`.
 */
async function confirmCancelDialog() {
  if (!dialogDirty.value) {
    closeDialog();
    return;
  }
  if (cancelConfirmInFlight) {
    return;
  }
  cancelConfirmInFlight = true;
  try {
    if (await state.showConfirm(t('common.discardChangesConfirm'))) {
      closeDialog();
    }
  } finally {
    cancelConfirmInFlight = false;
  }
}

function handleReleaseAttachmentUpload(file: File) {
  pendingReleaseAttachments.value.push(file);
}

function removePendingReleaseAttachment(index: number) {
  pendingReleaseAttachments.value.splice(index, 1);
}

async function handleSubmit(data: Record<string, unknown>) {
  // A second submit while the first is still in flight must not be issued. The
  // create commands are fire-and-forget, and a branch/tag create sets no loading
  // key of its own, so the dialog's own `loading` gate only opened once the refs
  // reload arrived: a double click in that window posted a second create, whose
  // "already exists" reply replaced the success of the first.
  if (isSubmitting.value) {
    return;
  }
  // Capture the target before the first await. Creating the release and
  // uploading its attachments are separate round-trips, and `props` follows the
  // parent: reading the owner/repo again after an await would post the remaining
  // attachments to whatever repository the user navigated to — with the old
  // release id.
  const target = { instanceId: props.instanceId, owner: props.owner, repo: props.repo };
  isSubmitting.value = true;
  switch (dialogMode.value) {
    case 'branch':
      state.createRepoBranch(
        target.instanceId,
        target.owner,
        target.repo,
        String(data.newBranchName),
        data.oldRefName ? String(data.oldRefName) : undefined,
      );
      break;
    case 'tag':
      state.createRepoTag(
        target.instanceId,
        target.owner,
        target.repo,
        String(data.tagName),
        data.target ? String(data.target) : undefined,
        data.message ? String(data.message) : undefined,
      );
      break;
    case 'release':
      if (editingRelease.value?.id !== undefined) {
        state.editRepoRelease(target.instanceId, target.owner, target.repo, editingRelease.value.id, {
          tag_name: String(data.tagName),
          name: data.name ? String(data.name) : undefined,
          target_commitish: data.targetCommitish ? String(data.targetCommitish) : undefined,
          body: data.body ? String(data.body) : undefined,
          prerelease: Boolean(data.prerelease),
          draft: Boolean(data.draft),
          hide_archive_links: Boolean(data.hideArchiveLinks),
        });
      } else {
        isUploadingReleaseAttachments.value = true;
        submitError.value = undefined;
        try {
          let releaseId = createdReleaseId.value;
          if (releaseId === undefined) {
            const release = await state.createRepoRelease(
              target.instanceId,
              target.owner,
              target.repo,
              String(data.tagName),
              data.name ? String(data.name) : undefined,
              data.body ? String(data.body) : undefined,
              data.targetCommitish ? String(data.targetCommitish) : undefined,
              Boolean(data.prerelease),
              Boolean(data.draft),
              Boolean(data.hideArchiveLinks),
            );
            releaseId = release.id;
            createdReleaseId.value = releaseId;
          }
          const files = [...pendingReleaseAttachments.value];
          if (releaseId !== undefined && files.length > 0) {
            const remaining: File[] = [];
            await Promise.all(
              files.map(async (file) => {
                uploadingReleaseAttachmentCount.value += 1;
                try {
                  const buffer = await file.arrayBuffer();
                  await state.uploadReleaseAttachment(
                    target.instanceId,
                    target.owner,
                    target.repo,
                    releaseId,
                    file.name,
                    new Uint8Array(buffer),
                  );
                } catch {
                  // Keep the failed file queued so a retry re-uploads only the remainder.
                  remaining.push(file);
                } finally {
                  uploadingReleaseAttachmentCount.value -= 1;
                }
              }),
            );
            pendingReleaseAttachments.value = remaining;
            if (remaining.length > 0) {
              submitError.value = t('dashboard.repoRefs.attachmentUploadFailed', { count: remaining.length });
              isSubmitting.value = false;
              return;
            }
          }
          pendingReleaseAttachments.value = [];
          createdReleaseId.value = undefined;
          state.loadRepoRefs(target.instanceId, target.owner, target.repo, true);
        } catch (err) {
          submitError.value = err instanceof Error && err.message ? err.message : String(err);
          isSubmitting.value = false;
        } finally {
          isUploadingReleaseAttachments.value = false;
        }
      }
      break;
  }
}

// Deletions are confirmed host-side (the host re-prompts before executing);
// the webview must not add its own confirmation.
function removeBranch(name?: string) {
  if (!name) {
    return;
  }
  state.deleteRepoBranch(props.instanceId, props.owner, props.repo, name);
}

function removeTag(name?: string) {
  if (!name) {
    return;
  }
  state.deleteRepoTag(props.instanceId, props.owner, props.repo, name);
}

function removeRelease(id?: number) {
  if (id === undefined || id === null) {
    return;
  }
  state.deleteRepoRelease(props.instanceId, props.owner, props.repo, id);
}
</script>

<template>
  <div class="repo-refs">
    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-button"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <div v-if="loading && !data" class="status">{{ t('dashboard.loading') }}</div>
    <div v-else-if="error && !data" class="status error">
      {{ error }}
      <button type="button" class="link-button" @click="retryLoad">{{ t('dashboard.retry') }}</button>
    </div>

    <template v-else>
      <!-- A failed refresh keeps the cached list and shows an inline error
           with a retry entry instead of replacing everything. -->
      <div v-if="error" class="status error">
        {{ error }}
        <button type="button" class="link-button" @click="retryLoad">{{ t('dashboard.retry') }}</button>
      </div>
      <div v-if="listTruncated" class="list-truncated">
        {{ t('dashboard.repoRefs.truncated') }}
      </div>
      <div v-if="activeTab === 'branches'" class="ref-list">
        <div class="ref-actions">
          <button class="ref-action-button" @click="openDialog('branch')">
            {{ t('dashboard.repoRefs.createBranch') }}
          </button>
        </div>
        <div
          v-for="branch in data?.branches"
          :key="branch.name"
          class="ref-item branch-item"
          role="button"
          tabindex="0"
          @click="selectBranch(branch.name)"
          @keydown="onBranchKeydown($event, branch.name)"
        >
          <div class="ref-main">
            <span class="ref-name">{{ branch.name }}</span>
            <span v-if="branch.protected" class="badge protected">{{ t('dashboard.repoRefs.protected') }}</span>
            <button
              v-if="branch.name !== defaultBranch"
              class="ref-delete-button"
              type="button"
              :title="t('dashboard.repoRefs.deleteBranch')"
              :aria-label="t('dashboard.repoRefs.deleteBranch')"
              @click.stop="removeBranch(branch.name)"
            >
              ×
            </button>
          </div>
          <div v-if="branch.commit?.message" class="ref-meta">
            {{ branch.commit.message.split('\n')[0] }}
          </div>
        </div>
        <div v-if="!data?.branches.length" class="status">{{ t('dashboard.repoRefs.emptyBranches') }}</div>
      </div>

      <div v-if="activeTab === 'tags'" class="ref-list">
        <div class="ref-actions">
          <button class="ref-action-button" @click="openDialog('tag')">{{ t('dashboard.repoRefs.createTag') }}</button>
        </div>
        <div v-for="tag in data?.tags" :key="tag.name" class="ref-item">
          <div class="ref-main">
            <span class="ref-name">{{ tag.name }}</span>
            <button
              class="ref-delete-button"
              type="button"
              :title="t('dashboard.repoRefs.deleteTag')"
              :aria-label="t('dashboard.repoRefs.deleteTag')"
              @click.stop="removeTag(tag.name)"
            >
              ×
            </button>
          </div>
          <div class="ref-meta">
            <span v-if="tag.commit?.sha">{{ tag.commit.sha.slice(0, 7) }}</span>
          </div>
          <div v-if="tag.message" class="ref-description">
            {{ tag.message.split('\n')[0] }}
          </div>
        </div>
        <div v-if="!data?.tags.length" class="status">{{ t('dashboard.repoRefs.emptyTags') }}</div>
      </div>

      <div v-if="activeTab === 'releases'" class="ref-list">
        <div class="ref-actions">
          <button class="ref-action-button" @click="openDialog('release')">
            {{ t('dashboard.repoRefs.createRelease') }}
          </button>
        </div>
        <div v-for="release in data?.releases" :key="release.id" class="ref-item">
          <div class="ref-main">
            <span class="ref-name">{{ release.name || release.tag_name }}</span>
            <span v-if="release.prerelease" class="badge prerelease">{{ t('dashboard.repoRefs.prerelease') }}</span>
            <span v-else-if="release.draft" class="badge draft">{{ t('dashboard.repoRefs.draft') }}</span>
            <button
              class="ref-edit-button"
              type="button"
              :title="t('dashboard.repoRefs.editRelease')"
              :aria-label="t('dashboard.repoRefs.editRelease')"
              @click.stop="openDialog('release', release)"
            >
              ✎
            </button>
            <button
              class="ref-delete-button"
              type="button"
              :title="t('dashboard.repoRefs.deleteRelease')"
              :aria-label="t('dashboard.repoRefs.deleteRelease')"
              @click.stop="removeRelease(release.id)"
            >
              ×
            </button>
          </div>
          <div class="ref-meta">
            <span v-if="release.tag_name">{{ release.tag_name }}</span>
            <span v-if="release.published_at">{{ formatDate(release.published_at) }}</span>
          </div>
        </div>
        <div v-if="!data?.releases.length" class="status">{{ t('dashboard.repoRefs.emptyReleases') }}</div>
      </div>
    </template>

    <RepoRefFormDialog
      :mode="dialogMode"
      :open="dialogOpen"
      :instance-id="instanceId"
      :owner="owner"
      :repo="repo"
      :default-branch="defaultBranch"
      :loading="isSubmitting || isUploadingReleaseAttachments || uploadingReleaseAttachmentCount > 0"
      :error="submitError ?? error"
      :release="editingRelease"
      :branches="data?.branches.map((b) => b.name ?? '').filter(Boolean)"
      :tags="data?.tags.map((t) => t.name ?? '').filter(Boolean)"
      :pending-attachments="pendingReleaseAttachments"
      @close="closeDialog"
      @cancel="confirmCancelDialog"
      @submit="handleSubmit"
      @upload-pending="handleReleaseAttachmentUpload"
      @remove-pending="removePendingReleaseAttachment"
      @dirty="dialogDirty = $event"
    />
  </div>
</template>

<style scoped>
.repo-refs {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.tab-button {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--vscode-foreground);
  padding: 6px 12px;
  cursor: pointer;
  font-size: 0.95em;
  border-radius: 0;
}

.tab-button:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
}

.tab-button.active {
  color: var(--vscode-textLink-foreground);
  border-bottom-color: var(--vscode-textLink-foreground);
}

.ref-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ref-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-radius: 4px;
}

.ref-item:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
}

.branch-item {
  cursor: pointer;
}

.branch-item:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.ref-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}

.ref-action-button {
  background-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 0.85em;
}

.ref-action-button:hover {
  background-color: var(--vscode-button-hoverBackground);
}

.ref-delete-button {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-size: 1.1em;
  line-height: 1;
  padding: 0 4px;
}

.ref-delete-button:hover {
  color: var(--vscode-testing-iconFailed);
}

.ref-edit-button {
  background: transparent;
  border: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-size: 1em;
  line-height: 1;
  padding: 0 4px;
}

.ref-edit-button:hover {
  color: var(--vscode-textLink-foreground);
}

.ref-main {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ref-name {
  font-weight: 600;
  color: var(--vscode-foreground);
}

.ref-meta {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  display: flex;
  gap: 8px;
}

.ref-description {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.badge {
  font-size: 0.75em;
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 600;
}

.badge.protected {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-gitDecoration-untrackedResourceForeground, #28a745);
}

.badge.prerelease {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
}

.badge.draft {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-panel-border);
}

.status {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  padding: 8px 0;
}

.status.error {
  color: var(--vscode-testing-iconFailed);
}
</style>
