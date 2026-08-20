<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAppState } from '../composables/useAppState';
import ModalDialog from '../components/ModalDialog.vue';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
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
const syncApiUrlsToInstanceUrl = ref(true);
const testing = ref(false);
const saving = ref(false);
const status = ref('');
const statusType = ref<'idle' | 'success' | 'error'>('idle');
const editingInstance = ref<ForgejoInstance | null>(null);
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

const canSubmit = computed(() => url.value.trim() && token.value.trim());

function setStatus(message: string, type: 'idle' | 'success' | 'error' = 'idle') {
  status.value = message;
  statusType.value = type;
}

function handleTest() {
  if (!canSubmit.value) {
    return;
  }
  testing.value = true;
  setStatus(t('settings.status.testing'));
  state.testConnection(url.value.trim(), token.value.trim());
}

function handleSave() {
  if (!canSubmit.value) {
    return;
  }
  saving.value = true;
  setStatus(t('settings.status.testing'));
  state.saveInstance(url.value.trim(), token.value.trim(), syncApiUrlsToInstanceUrl.value);
}

function handleUpdate() {
  if (!editingInstance.value || !canSubmit.value) {
    return;
  }
  saving.value = true;
  setStatus(t('settings.status.testing'));
  state.editInstance(editingInstance.value.id, url.value.trim(), token.value.trim(), syncApiUrlsToInstanceUrl.value);
}

function startEdit(instance: ForgejoInstance) {
  editingInstance.value = instance;
  url.value = instance.url;
  token.value = instance.token;
  syncApiUrlsToInstanceUrl.value = instance.syncApiUrlsToInstanceUrl ?? true;
  setStatus('');
}

function cancelEdit() {
  editingInstance.value = null;
  url.value = '';
  token.value = '';
  syncApiUrlsToInstanceUrl.value = true;
  setStatus('');
}

async function removeInstance(id: string) {
  const instance = state.instances.value.find((i) => i.id === id);
  if (!instance) {
    return;
  }
  const confirmed = await state.showConfirm(t('settings.removeConfirm', { name: instance.name }));
  if (confirmed) {
    state.removeInstance(id);
  }
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
  state.setWorktreeCacheDirectory(worktreeCacheDirectory.value.trim());
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
  state.openExternal(`file://${path}`);
}

function deleteWorktree(id: string) {
  state.removeWorktree(id);
}

watch(
  () => state.testConnectionResult.value,
  (result) => {
    if (!result) {
      return;
    }
    testing.value = false;
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
    saving.value = false;
    if (result.success) {
      setStatus(t('settings.status.successSaved'), 'success');
      url.value = '';
      token.value = '';
      editingInstance.value = null;
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
        <vscode-single-select :value="selectedLocale" @change="handleLocaleChange">
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
    </section>

    <section class="setting-section">
      <h2>{{ editingInstance ? t('settings.editInstance') : t('settings.addInstanceTitle') }}</h2>

      <div class="form-row">
        <label for="forgejo-url">{{ t('settings.instanceUrl') }}</label>
        <vscode-textfield
          id="forgejo-url"
          :value="url"
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
          :placeholder="t('settings.accessTokenPlaceholder')"
          type="password"
          @input="token = ($event.target as HTMLInputElement).value"
        />
        <p class="field-description">{{ t('settings.accessTokenDescription') }}</p>
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
  padding: 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.saved-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.saved-name {
  font-weight: 600;
}

.saved-url {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.saved-path {
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family), monospace;
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

.worktree-actions {
  display: flex;
  gap: 8px;
  align-items: center;
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
