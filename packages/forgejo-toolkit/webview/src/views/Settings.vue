<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAppState, saveInstanceTargetKey, type SaveInstanceTarget } from '../composables/useAppState';
import ModalDialog from '../components/ModalDialog.vue';
import TokenScopeList from '../components/TokenScopeList.vue';
import type { ForgejoInstance } from '../types/instance';
import type { Locale } from '../i18n';

const { t } = useI18n();
const state = useAppState();
const router = useRouter();

watch(
  () => state.importPreview.value,
  (preview) => {
    if (preview && router.currentRoute.value.name !== 'importPreview') {
      router.replace({ name: 'importPreview' });
    }
  },
);

const url = ref('');
const token = ref('');

// Forgejo's token management page lives at a fixed path under the instance
// (same helper as the onboarding form).
const tokenSettingsUrl = computed(() => {
  const base = url.value.trim().replace(/\/$/, '');
  return /^https?:\/\//.test(base) ? `${base}/user/settings/applications` : '';
});
const syncApiUrlsToInstanceUrl = ref(true);
const testing = ref(false);
const saving = ref(false);
const status = ref('');
const statusType = ref<'idle' | 'success' | 'error'>('idle');
const editingInstance = ref<ForgejoInstance | null>(null);
// The form this view is showing / last submitted, i.e. the only form a
// `saveInstanceResult` may be applied to. The host's save reply carries no
// identity, so the webview stamps it with the target it was sent for (see
// sendSaveInstance); without this guard the reply for one form would wipe the
// URL/token the user has since typed into another and claim that one was
// saved. `null` means no form has been submitted yet, so only an unstamped
// reply (one that predates stamping) is still applied.
let submittedTarget: SaveInstanceTarget | null = null;
// The add form is also a form the user can submit, so it gets a target of its
// own rather than `null`. A `testConnectionResult` is matched against it: an
// unstamped `null` target cannot tell "the add form is on screen" apart from
// "no form has been touched", and treating the add form's own reply as a stale
// one dropped exactly the result the user was waiting for (the status stuck on
// "Testing…" and a wrong-token error never appeared). `submittedTarget` keeps
// its `null` meaning for save replies, which only ever answer a submitted form.
const FORM_ADD: SaveInstanceTarget = { kind: 'new' };
const formTarget = computed<SaveInstanceTarget>(() =>
  editingInstance.value ? { kind: 'instance', instanceId: editingInstance.value.id } : FORM_ADD,
);
// A form switch (opening an instance for edit, cancelling back to the add form)
// invalidates every reply that was requested for the previous form. The reply
// arrives exactly once, so the busy flags are still reset on that path; only
// the *result* is dropped.
let formGeneration = 0;
// The test this view is waiting for (set by handleTest). The reply carries the
// stamp the composable read from the request intent, so this is only a
// fallback for an unstamped reply; the generation is what recognises a switch.
let pendingTest: { target: SaveInstanceTarget; generation: number } | null = null;
const exportStatus = ref<{ message: string; type: 'success' | 'error' } | null>(null);
const importStatus = ref<{ message: string; type: 'success' | 'error' } | null>(null);
const exportDialogOpen = ref(false);
const selectedExportIds = ref<Set<string>>(new Set());
const selectedLocale = ref<Locale>(state.locale.value as Locale);
const debugEnabled = ref<boolean>(state.debug.value);
const selectedWorktreeOpenMode = ref<'ask' | 'currentWindow' | 'newWindow'>(state.worktreeOpenMode.value);
const worktreeCacheDirectory = ref<string>(
  state.worktreeCacheDirectory.value ?? state.worktreeCacheDirectoryDefault.value ?? '',
);

watch(
  () => state.locale.value,
  (newLocale) => {
    selectedLocale.value = newLocale as Locale;
  },
);

watch(
  () => state.debug.value,
  (newDebug) => {
    debugEnabled.value = newDebug;
  },
);

watch(
  () => state.worktreeOpenMode.value,
  (newMode) => {
    selectedWorktreeOpenMode.value = newMode;
  },
);

watch(
  () => state.worktreeCacheDirectory.value,
  (newDir) => {
    if (newDir) {
      worktreeCacheDirectory.value = newDir;
    }
  },
);

watch(
  () => state.worktreeCacheDirectoryDefault.value,
  (newDefault) => {
    if (!worktreeCacheDirectory.value && newDefault) {
      worktreeCacheDirectory.value = newDefault;
    }
  },
);

