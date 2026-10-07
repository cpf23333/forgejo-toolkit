<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppState } from '../composables/useAppState';
import type {
  AiImportPreviewProvider,
  ImportAiConflictStrategy,
  ImportPreviewInstance,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { ForgejoInstance as CurrentForgejoInstance } from '../types/instance';

const { t } = useI18n();
const state = useAppState();

/**
 * How this surface wants leaving to go, and where its return control is drawn.
 *
 * Where leaving goes is a fact about the page that showed the preview, not about
 * the preview: the settings tab returns to its own list, in the group it was
 * opened from (`docs/design/settings-page.md` §9.4 rule 3, §10.6), while the setup
 * wizard returns to the step it came from. What a surface may also want is a
 * question first, and only the settings tab's host answers one (`showConfirm`) —
 * a confirmation offered from here would be a question the wizard's panel never
 * answers.
 *
 * So the surface is handed the two facts only this component has — `dirty` (has
 * the reader chosen anything here?) and `leave` (the one exit, below) — and decides
 * what happens. Every way out of this component goes through it, so leaving means
 * the same thing wherever it is asked from. A surface that passes nothing gets the
 * plain exit: that is the wizard, whose Cancel is already its way back and whose
 * panel has no modal question at all.
 */
const props = defineProps<{
  requestLeave?: (dirty: boolean, leave: () => void) => void;
}>();

/**
 * The surface's return control, drawn where this component puts it — under the
 * title, before the list, the place both editor states state their own way back.
 * The control belongs to the surface because its destination and its wording do,
 * and because the page's own return-control styling only reaches markup the page
 * renders.
 */
defineSlots<{
  'return-path'?: (props: { leave: () => void }) => unknown;
}>();

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
// The file's AI endpoint section. Absent means the file carries none (an older
// host build, or a `version: 1`/`2` payload): the block is then not rendered at
// all, which is the honest statement — there is nothing to show and nothing to
// decide.
const aiConfig = computed(() => preview.value?.ai);
const aiProviders = computed(() => aiConfig.value?.providers ?? []);
/**
 * Whether the **file** is encrypted, which is the envelope's own flag and not the
 * presence of a `secrets` block.
 *
 * The two are different questions: the exporter only writes `secrets` inside the
 * encrypted wrapper, but a hand-written or hostile plaintext file can carry that
 * block too — and import is exactly where a file from elsewhere enters. Reading
 * "encrypted" off `secretsIncluded` therefore called such a file encrypted, which is
 * the defect `docs/design/ai-model-transport.md` §10.2 now records; an absent flag
 * reads as "not encrypted" rather than as "assume encrypted".
 */
const fileIsEncrypted = computed(() => preview.value?.encrypted === true);
/**
 * Per-provider collision decision, keyed by the id the **file** declared.
 *
 * `keep` is the default for an entry whose id is already configured: it is the
 * only one of the three that changes nothing on this machine, and the preview
 * therefore starts on it. The host reads an absent strategy the same way, so the
 * two cannot disagree.
 */
const aiChoices = ref<Record<string, ImportAiConflictStrategy>>({});
function aiChoice(provider: AiImportPreviewProvider): ImportAiConflictStrategy {
  return aiChoices.value[provider.id] ?? 'keep';
}
function setAiChoice(provider: AiImportPreviewProvider, event: Event) {
  const strategy = (event.target as HTMLSelectElement).value as ImportAiConflictStrategy;
  aiChoices.value = { ...aiChoices.value, [provider.id]: strategy };
}
/** The endpoints this file will actually write, for the confirmation summary. */
const aiConflictCount = computed(() => aiProviders.value.filter((provider) => provider.existing).length);
const aiUnusableCount = computed(() => aiProviders.value.filter((provider) => provider.unusable !== undefined).length);
const aiInsecureCount = computed(() => aiProviders.value.filter((provider) => provider.insecure === true).length);

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

/**
 * The preview is rendered **in place** now, by whichever surface asked for it
 * (`Settings.vue` inside the settings tab, `Onboarding.vue` inside the wizard
 * panel), and clearing `state.importPreview` is what closes it: there is no route
 * to go back to. The sidebar's `importPreview` route retired with the settings
 * route it was reached from (`docs/design/settings-page.md` §9.3), which is also
 * why this component no longer reaches for a router at all — it is now in a
 * panel bundle, where `vue-router` must not appear (`webview/vite.config.mts`).
 */
function handleImport() {
  const selected = instances.value.filter((instance) => selectedIds.value.has(instance.id)).map((i) => i.id);
  if (selected.length === 0) {
    return;
  }
  state.confirmImportInstances(selected, settings.value, aiChoices.value);
  state.importPreview.value = undefined;
}

/**
 * Whether leaving now would throw away something the reader chose here.
 *
 * The arriving state is "every instance selected" (the watcher below) with every
 * conflict question on `keep` — the answer that changes nothing — so a preview the
 * reader has not touched holds nothing of their own, and the surface's return
 * control can stay silent on the ordinary way out. It is the same shape as the two
 * editors' `formDirty`/`providerDraftDirty`, and the same reason: the question is
 * asked only when there is really something to lose.
 *
 * The imported file's settings and AI endpoints are not part of it: they are all
 * on screen, and a preview that arrived with them has already shown them.
 */
const previewDirty = computed(
  () =>
    selectedIds.value.size !== instances.value.length ||
    Object.values(aiChoices.value).some((strategy) => strategy !== 'keep'),
);

/**
 * The exit itself: the host drops the stash it kept for the file (the entries with
 * their tokens, and the AI section) and the state that renders this component is
 * cleared, which is what brings the surface that asked for the preview back.
 *
 * It is the one place the preview is left, and both ways out reach it — the footer's
 * Cancel and the surface's own return control, through {@link requestLeavePreview} —
 * because leaving has to mean the same thing wherever it is asked for. The other way
 * the preview closes is a confirmation (`handleImport` above), which is the host
 * *consuming* the stash rather than dropping it; a close that did neither would leave
 * the file's credentials in the host's memory with no preview left to use them from.
 */
function leavePreview() {
  state.cancelImportInstances();
  state.importPreview.value = undefined;
}

/**
 * What every exit does: ask the surface how leaving should go, and leave the plain
 * way when the surface wants no say in it (see the prop above).
 */
function requestLeavePreview() {
  if (props.requestLeave) {
    props.requestLeave(previewDirty.value, leavePreview);
    return;
  }
  leavePreview();
}

/**
 * The preview's own focus anchor, for the same reason the settings page gives one
 * to its list and to each editor (`Settings.vue`): the state that replaces the
 * page takes focus, so assistive technology reads the heading it holds, and a
 * keyboard user lands inside the preview instead of on `<body>` — which is what
 * makes the return control one Tab away rather than a hunt through the document.
 * `tabindex="-1"` keeps it out of the tab order; it is a destination, not a stop.
 */
const previewRoot = useTemplateRef<HTMLElement | null>('previewRoot');
onMounted(() => previewRoot.value?.focus());

watch(
  instances,
  () => {
    selectedIds.value = new Set(instances.value.map((instance) => instance.id));
  },
  { immediate: true },
);
</script>

<template>
  <div ref="previewRoot" class="import-preview" tabindex="-1">
    <div class="import-preview-header">
      <div class="import-preview-heading">
        <h1 class="import-preview-title">{{ t('settings.importPreview.title') }}</h1>
        <!--
          The way back, drawn by the surface that showed the preview (see the slot
          contract above). It sits under the title, before the list — the same
          place the two editor states put their own return path, because it is
          where a reader who opened the wrong file looks.
        -->
        <slot name="return-path" :leave="requestLeavePreview" />
      </div>
      <div v-if="!previewError" class="import-preview-actions">
        <vscode-button :disabled="instances.length === 0" @click="selectAll" secondary>
          {{ t('settings.importPreview.selectAll') }}
        </vscode-button>
        <vscode-button :disabled="selectedIds.size === 0" @click="deselectAll" secondary>
          {{ t('settings.importPreview.deselectAll') }}
        </vscode-button>
      </div>
    </div>

    <!--
      The three states below are the middle of the preview; the list state carries
      its own scrollport (see the stylesheet), so the heading above — with the way
      back in it — and the footer below, with Cancel and Import, are drawn where
      they are read rather than at the ends of a long list.
    -->
    <div v-if="previewError" class="error-state">
      <vscode-icon name="error" />
      <span>{{ t('settings.importPreview.error', { message: previewError }) }}</span>
    </div>

    <div v-else-if="instances.length === 0" class="empty-state">
      {{ t('settings.importPreview.empty') }}
    </div>

    <div v-else class="import-preview-body">
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

      <!-- The file's AI endpoints, above the instance list and before the import
           button, because importing is what points this machine's content at an
           address the file chose. An id already configured is a decision here
           rather than a silent overwrite; a plain http:// address is named here
           rather than only when a request is finally attempted. -->
      <div v-if="aiConfig && aiProviders.length > 0" class="ai-summary">
        <h3 class="settings-summary-title">{{ t('settings.importPreview.ai.title') }}</h3>
        <p class="ai-note">{{ t('settings.importPreview.ai.policyNote') }}</p>
        <!-- Two independent facts, one sentence each: whether credentials are in the
             file (`aiConfig.secretsIncluded`) decides the branch — credentials present
             is a plain note, credentials absent is the warning that says how to add
             them — and whether the file is **encrypted** (`fileIsEncrypted`) only
             picks the wording inside that branch. The encryption claim therefore
             always matches the payload: a plaintext file with a `secrets` block is
             described as a plaintext file that carries credentials. -->
        <p v-if="aiConfig.secretsIncluded" class="ai-note">
          {{
            t(
              fileIsEncrypted
                ? 'settings.importPreview.ai.secretsIncluded'
                : 'settings.importPreview.ai.secretsIncludedPlaintext',
              { count: aiProviders.length },
            )
          }}
        </p>
        <p v-else class="ai-note ai-note-warning">
          <vscode-icon name="warning" />
          <span>{{
            t(
              fileIsEncrypted ? 'settings.importPreview.ai.noSecretsEncrypted' : 'settings.importPreview.ai.noSecrets',
              { count: aiProviders.length },
            )
          }}</span>
        </p>
        <p v-if="aiInsecureCount > 0" class="ai-note ai-note-warning">
          <vscode-icon name="warning" />
          <span>{{ t('settings.importPreview.ai.insecure', { count: aiInsecureCount }) }}</span>
        </p>
        <ul class="ai-list">
          <li v-for="provider in aiProviders" :key="provider.id" class="ai-item">
            <div class="ai-header">
              <span class="ai-name">{{ provider.name }}</span>
              <span class="ai-id">{{ provider.id }}</span>
              <span class="instance-status" :class="provider.existing ? 'existing' : 'new'">
                {{ provider.existing ? t('settings.importPreview.existing') : t('settings.importPreview.new') }}
              </span>
            </div>
            <div class="ai-url">{{ provider.baseUrl }}</div>
            <div class="ai-meta">
              <span>{{ t('settings.importPreview.ai.modelCount', { count: provider.models.length }) }}</span>
              <span v-if="provider.headers.length > 0">{{
                t('settings.importPreview.ai.headerNames', { names: provider.headers.join(', ') })
              }}</span>
            </div>
            <div v-if="provider.unusable" class="ai-unusable">
              {{ t('settings.importPreview.ai.unusable', { reason: provider.unusable }) }}
            </div>
            <div v-else-if="provider.existing" class="ai-conflict">
              <label :for="`ai-conflict-${provider.id}`">{{ t('settings.importPreview.ai.conflict') }}</label>
              <select
                :id="`ai-conflict-${provider.id}`"
                :value="aiChoice(provider)"
                @change="setAiChoice(provider, $event)"
              >
                <option value="keep">{{ t('settings.importPreview.ai.keep') }}</option>
                <option value="rename">{{ t('settings.importPreview.ai.rename') }}</option>
                <option value="replace">{{ t('settings.importPreview.ai.replace') }}</option>
              </select>
            </div>
          </li>
        </ul>
        <p v-if="aiConfig.bindings.length > 0" class="ai-note">
          {{ t('settings.importPreview.ai.bindings', { count: aiConfig.bindings.length }) }}
        </p>
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
      <vscode-button @click="requestLeavePreview" secondary>{{ t('settings.importPreview.cancel') }}</vscode-button>
      <vscode-button :disabled="selectedIds.size === 0" @click="handleImport">
        {{ t('settings.importPreview.importSelected', { count: selectedIds.size }) }}
      </vscode-button>
    </div>
  </div>
</template>

<style scoped>
/*
 * Three parts, one scroller: the heading (with the way back in it), the middle
 * state, and the footer (Cancel and Import). Only the middle one scrolls — see
 * `.import-preview-body` below — so both ends stay where they are read.
 */
.import-preview {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  /* The fallback scroller: only the error and empty states can outgrow the box,
     and the instance list scrolls in `.import-preview-body` instead. */
  overflow: auto;
  padding: 0 8px;
}

/*
 * The list state's own scrollport, so a long file cannot push the heading (with the
 * way back in it) or the footer (Cancel and Import) off the screen: a preview used
 * to be one scrolling column whose only visible exit, in a long list, was the end of
 * that list. `min-height: 0` is what lets it shrink below its content and scroll at
 * all inside the column.
 *
 * There is deliberately no sticky block and no `scroll-padding-top`: nothing
 * overlays this box, so a control the browser scrolls into view (a checkbox reached
 * by Tab) cannot land behind anything — the failure the settings page's own measured
 * `--editor-sticky-height` exists to prevent.
 */
.import-preview-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

/*
 * The root is a programmatic destination, not a control: it takes focus on mount
 * so the heading is what a screen reader reads (see `previewRoot` in the script),
 * and it paints no ring of its own. The same rule, for the same reason, is stated
 * for the settings page's list and editor roots.
 */
.import-preview:focus,
.import-preview:focus-visible {
  outline: none;
}

.import-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* The title and the return path under it, the shape both editor headings have. */
.import-preview-heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
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
  /* In the error and empty states the list is absent, so this is what keeps the
     two exits at the bottom edge; when the list is there it takes the free space
     and the auto margin has nothing to claim. */
  margin-top: auto;
  padding-bottom: 8px;
}

.settings-summary {
  padding: 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.ai-summary {
  padding: 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.ai-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.ai-note-warning {
  color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
}

.ai-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.ai-item {
  padding: 6px 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
}

.ai-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-name {
  font-weight: 600;
}

.ai-id {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.ai-url {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  word-break: break-all;
}

.ai-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
}

.ai-conflict {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 0.85em;
}

.ai-unusable {
  margin-top: 4px;
  font-size: 0.8em;
  color: var(--vscode-errorForeground, var(--vscode-foreground));
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
