<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAppState } from '../composables/useAppState';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

const { t } = useI18n();
const state = useAppState();
const router = useRouter();

const preview = computed(() => state.importPreview.value);
const selectedIds = ref<Set<string>>(new Set());

const instances = computed(() => preview.value?.instances ?? []);
const existingIds = computed(() => new Set(preview.value?.existingIds ?? []));
const existingTokens = computed(() => new Set(preview.value?.existingTokens ?? []));
const duplicatedImportedTokens = computed(() => {
  const counts = new Map<string, number>();
  for (const instance of instances.value) {
    counts.set(instance.token, (counts.get(instance.token) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [token, count] of counts) {
    if (count > 1) {
      duplicates.add(token);
    }
  }
  return duplicates;
});
const settings = computed(() => preview.value?.settings);

const currentInstancesById = computed(() => {
  const map = new Map<string, ForgejoInstance>();
  for (const instance of state.instances.value) {
    map.set(instance.id, instance);
  }
  return map;
});

function getCurrentInstance(instance: ForgejoInstance): ForgejoInstance | undefined {
  return currentInstancesById.value.get(instance.id);
}

function hasTokenConflict(instance: ForgejoInstance): boolean {
  if (duplicatedImportedTokens.value.has(instance.token)) {
    return true;
  }
  if (!existingTokens.value.has(instance.token)) {
    return false;
  }
  const current = getCurrentInstance(instance);
  if (current && current.id === instance.id && current.token === instance.token) {
    return false;
  }
  return true;
}

const allSelected = computed(
  () => instances.value.length > 0 && instances.value.every((instance) => selectedIds.value.has(instance.id)),
);

function isExisting(instance: ForgejoInstance): boolean {
  return existingIds.value.has(instance.id);
}

function toggle(instance: ForgejoInstance, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const next = new Set(selectedIds.value);
  if (checked) {
    next.add(instance.id);
  } else {
    next.delete(instance.id);
  }
  selectedIds.value = next;
}

function selectAll() {
  selectedIds.value = new Set(instances.value.map((instance) => instance.id));
}

function deselectAll() {
  selectedIds.value = new Set();
}

function handleImport() {
  const selected = instances.value.filter((instance) => selectedIds.value.has(instance.id));
  if (selected.length === 0) {
    return;
  }
  state.confirmImportInstances(selected, settings.value);
  state.importPreview.value = undefined;
  if (router) {
    router.replace({ name: 'settings' });
  }
}

function cancel() {
  state.importPreview.value = undefined;
  if (router) {
    router.replace({ name: 'settings' });
  }
}

watch(
  instances,
  () => {
    selectedIds.value = new Set(instances.value.map((instance) => instance.id));
  },
  { immediate: true },
);
</script>

<template>
  <div class="import-preview">
    <div class="import-preview-header">
      <h1 class="import-preview-title">{{ t('settings.importPreview.title') }}</h1>
      <div class="import-preview-actions">
        <vscode-button :disabled="instances.length === 0" @click="selectAll" secondary>
          {{ t('settings.importPreview.selectAll') }}
        </vscode-button>
        <vscode-button :disabled="selectedIds.size === 0" @click="deselectAll" secondary>
          {{ t('settings.importPreview.deselectAll') }}
        </vscode-button>
      </div>
    </div>

    <div v-if="instances.length === 0" class="empty-state">
      {{ t('settings.importPreview.empty') }}
    </div>

    <div v-else>
      <div v-if="settings" class="settings-summary">
        <h3 class="settings-summary-title">{{ t('settings.importPreview.settingsTitle') }}</h3>
        <ul class="settings-summary-list">
          <li v-if="settings.locale">{{ t('settings.language') }}: {{ t(`locales.${settings.locale}`) }}</li>
          <li v-if="typeof settings.debug === 'boolean'">
            {{ t('settings.debug.title') }}: {{ settings.debug ? t('settings.enabled') : t('settings.disabled') }}
          </li>
          <li v-if="settings.worktreeOpenMode">
            {{ t('settings.worktree.openMode') }}: {{ t(`settings.worktree.${settings.worktreeOpenMode}`) }}
          </li>
          <li v-if="settings.worktreeCacheDirectory">
            {{ t('settings.worktree.cacheDirectory') }}: {{ settings.worktreeCacheDirectory }}
          </li>
        </ul>
      </div>

      <div class="instance-list">
        <div v-for="instance in instances" :key="instance.id" class="instance-item">
          <vscode-checkbox :checked="selectedIds.has(instance.id)" @change="toggle(instance, $event)">
            <div class="instance-info">
              <div class="instance-header">
                <div class="instance-name">{{ instance.name }}</div>
                <span v-if="isExisting(instance)" class="instance-status existing">
                  {{ t('settings.importPreview.existing') }}
                </span>
                <span v-else class="instance-status new">{{ t('settings.importPreview.new') }}</span>
              </div>
              <div class="instance-url">{{ instance.url }}</div>
              <div v-if="isExisting(instance)" class="instance-diff">
                <template v-for="current in [getCurrentInstance(instance)]" :key="current?.id">
                  <div v-if="current && current.url !== instance.url" class="diff-line">
                    {{ t('instance.url') }}: {{ current.url }} → {{ instance.url }}
                  </div>
                  <div v-if="current && current.username !== instance.username" class="diff-line">
                    {{ t('instance.username') }}: {{ current.username }} → {{ instance.username }}
                  </div>
                  <div v-if="hasTokenConflict(instance)" class="diff-line conflict-line">
                    {{ t('settings.importPreview.tokenConflict') }}
                  </div>
                  <div v-else class="diff-line">{{ t('settings.importPreview.tokenUpdated') }}</div>
                </template>
              </div>
            </div>
          </vscode-checkbox>
        </div>
      </div>
    </div>

    <div class="import-preview-footer">
      <vscode-button @click="cancel" secondary>{{ t('settings.importPreview.cancel') }}</vscode-button>
      <vscode-button :disabled="selectedIds.size === 0" @click="handleImport">
        {{ t('settings.importPreview.importSelected', { count: selectedIds.size }) }}
      </vscode-button>
    </div>
  </div>
</template>

<style scoped>
.import-preview {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  overflow: auto;
  padding: 0 8px;
}

.import-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.import-preview-title {
  margin: 0;
  font-size: 1.1em;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.import-preview-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.empty-state {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  padding: 20px 0;
}

.instance-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.instance-item {
  display: flex;
  align-items: flex-start;
  padding: 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.instance-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-left: 8px;
}

.instance-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.instance-name {
  font-weight: 600;
  color: var(--vscode-foreground);
}

.instance-url {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.instance-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
}

.instance-status {
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 0.85em;
}

.instance-status.new {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.instance-status.existing {
  background-color: var(--vscode-warningBackground, var(--vscode-editor-inactiveSelectionBackground));
  color: var(--vscode-warningForeground, var(--vscode-foreground));
}

.instance-status.conflict {
  background-color: var(--vscode-errorBackground, var(--vscode-editor-inactiveSelectionBackground));
  color: var(--vscode-errorForeground, var(--vscode-foreground));
}

.import-preview-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: auto;
  padding-bottom: 8px;
}

.settings-summary {
  padding: 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.settings-summary-title {
  margin: 0 0 8px;
  font-size: 0.95em;
  font-weight: 600;
}

.settings-summary-list {
  margin: 0;
  padding-left: 20px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.instance-diff {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
}

.diff-line {
  word-break: break-all;
}

.conflict-line {
  color: var(--vscode-errorForeground, var(--vscode-foreground));
}
</style>