// When editing an instance, an empty token field means "keep the stored
// token" (tokens are never sent back to the webview), so only the URL is
// required in that case.
const canSubmit = computed(
  () => Boolean(url.value.trim()) && (editingInstance.value !== null || Boolean(token.value.trim())),
);

function setStatus(message: string, type: 'idle' | 'success' | 'error' = 'idle') {
  status.value = message;
  statusType.value = type;
}

function handleTest() {
  if (!canSubmit.value) {
    return;
  }
  testing.value = true;
  // Record which form this test answers: the reply is dropped when the user has
  // moved to another form in the meantime (see the testConnectionResult watcher).
  pendingTest = { target: formTarget.value, generation: formGeneration };
  setStatus(t('settings.status.testing'));
  // In edit mode the token field may be empty (keep the stored token); the
  // host falls back to the stored token for the given instance id.
  state.testConnection(url.value.trim(), token.value.trim(), editingInstance.value?.id);
}

function handleSave() {
  if (!canSubmit.value) {
    return;
  }
  saving.value = true;
  submittedTarget = { kind: 'new' };
  setStatus(t('settings.status.testing'));
  state.saveInstance(url.value.trim(), token.value.trim(), syncApiUrlsToInstanceUrl.value);
}

function handleUpdate() {
  if (!editingInstance.value || !canSubmit.value) {
    return;
  }
  saving.value = true;
  submittedTarget = { kind: 'instance', instanceId: editingInstance.value.id };
  setStatus(t('settings.status.testing'));
  state.editInstance(editingInstance.value.id, url.value.trim(), token.value.trim(), syncApiUrlsToInstanceUrl.value);
}

function startEdit(instance: ForgejoInstance) {
  editingInstance.value = instance;
  // The form on screen is this instance now: a reply for a previously
  // submitted form must not touch it (see the saveInstanceResult watcher).
  submittedTarget = { kind: 'instance', instanceId: instance.id };
  // Any reply still in flight was requested for the form just left.
  formGeneration += 1;
  pendingTest = null;
  url.value = instance.url;
  // Tokens never reach the webview; leaving the field empty keeps the
  // stored token (see the editInstance host handler).
  token.value = '';
  syncApiUrlsToInstanceUrl.value = instance.syncApiUrlsToInstanceUrl ?? true;
  setStatus('');
}

function cancelEdit() {
  editingInstance.value = null;
  // Back to the add form: a reply for the edit that was just abandoned does
  // not belong to the form on screen any more.
  submittedTarget = { kind: 'new' };
  formGeneration += 1;
  pendingTest = null;
  url.value = '';
  token.value = '';
  syncApiUrlsToInstanceUrl.value = true;
  setStatus('');
}

// Removing an instance (the host re-sends `instances` after the removal) used to
// leave the edit form bound to a record that no longer exists, so its Update and
// Test buttons answered "Instance not found" (see the host's `editInstance`
// handler). The form closes together with its instance.
watch(
  () => state.instances.value,
  (instances) => {
    const editing = editingInstance.value;
    if (editing && !instances.some((instance) => instance.id === editing.id)) {
      cancelEdit();
    }
  },
);

// Removal is confirmed host-side (the host re-prompts before executing);
// the webview must not add its own confirmation.
function removeInstance(id: string) {
  if (!state.instances.value.some((i) => i.id === id)) {
    return;
  }
  state.removeInstance(id);
}

function handleExportInstances() {
  exportStatus.value = null;
  if (state.instances.value.length === 0) {
    return;
  }
  selectedExportIds.value = new Set(state.instances.value.map((instance) => instance.id));
  exportDialogOpen.value = true;
}

function confirmExport() {
  const ids = [...selectedExportIds.value];
  exportDialogOpen.value = false;
  if (ids.length > 0) {
    state.exportInstances(ids);
  }
}

function copyExportToClipboard() {
  const ids = [...selectedExportIds.value];
  exportDialogOpen.value = false;
  if (ids.length > 0) {
    state.copyInstancesToClipboard(ids);
  }
}

function cancelExport() {
  exportDialogOpen.value = false;
}

function toggleExportSelection(instance: ForgejoInstance, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const next = new Set(selectedExportIds.value);
  if (checked) {
    next.add(instance.id);
  } else {
    next.delete(instance.id);
  }
  selectedExportIds.value = next;
}

function handleImportInstances() {
  importStatus.value = null;
  state.previewImportInstances();
}

function handleLocaleChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  const newLocale = target.value as Locale;
  selectedLocale.value = newLocale;
  state.changeLocale(newLocale);
}

