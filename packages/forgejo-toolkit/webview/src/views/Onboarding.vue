<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAppState } from '../composables/useAppState';
import ImportPreview from './ImportPreview.vue';
import TokenScopeList from '../components/TokenScopeList.vue';
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
/** Why the last "import from file" attempt failed, if it did (see the watcher below). */
const importError = ref<string | undefined>(undefined);
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

// The directory new worktrees will actually go to. The store value is the one
// the host confirmed; the local field only differs while a typed path is being
// applied or was just rejected, which is why the closing summary reads this
// instead of the field (a rejected path must not be reported as in use).
const cacheDirectoryInUse = computed(
  () => state.worktreeCacheDirectory.value ?? state.worktreeCacheDirectoryDefault.value ?? '',
);

const canTest = computed(() => url.value.trim() && token.value.trim());
const canSaveInstance = computed(() => canTest.value && connectionStatusType.value === 'success');
const canFinish = computed(() => true);

// Forgejo's token management page lives at a fixed path under the instance
// root; only offer the link once the URL looks like http(s).
const tokenSettingsUrl = computed(() => {
  const base = url.value.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(base) ? `${base}/user/settings/applications` : '';
});

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

/**
 * A token can pass the host's `/user` check (and be saved) while missing the
 * read scopes the dashboard needs, which then shows "Permission denied" with no
 * repositories. The setup guide therefore probes the repositories call the
 * dashboard starts with; the status reports the missing scope instead of
 * claiming a connection that cannot show any data.
 */
const pendingVerificationUrl = ref('');
const verifiedInstanceId = ref<string | undefined>(undefined);
const verificationLoadingKey = computed(() =>
  verifiedInstanceId.value ? `repos-${verifiedInstanceId.value}` : undefined,
);
const dashboardNeedsLoading = computed(() => {
  const key = verificationLoadingKey.value;
  return key ? (state.loading.get(key) ?? false) : false;
});
const dashboardNeedsError = computed(() => {
  const key = verificationLoadingKey.value;
  return key ? state.errors.get(key) : undefined;
});
// Whether a probe is the thing those two slots describe. `verifiedInstanceId`
// outlives a probe (the status stays applied), so without this flag a later
// unrelated load of the same repositories slot would rewrite the status.
const probeActive = ref(false);
// The scope the probe needs, named for the failure text. The probe can only
// tell that listing repositories was refused; the dashboard's repository list
// is what `read:repository` gates, and the host's message carries the rest.
const missingScopeName = computed(() => t('settings.status.permissionRepository'));

/**
 * Whether a probe failure is a refusal rather than a connection problem.
 *
 * The host answers `getRepositories` with `userFacingErrorMessage(error)` — a
 * plain, already-localized sentence, with no status code on it — so a missing
 * scope can only be recognised by the wording the API error layer renders for a
 * refusal ("Permission denied. The access token may lack the required scope.").
 * A timeout, TLS or proxy failure renders as a different sentence; naming a
 * missing scope there is a claim the probe never established, and it sends the
 * user off to recreate a token that is fine. `permission` and `scope` are the
 * two technical words both locales keep (the zh bundle renders 403 as
 * "没有权限，访问令牌可能缺少所需的 scope。"), so the match does not depend on the
 * display language.
 */
const PERMISSION_REFUSAL_PATTERN =
  /permission denied|lacks the required scope|may lack the required scope|没有权限|缺少所需的 scope/i;

/** Applies the probe's outcome to the connection status. */
function reportProbeOutcome() {
  if (!probeActive.value) {
    return;
  }
  probeActive.value = false;
  const error = dashboardNeedsError.value;
  if (error) {
    // Only a refusal may be reported as a missing scope; anything else keeps
    // the host's own message under an honest headline (the save did succeed).
    setConnectionStatus(
      PERMISSION_REFUSAL_PATTERN.test(error)
        ? t('settings.status.permissionSaved', { permission: missingScopeName.value, message: error })
        : t('settings.status.probeFailed', { message: error }),
      'error',
    );
  } else {
    setConnectionStatus(t('settings.status.successSaved'), 'success');
  }
}

// The verdict is read when the load stops being busy *or* as soon as the failure
// lands: a load can start and fail between two watch runs, and a fast host may
// never be observed as busy at all.
watch(dashboardNeedsLoading, (isLoading, wasLoading) => {
  if (!isLoading && wasLoading) {
    reportProbeOutcome();
  }
});
watch(dashboardNeedsError, (error) => {
  if (error !== undefined) {
    reportProbeOutcome();
  }
});

