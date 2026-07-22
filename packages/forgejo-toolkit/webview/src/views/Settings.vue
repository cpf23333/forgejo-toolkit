<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { VscodeButton } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';
import { useAppState } from '../composables/useAppState';
import type { Locale } from '../i18n';

const { t } = useI18n();
const state = useAppState();

const url = ref('');
const token = ref('');
const testing = ref(false);
const saving = ref(false);
const status = ref('');
const statusType = ref<'idle' | 'success' | 'error'>('idle');
const selectedLocale = ref<Locale>(state.locale.value as Locale);
const debugEnabled = ref<boolean>(state.debug.value);
const selectedWorktreeOpenMode = ref<'currentWindow' | 'newWindow'>(state.worktreeOpenMode.value);
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
  state.saveInstance(url.value.trim(), token.value.trim());
}

function removeInstance(id: string) {
  state.removeInstance(id);
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
  const mode = target.value as 'currentWindow' | 'newWindow';
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
    } else {
      setStatus(result.error ?? t('settings.status.errorSaved'), 'error');
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
          <VscodeButton variant="secondary" @click="browseWorktreeCacheDirectory">
            {{ t('settings.worktree.browse') }}
          </VscodeButton>
          <VscodeButton variant="secondary" @click="restoreDefaultCacheDirectory">{{
            t('settings.worktree.restoreDefault')
          }}</VscodeButton>
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
              <VscodeButton variant="secondary" @click="openWorktree(worktree.worktreePath)">{{
                t('settings.worktree.open')
              }}</VscodeButton>
              <VscodeButton variant="icon" @click="deleteWorktree(worktree.id)">{{
                t('settings.worktree.delete')
              }}</VscodeButton>
            </div>
          </li>
        </ul>
      </div>
      <div v-else class="empty-list">{{ t('settings.worktree.noWorktrees') }}</div>
    </section>

    <section class="setting-section">
      <h2>{{ t('settings.addInstanceTitle') }}</h2>

      <div class="form-row">
        <label for="forgejo-url">{{ t('settings.instanceUrl') }}</label>
        <vscode-textfield
          id="forgejo-url"
          v-model="url"
          :placeholder="t('settings.instanceUrlPlaceholder')"
          type="url"
        />
      </div>

      <div class="form-row">
        <label for="forgejo-token">{{ t('settings.accessToken') }}</label>
        <vscode-textfield
          id="forgejo-token"
          v-model="token"
          :placeholder="t('settings.accessTokenPlaceholder')"
          type="password"
        />
      </div>

      <div class="actions">
        <VscodeButton variant="secondary" :disabled="!canSubmit || testing" @click="handleTest">
          {{ testing ? t('settings.testing') : t('settings.testConnection') }}
        </VscodeButton>
        <VscodeButton variant="primary" :disabled="!canSubmit || saving" @click="handleSave">
          {{ saving ? t('settings.saving') : t('settings.addInstance') }}
        </VscodeButton>
      </div>

      <div v-if="status" :class="['status', statusType]">{{ status }}</div>
    </section>

    <section v-if="state.instances.value.length > 0" class="setting-section">
      <h2>{{ t('settings.savedInstances') }}</h2>
      <ul class="saved-list">
        <li v-for="instance in state.instances.value" :key="instance.id" class="saved-item">
          <div class="saved-info">
            <div class="saved-name">{{ instance.name }}</div>
            <div class="saved-url">{{ instance.url }}</div>
          </div>
          <VscodeButton variant="icon" @click="removeInstance(instance.id)">{{ t('settings.remove') }}</VscodeButton>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.setting-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
</style>