function handleDebugChange(event: Event) {
  const target = event.target as HTMLInputElement;
  debugEnabled.value = target.checked;
  state.changeDebug(target.checked);
}

function handleWorktreeOpenModeChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  const mode = target.value as 'ask' | 'currentWindow' | 'newWindow';
  selectedWorktreeOpenMode.value = mode;
  state.changeWorktreeOpenMode(mode);
}

function handleWorktreeCacheDirectoryChange(event: Event) {
  const target = event.target as HTMLInputElement;
  worktreeCacheDirectory.value = target.value;
}

function applyWorktreeCacheDirectory() {
  // The host validates the directory and answers with `worktreeCacheDirectory`
  // only when it accepted it: a rejected path gets a native error and no reply
  // at all. Put the directory that is actually in use back on screen, so a
  // rejected path cannot keep looking applied while new worktrees still go to
  // the previous one; the reply of an accepted path re-syncs the field.
  const inUse = state.worktreeCacheDirectory.value ?? state.worktreeCacheDirectoryDefault.value ?? '';
  state.setWorktreeCacheDirectory(worktreeCacheDirectory.value.trim());
  worktreeCacheDirectory.value = inUse;
}

function browseWorktreeCacheDirectory() {
  state.browseWorktreeCacheDirectory();
}

function restoreDefaultCacheDirectory() {
  const defaultDir = state.worktreeCacheDirectoryDefault.value;
  if (defaultDir) {
    worktreeCacheDirectory.value = defaultDir;
    state.setWorktreeCacheDirectory('');
  }
}

function openWorktree(path: string) {
  state.openWorktreePath(path);
}

// Deletion is confirmed host-side; the webview adds no second prompt.
function deleteWorktree(id: string) {
  state.removeWorktree(id);
}

// Failed removals surface through the host's worktreeError reply (the record
// is kept so the user can retry). A later *successful* removal only answers
// `worktreeRemoved`/`worktreesList`, so the message is tied to the record it
// belongs to and dropped once that record is gone: otherwise the red text
// stayed under a list that no longer contained the row.
const worktreeError = ref('');
let failedRemovalKey: string | null = null;

/** Identity of a worktree record, shared by the list and a removal error. */
function worktreeIdentityKey(identity: {
  instanceId?: string;
  owner?: string;
  repo?: string;
  prIndex?: number;
}): string | null {
  if (
    identity.instanceId === undefined ||
    identity.owner === undefined ||
    identity.repo === undefined ||
    identity.prIndex === undefined
  ) {
    return null;
  }
  return `${identity.instanceId}:${identity.owner}/${identity.repo}#${identity.prIndex}`;
}

watch(
  () => state.lastWorktreeError.value,
  (result) => {
    if (result?.operation !== 'remove') {
      return;
    }
    worktreeError.value = result.error;
    // An error the host sent without an identity (the record was already
    // unknown to it) cannot be attributed to a row, so it is left alone.
    failedRemovalKey = worktreeIdentityKey({
      instanceId: result.instanceId,
      owner: result.owner,
      repo: result.repo,
      prIndex: result.index,
    });
  },
);

watch(
  () => state.worktrees.value,
  (worktrees) => {
    if (!worktreeError.value || failedRemovalKey === null) {
      return;
    }
    // A failed removal keeps the record and re-sends the list with it; a
    // successful one drops it.
    if (!worktrees.some((worktree) => worktreeIdentityKey(worktree) === failedRemovalKey)) {
      worktreeError.value = '';
      failedRemovalKey = null;
    }
  },
);

watch(
  () => state.testConnectionResult.value,
  (result) => {
    if (!result) {
      return;
    }
    // The reply arrives once (the composable's own request timeout is already
    // cleared when it lands), so the busy flag is cleared on every path.
    testing.value = false;
    const answered = pendingTest;
    pendingTest = null;
    // The reply belongs to the form it was requested for. `target` is the stamp
    // the composable read from the request intent; an unstamped reply falls back
    // to the form this view was waiting on. A form switch in between
    // (`formGeneration` moved on) means the answer can only be stale: reporting
    // it would claim the form on screen was tested.
    const target = result.target ?? answered?.target;
    if (
      !target ||
      (answered && answered.generation !== formGeneration) ||
      saveInstanceTargetKey(target) !== saveInstanceTargetKey(formTarget.value)
    ) {
      // The test answered a form this view is no longer showing (the user
      // opened another instance, or went back to the add form) — see the
      // saveInstanceResult watcher below for the same rule.
      return;
    }
    if (result.success) {
      setStatus(t('settings.status.successConnection', { username: result.username ?? '' }), 'success');
    } else {
      setStatus(result.error ?? t('settings.status.errorConnection'), 'error');
    }
  },
);

