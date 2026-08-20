<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAppState } from '../composables/useAppState';
import ImportPreview from './ImportPreview.vue';
import type { Locale } from '../i18n';
import { postMessage } from '../composables/vscode';
import '../types/config';

const { t } = useI18n();
const router = useRouter();
const state = useAppState();

const isPanelMode = window.__FORGEJO_TOOLKIT_CONFIG__?.panelMode === 'onboarding';

const step = ref(0);

const selectedLocale = ref<Locale>(state.locale.value as Locale);
const url = ref('');
const token = ref('');
const testing = ref(false);
const saving = ref(false);
const connectionStatus = ref('');
const connectionStatusType = ref<'idle' | 'success' | 'error'>('idle');
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

const canTest = computed(() => url.value.trim() && token.value.trim());
const canSaveInstance = computed(() => canTest.value && connectionStatusType.value === 'success');
const canFinish = computed(() => true);

function setConnectionStatus(message: string, type: 'idle' | 'success' | 'error' = 'idle') {
  connectionStatus.value = message;
  connectionStatusType.value = type;
}

function handleLocaleChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  selectedLocale.value = target.value as Locale;
  state.changeLocale(selectedLocale.value);
}

function handleTest() {
  if (!canTest.value) {
    return;
  }
  testing.value = true;
  setConnectionStatus(t('settings.status.testing'));
  state.testConnection(url.value.trim(), token.value.trim());
}

function handleSave() {
  if (!canSaveInstance.value) {
    return;
  }
  saving.value = true;
  setConnectionStatus(t('settings.status.testing'));
  state.saveInstance(url.value.trim(), token.value.trim());
}

function handleImport() {
  state.previewImportInstances();
}

async function handleRemoveInstance(id: string) {
  const instance = state.instances.value.find((i) => i.id === id);
  if (!instance) {
    return;
  }
  const confirmed = await state.showConfirm(t('settings.removeConfirm', { name: instance.name }));
  if (confirmed) {
    state.removeInstance(id);
  }
}

function handleWorktreeOpenModeChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  selectedWorktreeOpenMode.value = target.value as 'ask' | 'currentWindow' | 'newWindow';
  state.changeWorktreeOpenMode(selectedWorktreeOpenMode.value);
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

function nextStep() {
  if (step.value < 3) {
    step.value++;
  }
}

function prevStep() {
  if (step.value > 0) {
    step.value--;
  }
}

function finish() {
  if (isPanelMode) {
    postMessage({ command: 'closeOnboarding' });
  } else {
    router.push({ name: 'dashboard' });
  }
}

watch(
  () => state.testConnectionResult.value,
  (result) => {
    if (!result) {
      return;
    }
    testing.value = false;
    if (result.success) {
      setConnectionStatus(t('settings.status.successConnection', { username: result.username ?? '' }), 'success');
    } else {
      setConnectionStatus(result.error ?? t('settings.status.errorConnection'), 'error');
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
      setConnectionStatus(t('settings.status.successSaved'), 'success');
      url.value = '';
      token.value = '';
      connectionStatusType.value = 'idle';
    } else {
      setConnectionStatus(result.error ?? t('settings.status.errorSaved'), 'error');
    }
  },
);

watch(
  () => state.instances.value,
  () => {
    if (saving.value) {
      saving.value = false;
      if (state.instances.value.length > 0) {
        setConnectionStatus(t('settings.status.successSaved'), 'success');
      } else {
        setConnectionStatus(t('settings.status.errorSaved'), 'error');
      }
    }
  },
);

watch(
  () => state.importPreview.value,
  (preview) => {
    if (preview && !isPanelMode && router && router.currentRoute.value.name !== 'importPreview') {
      router.replace({ name: 'importPreview' });
    }
  },
);

watch(
  () => state.importInstancesResult.value,
  (result) => {
    if (result?.success && isPanelMode) {
      postMessage({ command: 'closeOnboarding' });
    }
  },
);
</script>

