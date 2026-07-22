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
</style>