watch(
  () => state.saveInstanceResult.value,
  (result) => {
    if (!result) {
      return;
    }
    // The reply arrives exactly once (the composable clears its request timer
    // when the reply lands, and a superseded intent is dropped before it gets
    // here), so the busy flag is reset before the target guard below: a form
    // left on "Saving…" with its submit button disabled forever would be a
    // worse bug than the status it protects.
    saving.value = false;
    // The reply answers whichever form was submitted when it was sent; the
    // user may have moved on since (opened another instance for edit, gone
    // back to the add form). Applying the *result* here would wipe the fields
    // of the form on screen and report a "saved" status for a save it never
    // sent, so a stamped reply that is not this form's is dropped.
    // `submittedTarget` is null until a form is submitted: only an unstamped
    // legacy reply is applied then.
    if (
      result.target &&
      (!submittedTarget || saveInstanceTargetKey(result.target) !== saveInstanceTargetKey(submittedTarget))
    ) {
      return;
    }
    if (result.success) {
      setStatus(t('settings.status.successSaved'), 'success');
      url.value = '';
      token.value = '';
      editingInstance.value = null;
      // The edit form just closed back to the add form.
      submittedTarget = { kind: 'new' };
    } else {
      setStatus(result.error ?? t('settings.status.errorSaved'), 'error');
    }
  },
);

watch(
  () => state.exportInstancesResult.value,
  (result) => {
    if (!result) {
      return;
    }
    if (result.success) {
      exportStatus.value = {
        message: result.path ? t('settings.exportSuccess', { path: result.path }) : t('settings.exportCopied'),
        type: 'success',
      };
    } else {
      exportStatus.value = {
        message: result.error ?? t('settings.exportError'),
        type: 'error',
      };
    }
  },
);

watch(
  () => state.importInstancesResult.value,
  (result) => {
    if (!result) {
      return;
    }
    if (result.success) {
      importStatus.value = {
        message: t('settings.importSuccess', { count: result.count ?? 0 }),
        type: 'success',
      };
      router.replace({ name: 'dashboard' });
    } else {
      importStatus.value = {
        message: result.error ?? t('settings.importError'),
        type: 'error',
      };
    }
  },
);

defineExpose({
  onTestResult(result: { success: boolean; username?: string; error?: string }) {
    testing.value = false;
    if (result.success) {
      setStatus(t('settings.status.successConnection', { username: result.username ?? '' }), 'success');
    } else {
      setStatus(result.error ?? t('settings.status.errorConnection'), 'error');
    }
  },
  onSaveResult(result: { success: boolean; error?: string }) {
    saving.value = false;
    if (result.success) {
      setStatus(t('settings.status.successSaved'), 'success');
      url.value = '';
      token.value = '';
    } else {
      setStatus(result.error ?? t('settings.status.errorSaved'), 'error');
    }
  },
});
</script>