<template>
  <div class="onboarding">
    <template v-if="!(isPanelMode && state.importPreview.value)">
      <div class="onboarding-header">
        <h1>{{ t('onboarding.title') }}</h1>
        <p class="description">{{ t('onboarding.description') }}</p>
      </div>

      <div class="steps">
        <div
          v-for="s in 4"
          :key="s - 1"
          class="step-indicator"
          :class="{ active: step === s - 1, completed: step > s - 1 }"
        >
          {{ s }}
        </div>
      </div>

      <div class="step-content">
        <section v-if="step === 0">
          <h2>{{ t('onboarding.steps.language') }}</h2>
          <p class="description">{{ t('onboarding.languageDescription') }}</p>
          <div class="form-row">
            <vscode-single-select :value="selectedLocale" @change="handleLocaleChange">
              <vscode-option value="zh">{{ t('locales.zh') }}</vscode-option>
              <vscode-option value="en">{{ t('locales.en') }}</vscode-option>
            </vscode-single-select>
          </div>
        </section>

        <section v-else-if="step === 1">
          <h2>{{ t('onboarding.steps.server') }}</h2>
          <p class="description">{{ t('onboarding.serverDescription') }}</p>
          <p class="description import-hint">
            {{ t('onboarding.importHint') }}
            <a href="#" @click.prevent="handleImport">{{ t('onboarding.importFromFile') }}</a>
          </p>

          <div v-if="state.instances.value.length > 0" class="saved-instances">
            <h3>{{ t('settings.savedInstances') }}</h3>
            <ul class="instance-list">
              <li v-for="instance in state.instances.value" :key="instance.id" class="instance-item">
                <span class="instance-name">{{ instance.name }}</span>
                <span class="instance-url">{{ instance.url }}</span>
                <vscode-button @click="handleRemoveInstance(instance.id)" secondary>
                  {{ t('settings.remove') }}
                </vscode-button>
              </li>
            </ul>
          </div>

          <div class="form-row">
            <label for="onboarding-url">{{ t('settings.instanceUrl') }}</label>
            <vscode-textfield
              id="onboarding-url"
              :value="url"
              :placeholder="t('settings.instanceUrlPlaceholder')"
              type="url"
              @input="url = ($event.target as HTMLInputElement).value"
            />
          </div>

          <div class="form-row">
            <label for="onboarding-token">{{ t('settings.accessToken') }}</label>
            <vscode-textfield
              id="onboarding-token"
              :value="token"
              :placeholder="t('settings.accessTokenPlaceholder')"
              type="password"
              @input="token = ($event.target as HTMLInputElement).value"
            />
            <p class="field-description">{{ t('settings.accessTokenDescription') }}</p>
          </div>

          <div class="actions">
            <vscode-button :disabled="!canTest || testing" @click="handleTest" secondary>
              {{ testing ? t('settings.testing') : t('settings.testConnection') }}
            </vscode-button>
            <vscode-button :disabled="!canSaveInstance || saving" @click="handleSave">
              {{ saving ? t('settings.saving') : t('settings.addInstance') }}
            </vscode-button>
          </div>

          <div v-if="connectionStatus" :class="['status', connectionStatusType]">{{ connectionStatus }}</div>
        </section>

        <section v-else-if="step === 2">
          <h2>{{ t('onboarding.steps.worktree') }}</h2>
          <p class="description">{{ t('onboarding.worktreeDescription') }}</p>

          <div class="form-row">
            <label for="onboarding-worktree-open-mode">{{ t('settings.worktree.openMode') }}</label>
            <vscode-single-select
              id="onboarding-worktree-open-mode"
              :value="selectedWorktreeOpenMode"
              @change="handleWorktreeOpenModeChange"
            >
              <vscode-option value="ask">{{ t('settings.worktree.ask') }}</vscode-option>
              <vscode-option value="newWindow">{{ t('settings.worktree.newWindow') }}</vscode-option>
              <vscode-option value="currentWindow">{{ t('settings.worktree.currentWindow') }}</vscode-option>
            </vscode-single-select>
          </div>

          <div class="form-row">
            <label for="onboarding-worktree-cache-directory">{{ t('settings.worktree.cacheDirectory') }}</label>
            <vscode-textfield
              id="onboarding-worktree-cache-directory"
              :value="worktreeCacheDirectory"
              :placeholder="state.worktreeCacheDirectoryDefault.value ?? ''"
              @input="handleWorktreeCacheDirectoryChange"
              @change="applyWorktreeCacheDirectory"
            />
            <div class="cache-directory-actions">
              <vscode-button @click="browseWorktreeCacheDirectory" secondary>
                {{ t('settings.worktree.browse') }}
              </vscode-button>
              <vscode-button @click="restoreDefaultCacheDirectory" secondary>
                {{ t('settings.worktree.restoreDefault') }}
              </vscode-button>
            </div>
          </div>
        </section>

        <section v-else-if="step === 3">
          <h2>{{ t('onboarding.steps.complete') }}</h2>
          <p class="description">{{ t('onboarding.completeDescription') }}</p>
          <ul class="summary">
            <li>{{ t('settings.language') }}: {{ t(`locales.${selectedLocale}`) }}</li>
            <li>{{ t('settings.savedInstances') }}: {{ state.instances.value.length }}</li>
            <li>
              {{ t('settings.worktree.openMode') }}:
              {{ t(`settings.worktree.${selectedWorktreeOpenMode}`) }}
            </li>
            <li>
              {{ t('settings.worktree.cacheDirectory') }}:
              {{ worktreeCacheDirectory || t('settings.worktree.defaultDirectory') }}
            </li>
          </ul>
        </section>
      </div>

      <div class="step-actions">
        <vscode-button v-if="step > 0" secondary @click="prevStep">{{ t('onboarding.prev') }}</vscode-button>
        <vscode-button v-if="step < 3" @click="nextStep" secondary>{{ t('onboarding.next') }}</vscode-button>
        <vscode-button v-else :disabled="!canFinish" @click="finish">
          {{ t('onboarding.finish') }}
        </vscode-button>
      </div>
    </template>
    <ImportPreview v-else />
  </div>
</template>

<style scoped>
.onboarding {
  display: flex;
  flex-direction: column;
  gap: 24px;
  max-width: 600px;
  height: 100%;
  overflow: auto;
}

.onboarding-header h1 {
  margin: 0;
  font-size: 1.25rem;
}

.steps {
  display: flex;
  gap: 8px;
  align-items: center;
}

.step-indicator {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  font-size: 0.85em;
  font-weight: 600;
}

.step-indicator.active {
  background-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.step-indicator.completed {
  background-color: var(--vscode-testing-iconPassed);
  color: var(--vscode-button-foreground);
}

.step-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.step-content h2 {
  margin: 0;
  font-size: 1.1rem;
}

.description {
  margin: 0;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}

.import-hint a {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}

.import-hint a:hover {
  text-decoration: underline;
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

.form-row label {
  font-size: 0.9em;
  color: var(--vscode-foreground);
}

.saved-instances {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.saved-instances h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

.instance-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.instance-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.instance-name {
  font-weight: 600;
  flex-shrink: 0;
}

.instance-url {
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.summary {
  margin: 0;
  padding-left: 20px;
  font-size: 0.9em;
  color: var(--vscode-foreground);
}

.summary li {
  margin-bottom: 4px;
}

.step-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
