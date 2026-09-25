<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAppState } from '../composables/useAppState';
import type { ImportPreviewInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { ForgejoInstance as CurrentForgejoInstance } from '../types/instance';

const { t } = useI18n();
const state = useAppState();
const router = useRouter();

const preview = computed(() => state.importPreview.value);
const selectedIds = ref<Set<string>>(new Set());

const instances = computed(() => preview.value?.instances ?? []);
const existingIds = computed(() => new Set(preview.value?.existingIds ?? []));
// Conflict flags (stored-token collisions and in-file duplicates) are
// computed host-side (parallel to `instances`): token values never reach
// the webview, so the check cannot run here.
const tokenConflicts = computed(() => preview.value?.tokenConflicts ?? []);
const settings = computed(() => preview.value?.settings);
// The host whitelists the settings before they reach the preview
// (`sanitizeImportedSettings` in `src/webview/instanceImport.ts` keeps only
// the known locales and worktree modes), but the payload type is what an
// older host build forwarded unchecked, so `locale` cannot be trusted to be
// one this webview ships. Building the key from an unknown locale rendered
// the key itself — vue-i18n falls back to the key when the message is
// missing — so the name is looked up only for the known locales.
const KNOWN_LOCALES: readonly string[] = ['en', 'zh'];
const localeLabel = computed(() => {
  const locale = settings.value?.locale;
  return locale && KNOWN_LOCALES.includes(locale) ? t(`locales.${locale}`) : '';
});
// The host answers a corrupt/wrong-password file with `error` and empty
// arrays: that is a failure, not an empty import.
const previewError = computed(() => preview.value?.error);
// Entries the host could not use are absent from `instances`, so a preview that
// silently skipped them looked like a complete file. Absent (an older host) and
// zero both mean there is nothing to report.
const droppedCount = computed(() => preview.value?.dropped ?? 0);

/**
 * Whether the warning may carry its text yet.
 *
 * The warning is the `role="status"` region, and a region that enters the DOM
 * together with the text it announces is not reliably announced — the assistive
 * technology has to observe the region before its content changes. The count
 * only ever arrives together with the entries it belongs to, so this flag trails
 * it by one render: the region is inserted empty and its sentence follows into
 * it. `flush: 'post'` is what makes the trailing exact — it runs after the
 * render that inserted (or kept) the region.
 */
const droppedWarningReady = ref(false);
onMounted(() => {
  droppedWarningReady.value = droppedCount.value > 0;
});
watch(
  droppedCount,
  (count) => {
    droppedWarningReady.value = count > 0;
  },
  { flush: 'post' },
);

const currentInstancesById = computed(() => {
  const map = new Map<string, CurrentForgejoInstance>();
  for (const instance of state.instances.value) {
    map.set(instance.id, instance);
  }
  return map;
});

function getCurrentInstance(instance: ImportPreviewInstance): CurrentForgejoInstance | undefined {
  return currentInstancesById.value.get(instance.id);
}

function hasTokenConflict(index: number): boolean {
  return tokenConflicts.value[index] === true;
}

/**
 * The location of one instance URL: scheme, host, port, path, query and hash,
 * with any userinfo dropped.
 */
function instanceLocation(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    // `URL` re-serializes an empty path as `/`, which the redacted form goes
    // through and a raw `https://host` does not; the trailing slashes are not
    // part of the location.
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}${parsed.hash}`;
  } catch {
    // Not an absolute URL (a hand-edited file): nothing to compare by parts.
    return undefined;
  }
}

/**
 * Whether two instance URLs name the same place.
 *
 * The instance list carries a userinfo-redacted URL - `toPublicInstance` blanks
 * a stored credential to `https://***@host/...` before it crosses into the
 * webview - while the imported file holds the raw one. Comparing the strings
 * directly reported a URL change that never happened (`https://***@host` to
 * `https://token@host`), telling the user the import would repoint their
 * instance. Only the location decides, so the redacted and raw forms of one URL
 * compare equal. A value that does not parse falls back to an exact match.
 */
function sameInstanceLocation(current: string, imported: string): boolean {
  const left = instanceLocation(current);
  const right = instanceLocation(imported);
  return left !== undefined && right !== undefined ? left === right : current === imported;
}

const allSelected = computed(
  () => instances.value.length > 0 && instances.value.every((instance) => selectedIds.value.has(instance.id)),
);

function isExisting(instance: ImportPreviewInstance): boolean {
  return existingIds.value.has(instance.id);
}

function toggle(instance: ImportPreviewInstance, event: Event) {
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
  const selected = instances.value.filter((instance) => selectedIds.value.has(instance.id)).map((i) => i.id);
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
  state.cancelImportInstances();
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
      <div v-if="!previewError" class="import-preview-actions">
        <vscode-button :disabled="instances.length === 0" @click="selectAll" secondary>
          {{ t('settings.importPreview.selectAll') }}
        </vscode-button>
        <vscode-button :disabled="selectedIds.size === 0" @click="deselectAll" secondary>
          {{ t('settings.importPreview.deselectAll') }}
        </vscode-button>
      </div>
    </div>

    <div v-if="previewError" class="error-state">
      <vscode-icon name="error" />
      <span>{{ t('settings.importPreview.error', { message: previewError }) }}</span>
    </div>

    <div v-else-if="instances.length === 0" class="empty-state">
      {{ t('settings.importPreview.empty') }}
    </div>

    <div v-else>
      <!-- Above the list on purpose: the entries it names are missing from
           `instances` below, so a user counting rows sees fewer than the file
           holds and has to be told why before confirming. The warning is also
           the live region; its text is held back for one render
           (`droppedWarningReady`) so the region is in the document before the
           announcement is put into it. -->
      <div v-if="droppedCount > 0" class="dropped-warning" role="status" aria-live="polite">
        <template v-if="droppedWarningReady">
          <vscode-icon name="warning" />
          <span>{{ t('settings.importPreview.dropped', { count: droppedCount }) }}</span>
        </template>
      </div>

      <div v-if="settings" class="settings-summary">
        <h3 class="settings-summary-title">{{ t('settings.importPreview.settingsTitle') }}</h3>
        <ul class="settings-summary-list">
          <li v-if="localeLabel">{{ t('settings.language') }}: {{ localeLabel }}</li>
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
        <div v-for="(instance, index) in instances" :key="instance.id" class="instance-item">
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
                  <div v-if="current && !sameInstanceLocation(current.url, instance.url)" class="diff-line">
                    {{ t('instance.url') }}: {{ current.url }} → {{ instance.url }}
                  </div>
                  <div v-if="current && current.username !== instance.username" class="diff-line">
                    {{ t('instance.username') }}: {{ current.username }} → {{ instance.username }}
                  </div>
                  <div v-if="hasTokenConflict(index)" class="diff-line conflict-line">
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

.error-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 20px 0;
  font-size: 0.9em;
  color: var(--vscode-errorForeground, var(--vscode-foreground));
}

.instance-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dropped-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 0.85em;
  background-color: var(--vscode-warningBackground, var(--vscode-editor-inactiveSelectionBackground));
  color: var(--vscode-warningForeground, var(--vscode-foreground));
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