/**
 * Starts the repositories probe for the instance the successful save just
 * created. The reply that lists the instances carries the host-assigned id,
 * which is what the probe has to be addressed to. Both the save reply and the
 * instance list push can be the event that makes the id known, so whichever
 * arrives first wins; the other falls through to reporting the save.
 */
function startDashboardNeedsProbe(): boolean {
  const url = pendingVerificationUrl.value;
  if (!url) {
    return false;
  }
  const saved = state.instances.value.find((instance) => instance.url.replace(/\/+$/, '') === url);
  const instanceId = saved?.id;
  if (instanceId === undefined) {
    return false;
  }
  pendingVerificationUrl.value = '';
  // Force: a previously probed/saved instance may still be cached, and this
  // probe is what decides whether the token is usable.
  verifiedInstanceId.value = instanceId;
  probeActive.value = true;
  state.loadRepositories(instanceId, true);
  return true;
}

/** Reports the save, starting the scope probe first when its target is known. */
function reportSavedInstance() {
  if (!startDashboardNeedsProbe()) {
    // The id is not known yet (or there is nothing to probe): say the save
    // succeeded rather than leaving the status blank. The probe still runs if
    // the instance list arrives later.
    setConnectionStatus(t('settings.status.successSaved'), 'success');
  }
}

function handleSave() {
  if (!canSaveInstance.value) {
    return;
  }
  saving.value = true;
  setConnectionStatus(t('settings.status.testing'));
  // The instance id is assigned host-side, so the scope probe below has to wait
  // for the save reply (or the instance list push) to learn it; only its url is
  // known here.
  pendingVerificationUrl.value = url.value.trim().replace(/\/+$/, '');
  state.saveInstance(url.value.trim(), token.value.trim());
}

function handleImport() {
  // A previous failure must not sit under the link while the next attempt runs.
  importError.value = undefined;
  state.previewImportInstances();
}

// Removal is confirmed host-side (the host re-prompts before executing);
// the webview must not add its own confirmation.
function handleRemoveInstance(id: string) {
  if (!state.instances.value.some((i) => i.id === id)) {
    return;
  }
  state.removeInstance(id);
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
  // The host validates the directory and answers with `worktreeCacheDirectory`
  // only when it accepted it: a rejected path gets a native error and no reply
  // at all. Put the directory that is actually in use back on screen, so a
  // rejected path cannot keep looking applied while new worktrees still go to
  // the previous one; the reply of an accepted path re-syncs the field (and the
  // "Complete" summary reads the same source).
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
      // The save only proves the token can read the account. Probe what the
      // dashboard actually needs (its first repositories call) before claiming
      // the instance is usable; the status follows once that reply lands (see
      // the verification watcher above).
      reportSavedInstance();
      url.value = '';
      token.value = '';
      connectionStatusType.value = 'idle';
    } else {
      pendingVerificationUrl.value = '';
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
        // The saved instance is only usable if its token can list repositories;
        // the verification watcher reports the outcome.
        reportSavedInstance();
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
    if (!result) {
      return;
    }
    if (result.success) {
      // Nothing to say: a successful import either moved the user to the import
      // preview (non-panel mode) or is about to close this panel below.
      if (isPanelMode) {
        postMessage({ command: 'closeOnboarding' });
      }
      return;
    }
    // The host names the concrete reason (unreadable file, wrong password, no
    // usable entries); without rendering it the click on "import from file"
    // looks like it did nothing at all.
    importError.value = result.error ?? t('settings.importError');
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
            <vscode-single-select :value="selectedLocale" :label="t('settings.language')" @change="handleLocaleChange">
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
          <div v-if="importError" class="status error" role="alert">{{ importError }}</div>

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
              :label="t('settings.instanceUrl')"
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
              :label="t('settings.accessToken')"
              :placeholder="t('settings.accessTokenPlaceholder')"
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
              :label="t('settings.worktree.openMode')"
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
              :label="t('settings.worktree.cacheDirectory')"
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
              {{ cacheDirectoryInUse || t('settings.worktree.defaultDirectory') }}
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

.token-create-link {
  align-self: flex-start;
  font-size: 0.85em;
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