<template>
  <div class="settings">
    <section class="setting-section">
      <h2>{{ t('settings.language') }}</h2>
      <p class="description">{{ t('settings.languageDescription') }}</p>
      <div class="form-row">
        <vscode-single-select :value="selectedLocale" :label="t('settings.language')" @change="handleLocaleChange">
          <vscode-option value="zh">{{ t('locales.zh') }}</vscode-option>
          <vscode-option value="en">{{ t('locales.en') }}</vscode-option>
        </vscode-single-select>
      </div>
    </section>

    <section class="setting-section">
      <h2>{{ t('settings.debug.title') }}</h2>
      <p class="description">{{ t('settings.debug.description') }}</p>
      <div class="form-row checkbox-row">
        <vscode-checkbox :checked="debugEnabled" @change="handleDebugChange">
          {{ t('settings.debug.enable') }}
        </vscode-checkbox>
      </div>
    </section>

    <section class="setting-section">
      <h2>{{ t('settings.worktree.title') }}</h2>
      <p class="description">{{ t('settings.worktree.description') }}</p>
      <div class="form-row">
        <label for="worktree-open-mode">{{ t('settings.worktree.openMode') }}</label>
        <vscode-single-select
          id="worktree-open-mode"
          :value="selectedWorktreeOpenMode"
          :label="t('settings.worktree.openMode')"
          @change="handleWorktreeOpenModeChange"
        >
          <vscode-option value="ask">{{ t('settings.worktree.ask') }}</vscode-option>
          <vscode-option value="newWindow">{{ t('settings.worktree.newWindow') }}</vscode-option>
          <vscode-option value="currentWindow">{{ t('settings.worktree.currentWindow') }}</vscode-option>
        </vscode-single-select>
      </div>

      <div class="form-row">
        <label for="worktree-cache-directory">{{ t('settings.worktree.cacheDirectory') }}</label>
        <vscode-textfield
          id="worktree-cache-directory"
          :value="worktreeCacheDirectory"
          :label="t('settings.worktree.cacheDirectory')"
          :placeholder="state.worktreeCacheDirectoryDefault.value ?? ''"
          @input="handleWorktreeCacheDirectoryChange"
          @change="applyWorktreeCacheDirectory"
        />
        <div class="cache-directory-actions">
          <vscode-button @click="browseWorktreeCacheDirectory" secondary>
            {{ t('settings.worktree.browse') }}
          </vscode-button>
          <vscode-button @click="restoreDefaultCacheDirectory" secondary>{{
            t('settings.worktree.restoreDefault')
          }}</vscode-button>
        </div>
      </div>

      <div v-if="state.worktrees.value.length > 0" class="worktree-list">
        <h3>{{ t('settings.worktree.savedWorktrees') }}</h3>
        <ul class="saved-list">
          <li v-for="worktree in state.worktrees.value" :key="worktree.id" class="saved-item worktree-item">
            <div class="saved-info">
              <div class="saved-name">
                {{ worktree.owner }}/{{ worktree.repo }}#{{ worktree.prIndex }} {{ worktree.prTitle }}
              </div>
              <div class="saved-url">{{ worktree.headBranch }} → {{ worktree.baseBranch }}</div>
              <div class="saved-path">{{ worktree.worktreePath }}</div>
            </div>
            <div class="worktree-actions">
              <vscode-button @click="openWorktree(worktree.worktreePath)" secondary>{{
                t('settings.worktree.open')
              }}</vscode-button>
              <vscode-button @click="deleteWorktree(worktree.id)">{{ t('settings.worktree.delete') }}</vscode-button>
            </div>
          </li>
        </ul>
      </div>
      <div v-else class="empty-list">{{ t('settings.worktree.noWorktrees') }}</div>
      <div v-if="worktreeError" class="status error">{{ worktreeError }}</div>
    </section>

    <section class="setting-section">
      <h2>{{ editingInstance ? t('settings.editInstance') : t('settings.addInstanceTitle') }}</h2>

      <div class="form-row">
        <label for="forgejo-url">{{ t('settings.instanceUrl') }}</label>
        <vscode-textfield
          id="forgejo-url"
          :value="url"
          :label="t('settings.instanceUrl')"
          :placeholder="t('settings.instanceUrlPlaceholder')"
          type="url"
          @input="url = ($event.target as HTMLInputElement).value"
        />
      </div>

      <div class="form-row">
        <label for="forgejo-token">{{ t('settings.accessToken') }}</label>
        <vscode-textfield
          id="forgejo-token"
          :value="token"
          :label="t('settings.accessToken')"
          :placeholder="
            editingInstance ? t('settings.accessTokenKeepPlaceholder') : t('settings.accessTokenPlaceholder')
          "
          type="password"
          @input="token = ($event.target as HTMLInputElement).value"
        />
        <p class="field-description">{{ t('settings.accessTokenDescription') }}</p>
        <button
          v-if="tokenSettingsUrl"
          type="button"
          class="link-button token-create-link"
          @click="state.openExternal(tokenSettingsUrl)"
        >
          {{ t('onboarding.createTokenLink') }}
        </button>
        <TokenScopeList />
      </div>

      <div class="form-row">
        <vscode-checkbox
          id="forgejo-sync-urls"
          :checked="syncApiUrlsToInstanceUrl"
          @change="syncApiUrlsToInstanceUrl = ($event.target as HTMLInputElement).checked"
        >
          {{ t('settings.syncApiUrlsToInstanceUrl.label') }}
        </vscode-checkbox>
        <p class="field-description">{{ t('settings.syncApiUrlsToInstanceUrl.description') }}</p>
      </div>

      <div class="actions">
        <vscode-button :disabled="!canSubmit || testing" @click="handleTest" secondary>
          {{ testing ? t('settings.testing') : t('settings.testConnection') }}
        </vscode-button>
        <vscode-button v-if="editingInstance" :disabled="!canSubmit || saving" @click="handleUpdate">
          {{ saving ? t('settings.saving') : t('settings.updateInstance') }}
        </vscode-button>
        <vscode-button v-else :disabled="!canSubmit || saving" @click="handleSave">
          {{ saving ? t('settings.saving') : t('settings.addInstance') }}
        </vscode-button>
        <vscode-button v-if="editingInstance" @click="cancelEdit" secondary>
          {{ t('settings.cancelEdit') }}
        </vscode-button>
      </div>

      <div v-if="status" :class="['status', statusType]">{{ status }}</div>
    </section>

    <section class="setting-section">
      <div class="section-header">
        <h2>{{ t('settings.savedInstances') }}</h2>
        <div class="section-actions">
          <vscode-button
            v-if="state.instances.value.length > 0"
            secondary
            icon="desktop-download"
            @click="handleExportInstances"
          >
            {{ t('settings.exportInstances') }}
          </vscode-button>
          <vscode-button icon="file-directory" @click="handleImportInstances" secondary>
            {{ t('settings.importInstances') }}
          </vscode-button>
        </div>
      </div>
      <div v-if="exportStatus" :class="['status', exportStatus.type]">{{ exportStatus.message }}</div>
      <div v-if="importStatus" :class="['status', importStatus.type]">{{ importStatus.message }}</div>
      <ul v-if="state.instances.value.length > 0" class="saved-list">
        <li v-for="instance in state.instances.value" :key="instance.id" class="saved-item">
          <div class="saved-info">
            <div class="saved-name">{{ instance.name }}</div>
            <div class="saved-url">{{ instance.url }}</div>
          </div>
          <div class="saved-actions">
            <vscode-button @click="startEdit(instance)" secondary>{{ t('settings.editInstance') }}</vscode-button>
            <vscode-button @click="removeInstance(instance.id)">{{ t('settings.remove') }}</vscode-button>
          </div>
        </li>
      </ul>
      <div v-else class="empty-list">{{ t('settings.noSavedInstances') }}</div>
    </section>

    <ModalDialog :open="exportDialogOpen" :title="t('settings.exportDialogTitle')" @close="cancelExport">
      <div class="export-dialog-content">
        <p class="description">{{ t('settings.exportDialogDescription') }}</p>
        <ul class="saved-list">
          <li v-for="instance in state.instances.value" :key="instance.id" class="saved-item">
            <vscode-checkbox
              :checked="selectedExportIds.has(instance.id)"
              @change="toggleExportSelection(instance, $event)"
            >
              <div class="saved-info">
                <div class="saved-name">{{ instance.name }}</div>
                <div class="saved-url">{{ instance.url }}</div>
              </div>
            </vscode-checkbox>
          </li>
        </ul>
        <div class="export-dialog-actions">
          <vscode-button @click="cancelExport" secondary>
            {{ t('settings.exportDialogCancel') }}
          </vscode-button>
          <vscode-button :disabled="selectedExportIds.size === 0" @click="copyExportToClipboard" secondary>
            {{ t('settings.copyToClipboard') }}
          </vscode-button>
          <vscode-button :disabled="selectedExportIds.size === 0" @click="confirmExport">
            {{ t('settings.exportSelected', { count: selectedExportIds.size }) }}
          </vscode-button>
        </div>
      </div>
    </ModalDialog>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 24px;
  height: 100%;
  overflow: auto;
}

.setting-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.description {
  margin: 0;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}

.field-description {
  margin: 0;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.token-create-link {
  align-self: flex-start;
  font-size: 0.85em;
}

.checkbox-row {
  flex-direction: row;
  align-items: center;
}

label {
  font-size: 0.9em;
  color: var(--vscode-foreground);
}

.cache-directory-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.status {
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 0.9em;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.status.success {
  color: var(--vscode-testing-iconPassed);
}

.status.error {
  color: var(--vscode-testing-iconFailed);
}

.saved-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.saved-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

/*
 * A saved instance URL or worktree path is arbitrarily long and `.settings` is
 * an `overflow: auto` column: without a shrinkable, wrapping text block the row
 * grows wider than the panel, adds a horizontal scrollbar and pushes the
 * Edit/Remove buttons out of view. The text block yields instead; the actions
 * keep their size.
 */
.saved-info {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.saved-actions,
.worktree-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex: 0 0 auto;
}

.saved-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.saved-url {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.saved-path {
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family), monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.worktree-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.worktree-list h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

.worktree-item {
  align-items: flex-start;
}

.empty-list {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.export-dialog-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.export-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
