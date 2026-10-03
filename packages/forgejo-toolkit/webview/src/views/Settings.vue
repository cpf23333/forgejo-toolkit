<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAppState, saveInstanceTargetKey, type SaveInstanceTarget } from '../composables/useAppState';
import ModalDialog from '../components/ModalDialog.vue';
import TokenScopeList from '../components/TokenScopeList.vue';
import type { ForgejoInstance } from '../types/instance';
import type { Locale } from '../i18n';
import type { AiPreReviewChatModelOption } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { stripUserinfo } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

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
// The declared server version, as typed. Empty means "no declaration, use the
// probe" — the host validates it on save and shows its own message when the
// value cannot be a version, which is why this view never drops the input.
const declaredServerVersion = ref('');
// The declaration the editor opened on: the untouched value `formDirty` compares
// against to tell "the user has typed" from "the record says none".
const openedDeclaration = ref('');

// Forgejo's token management page lives at a fixed path under the instance
// (same helper as the onboarding form). The typed URL may carry credentials
// (`https://token@host`), and a browser cannot open the masked form of it, so
// the credential is stripped from what the link opens.
const tokenSettingsUrl = computed(() => {
  const base = stripUserinfo(url.value.trim()).replace(/\/$/, '');
  return /^https?:\/\//.test(base) ? `${base}/user/settings/applications` : '';
});
const syncApiUrlsToInstanceUrl = ref(true);
const testing = ref(false);
const saving = ref(false);
const status = ref('');
const statusType = ref<'idle' | 'success' | 'error'>('idle');
// The two states of this surface, and only one of them renders at a time.
//
// The master is the instance list, which owns no fields. The detail is the
// instance editor: adding and editing are the same editor, so `editingInstance`
// alone cannot say whether it is open — it is `null` both for "adding" and for
// "the list is showing". `editorOpen` is what tells those apart.
const editingInstance = ref<ForgejoInstance | null>(null);
const editorOpen = ref(false);

// The two states' focus anchors. Both roots are plain containers with
// `tabindex="-1"`, so focusing one lets assistive technology read the heading it
// holds. The editor is the one that opens into a heading of its own: the list
// keeps the heading the user already knows.
const listRoot = useTemplateRef<HTMLElement | null>('listRoot');
const editorRoot = useTemplateRef<HTMLElement | null>('editorRoot');
// The block that sticks while the editor's fields scroll. Its measured height is
// what the scroll container has to reserve above a focused field (see
// `editorStickyHeight`).
const editorHeading = useTemplateRef<HTMLElement | null>('editorHeading');
// The list controls focus returns to — the row's own Edit button, or Add
// Instance when there is no row left to return to. Both are filled through a
// `:ref` callback (`setListTargetButton`), which is also what Vue calls with
// `null` when a row leaves the list.
const addInstanceButton = ref<HTMLElement | null>(null);
const instanceEditButtons = new Map<string, HTMLElement>();

function setListTargetButton(element: unknown, instanceId?: string): void {
  const resolved = element instanceof HTMLElement ? element : null;
  if (instanceId === undefined) {
    addInstanceButton.value = resolved;
    return;
  }
  if (resolved) {
    instanceEditButtons.set(instanceId, resolved);
  } else {
    instanceEditButtons.delete(instanceId);
  }
}

/** The `:ref` binding for a row's Edit button (and its `null` on unmount). */
function instanceEditButtonRef(instanceId: string) {
  return (element: unknown) => setListTargetButton(element, instanceId);
}

/** The `:ref` binding for the Add Instance button, which is not a row's. */
function addInstanceButtonRef(element: unknown) {
  setListTargetButton(element);
}

type FocusHandoff = {
  instanceId: string | undefined;
  attempts: number;
  frame: number | undefined;
  timeout: number | undefined;
};

let focusHandoff: FocusHandoff | null = null;

/**
 * The list control focus returns to: the row the editor was opened from, or Add
 * Instance when the editor was the new-instance mode (or the row is gone, which
 * is what a removal leaves). The list container is only the last resort — no
 * list control to return to at all.
 */
function listTarget(instanceId?: string): HTMLElement | null {
  return (instanceId ? instanceEditButtons.get(instanceId) : undefined) ?? addInstanceButton.value ?? listRoot.value;
}

/**
 * Hands focus to a list control, once the list is really back on screen.
 *
 * The handoff cannot be synchronous with the state that asks for it. A state
 * transition re-creates the list's DOM, and at the moment the state flips the
 * row's button is either the element being replaced or one the browser has not
 * laid out yet: `focus()` on it does nothing and leaves focus on `<body>`, while
 * the same element is focused normally one frame later. So the move is deferred
 * to the next frame and confirmed against `document.activeElement`.
 *
 * It is also deferred because the target can change in that frame — the list is
 * rebuilt between the state change and the paint — so every attempt re-asks for
 * the control instead of reusing the element the last attempt looked at. A
 * handoff a newer one replaces, or the view going away, cancels the pending
 * move: a focus scheduled for a surface the user has already left must never
 * pull focus back.
 */
function scheduleFocusAttempt(handoff: FocusHandoff): void {
  const run = () => {
    if (focusHandoff !== handoff) {
      return;
    }
    handoff.frame = undefined;
    handoff.timeout = undefined;
    const target = listTarget(handoff.instanceId);
    // A detached element cannot take focus, and asking one to is the silent
    // no-op this deferral exists to avoid: it would leave focus on `<body>`.
    if (target?.isConnected) {
      target.focus();
      if (document.activeElement === target) {
        focusHandoff = null;
        return;
      }
    }
    // The list is still settling (frames are also what the browser needs to make
    // a re-mounted control focusable). Three frames is generous for that and
    // still bounded, so a target that never arrives gives up rather than
    // retrying forever.
    if (handoff.attempts >= 3) {
      focusHandoff = null;
      return;
    }
    handoff.attempts += 1;
    scheduleFocusAttempt(handoff);
  };
  // A frame is what the browser runs *after* layout, which is the moment the
  // re-mounted control becomes focusable. The timeout is a fallback for an
  // environment without `requestAnimationFrame`; it is cancelled when the frame
  // runs, so the attempt happens once.
  if (typeof window.requestAnimationFrame === 'function') {
    handoff.frame = window.requestAnimationFrame(run);
    return;
  }
  handoff.timeout = window.setTimeout(run, 0);
}

function cancelFocusHandoff(): void {
  if (!focusHandoff) {
    return;
  }
  if (focusHandoff.frame !== undefined) {
    window.cancelAnimationFrame?.(focusHandoff.frame);
  }
  if (focusHandoff.timeout !== undefined) {
    window.clearTimeout(focusHandoff.timeout);
  }
  focusHandoff = null;
}

function focusListTarget(instanceId?: string): void {
  cancelFocusHandoff();
  const handoff = { instanceId, attempts: 0, frame: undefined, timeout: undefined };
  focusHandoff = handoff;
  scheduleFocusAttempt(handoff);
}

onUnmounted(() => {
  cancelFocusHandoff();
});

// ---------------------------------------------------------------------------
// The sticky identity block and the scroll container's padding above it.
//
// `.editor-heading` sticks to the top of `.settings` while the fields scroll
// under it, and `top: 0` means it also *covers* the strip it occupies. A field
// the browser scrolls into view (a focused one, or the version declaration at
// the bottom of the panel) was therefore scrolled only to the scrollport's own
// top edge and could land behind the block. `scroll-padding-top` on the scroll
// container is the CSS mechanism that makes the browser treat that strip as
// already scrolled past, and it applies to focus as well as to
// `scrollIntoView()`.
//
// The height cannot be a constant: the block carries the mode, the name and the
// URL in edit mode and only the mode in add mode, and the URL wraps at narrow
// widths, so any hard-coded value would be wrong by the amount it is wrong by —
// leaving the field partly covered (the reported 54 px) or reserving a gap
// nothing occupies. It is measured from the block itself instead, and the one
// thing that can change it — the block's own size — is what triggers the
// re-measure.
const editorStickyHeight = ref(0);

let stickyHeightObserver: ResizeObserver | null = null;

function stopObservingStickyHeight(): void {
  stickyHeightObserver?.disconnect();
  stickyHeightObserver = null;
}

/**
 * Re-reads the block's height, and (when there is a block) keeps the reader
 * attached to it. One function for both callers: the watcher that follows the
 * block in and out of the DOM, and the observer that follows a size change
 * within one mount. Re-observing the element the reader already holds is
 * harmless — a fresh observation of an unchanged box delivers nothing — so both
 * paths leave the same state behind and neither has to know which one it is.
 */
function syncEditorStickyHeight(): void {
  const heading = editorHeading.value;
  if (!heading) {
    stopObservingStickyHeight();
    editorStickyHeight.value = 0;
    return;
  }
  stickyHeightObserver?.disconnect();
  // The sticky offset is the block's border box, which is the box the observer
  // is asked for, so what is measured here is what the browser will offset by.
  // `getBoundingClientRect` is read first: the container's padding has to be
  // right for the first paint, which cannot wait for the observer's own first
  // delivery.
  editorStickyHeight.value = heading.getBoundingClientRect().height;
  if (typeof ResizeObserver !== 'function') {
    return;
  }
  stickyHeightObserver = new ResizeObserver(syncEditorStickyHeight);
  stickyHeightObserver.observe(heading, { box: 'border-box' });
}

// The block belongs to the render that opened the editor, which is what a
// post-flush watcher runs after: a pre-flush one would read a block the same
// render is still creating.
watch(editorHeading, syncEditorStickyHeight, { flush: 'post' });

onUnmounted(() => {
  stopObservingStickyHeight();
});

/**
 * One transition, stated once. Opening the editor moves focus to the editor, so
 * the heading naming the instance (or the new-instance mode) is what gets read;
 * closing it hands focus back to the list control the user came from. Both are
 * deliberately not the status region: its own live text would otherwise be the
 * last thing announced, over the view the user just arrived at.
 *
 * Watched on `editorOpen` rather than on the record: switching from one
 * instance's editor to another's keeps the editor open, so neither the focus
 * move nor the announcement should happen twice.
 */
let returnToInstanceId: string | undefined;

// `flush: 'post'`: the root it focuses is created by the same render that flipped
// the flag, so it does not exist yet when a default (pre-flush) watcher runs.
watch(
  editorOpen,
  (open, wasOpen) => {
    if (open) {
      // A handoff scheduled by the editor just left must not run while the next
      // one is on screen.
      cancelFocusHandoff();
      editorRoot.value?.focus();
      return;
    }
    if (wasOpen) {
      focusListTarget(returnToInstanceId);
    }
  },
  { flush: 'post' },
);

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
// The URL the editor was opened on, for the heading that names its subject. Read
// once when the editor opens rather than from the live field: the heading has to
// keep saying which instance is loaded while the field is being edited into a
// different URL.
const openedInstanceUrl = ref('');
// A form switch (opening an instance for edit, closing back to the list)
// invalidates every reply that was requested for the previous form. The reply
// arrives exactly once, so the busy flags are still reset on that path; only
// the *result* is dropped.
let formGeneration = 0;
// The test this view is waiting for (set by handleTest). The reply carries the
// stamp the composable read from the request intent, so this is only a
// fallback for an unstamped reply; the generation is what recognises a switch.
let pendingTest: { target: SaveInstanceTarget; generation: number } | null = null;
// Guards against a second discard prompt while one is open (the same guard as
// ModalDialog's and RepoRefs' own confirm paths).
let cancelConfirmInFlight = false;
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

/**
 * What the editor announces as its subject. The title carries the mode (the
 * same two strings the inline form's heading used); in edit mode the name and
 * the URL the editor was opened with complete it. The URL is the opened
 * record's, not the live field — the heading has to keep naming the record while
 * the field is being edited into a different one. The name comes from the record
 * and the title from whether there is one, so the heading and the submit command
 * cannot disagree about which mode the user is in.
 */
const editorTitle = computed(() =>
  editingInstance.value ? t('settings.editInstance') : t('settings.addInstanceTitle'),
);
// The new-instance editor has no record to name, so it shows no identity at all
// rather than borrowing one; the title above carries the mode on its own.
const editorSubjectName = computed(() => editingInstance.value?.name ?? '');
const editorSubjectUrl = computed(() => openedInstanceUrl.value);

/**
 * Whether the editor holds anything the list does not: the fields are not the
 * ones the editor opened with. This is the case a Cancel/Back click would throw
 * away silently. It is deliberately not "any field has been touched" — a test
 * connection fills nothing, and an untouched new-instance editor with empty
 * fields loses nothing when it closes.
 *
 * The stored token is never compared: it is not shown (the field is empty by
 * design), so "unchanged" is the only thing the field can mean.
 */
const formDirty = computed(
  () =>
    url.value !== (editingInstance.value?.url ?? '') ||
    token.value !== '' ||
    syncApiUrlsToInstanceUrl.value !== (editingInstance.value?.syncApiUrlsToInstanceUrl ?? true) ||
    declaredServerVersion.value !== openedDeclaration.value,
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

// Both modes submit from the same fields; only the label and the host command
// differ (see the submit button in the template).
function handleSubmit() {
  if (!canSubmit.value) {
    return;
  }
  const editing = editingInstance.value;
  saving.value = true;
  submittedTarget = editing ? { kind: 'instance', instanceId: editing.id } : { kind: 'new' };
  setStatus(t('settings.status.testing'));
  if (editing) {
    state.editInstance(
      editing.id,
      url.value.trim(),
      token.value.trim(),
      syncApiUrlsToInstanceUrl.value,
      declaredServerVersion.value.trim(),
    );
    return;
  }
  state.saveInstance(
    url.value.trim(),
    token.value.trim(),
    syncApiUrlsToInstanceUrl.value,
    declaredServerVersion.value.trim(),
  );
}

/**
 * Opens the editor for a row: the list stays the master and the detail becomes
 * this instance. Everything the editor shows is set here, before the state
 * flips, so the first paint of the editor is already the right instance — no
 * frame in which the heading names one record while the fields hold the
 * previous one's URL.
 */
function openEditor(instance: ForgejoInstance) {
  const target: SaveInstanceTarget = { kind: 'instance', instanceId: instance.id };
  // Where focus goes when this editor closes (see the editorOpen watcher).
  returnToInstanceId = instance.id;
  url.value = instance.url;
  // Tokens never reach the webview; leaving the field empty keeps the
  // stored token (see the editInstance host handler).
  token.value = '';
  syncApiUrlsToInstanceUrl.value = instance.syncApiUrlsToInstanceUrl ?? true;
  // Prefill the declaration the record carries; an instance that declares none
  // shows an empty field, which is exactly what "use the probe" means.
  declaredServerVersion.value = instance.declaredServerVersion ?? '';
  openedDeclaration.value = declaredServerVersion.value;
  openedInstanceUrl.value = instance.url;
  setStatus('');
  testing.value = false;
  saving.value = false;
  // The editor on screen is this instance now: a reply for a previously
  // submitted editor must not touch it (see the saveInstanceResult watcher).
  submittedTarget = target;
  // Any reply still in flight was requested for the editor just left.
  formGeneration += 1;
  pendingTest = null;
  editingInstance.value = instance;
  editorOpen.value = true;
}

/**
 * Opens the editor in its "new instance" mode: the same fields, the same
 * connection test and the same save, with nothing loaded. The heading says which
 * mode it is rather than borrowing a record's identity.
 */
function openNewEditor() {
  // Nothing to focus on the way back but the Add Instance button that opened
  // this (see the editorOpen watcher).
  returnToInstanceId = undefined;
  url.value = '';
  token.value = '';
  syncApiUrlsToInstanceUrl.value = true;
  declaredServerVersion.value = '';
  openedDeclaration.value = '';
  openedInstanceUrl.value = '';
  setStatus('');
  testing.value = false;
  saving.value = false;
  submittedTarget = null;
  // Any reply still in flight was requested for the editor just left.
  formGeneration += 1;
  pendingTest = null;
  editingInstance.value = null;
  editorOpen.value = true;
}

/**
 * Returns to the list, unconditionally and synchronously. The callers that use
 * it directly are the ones that cannot keep the editor open: the instance it was
 * bound to is gone from the list, or the save that just landed already stored
 * what was typed — so there is nothing (and no reason) to preserve. A click on
 * Back/Cancel goes through {@link requestCloseEditor} instead, which is where the
 * discard prompt lives.
 */
function closeEditor() {
  // The record goes too: the next open starts from the editor's own new-instance
  // mode, not from the identity of the instance that was just left.
  editingInstance.value = null;
  editorOpen.value = false;
  // A reply for the editor that was just left must not be applied to the fields
  // on screen any more (a submitted target, but no editor to belong to).
  submittedTarget = null;
  formGeneration += 1;
  pendingTest = null;
  url.value = '';
  token.value = '';
  syncApiUrlsToInstanceUrl.value = true;
  declaredServerVersion.value = '';
  openedDeclaration.value = '';
  openedInstanceUrl.value = '';
  testing.value = false;
  saving.value = false;
  setStatus('');
}

/**
 * The Cancel/Back control's own path: it asks before throwing typed input away.
 *
 * The prompt is `common.discardChangesConfirm`, the same one every other
 * dirty-form surface in this webview uses, and it is a *pure UI-state*
 * confirmation: no host command is involved. Destructive host commands are
 * confirmed host-side and must not be double-prompted here.
 */
async function requestCloseEditor() {
  if (formDirty.value) {
    if (cancelConfirmInFlight) {
      return;
    }
    cancelConfirmInFlight = true;
    try {
      const discard = await state.showConfirm(t('common.discardChangesConfirm'));
      if (!discard) {
        return;
      }
    } catch {
      // The prompt never answered (a dropped reply): keep the editor rather than
      // discarding what the user typed on a failed question.
      return;
    } finally {
      cancelConfirmInFlight = false;
    }
  }
  closeEditor();
}

// Removing an instance (the host re-sends `instances` after the removal) used to
// leave the edit form bound to a record that no longer exists, so its Update and
// Test buttons answered "Instance not found" (see the host's `editInstance`
// handler). The form closes together with its instance — with no discard prompt:
// the record is already gone, so no answer to the question could keep the editor
// meaningful.
watch(
  () => state.instances.value,
  (instances) => {
    const editing = editingInstance.value;
    if (editing && !instances.some((instance) => instance.id === editing.id)) {
      closeEditor();
    }
  },
);

// Removal is confirmed host-side (the host re-prompts before executing);
// the webview must not add its own confirmation.
function removeInstance(id: string) {
  if (!state.instances.value.some((i) => i.id === id)) {
    return;
  }
  // The host may remove the instance the editor is showing: the reply arrives as
  // a new `instances` list, which is what closes the editor (see the watcher
  // above). The dirty guard must not turn that into a prompt about a record that
  // no longer exists, so the list is what decides — not a click.
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

// ---------------------------------------------------------------------------
// The AI pre-review chat model chooser.
//
// The choice itself lives in `forgejoToolkit.aiPreReviewModel` and the list of
// models only exists while the extension is running (`vscode.lm.selectChatModels()`),
// which is why this is a runtime list in the panel rather than a contributed
// dropdown. The row offers exactly what the setting can store, reports what the
// write did, and says why it is empty instead of showing an empty dropdown.
// ---------------------------------------------------------------------------
const aiPreReviewModels = ref<AiPreReviewChatModelOption[]>([]);
/** The host's localized explanation for an empty list; empty when models were offered. */
const aiPreReviewModelReason = ref('');
/** What the select is showing: the configured value, or what the last write stored. */
const aiPreReviewModelValue = ref('');
/** The value the host reported as stored, so the row can say what is set right now. */
const aiPreReviewModelConfigured = ref('');
const aiPreReviewModelsLoading = ref(false);
const aiPreReviewModelSaving = ref(false);
const aiPreReviewModelStatus = ref<{ message: string; type: 'success' | 'error' } | null>(null);

/** A model's display name, falling back to its id — never to an English literal. */
function aiPreReviewModelName(model: AiPreReviewChatModelOption): string {
  return model.name.trim() !== '' ? model.name : model.id;
}

function aiPreReviewModelOptionLabel(model: AiPreReviewChatModelOption): string {
  const label = t('settings.aiPreReviewModel.optionLabel', {
    name: aiPreReviewModelName(model),
    vendor: model.vendor,
    family: model.family,
  });
  return model.value ? label : `${label} — ${t('settings.aiPreReviewModel.notStorable')}`;
}

/**
 * What one option's detail line says: where the brief would go and how much the
 * model can take. A model with no storable value gets the reason it cannot be
 * picked instead — offering it with a provider line would suggest it is a
 * choice.
 */
function aiPreReviewModelOptionDescription(model: AiPreReviewChatModelOption): string {
  if (!model.value) {
    return t('settings.aiPreReviewModel.notStorable');
  }
  return t('settings.aiPreReviewModel.optionDescription', {
    vendor: model.vendor,
    tokens: model.maxInputTokens,
  });
}

const selectedAiPreReviewModel = computed(() =>
  aiPreReviewModels.value.find((model) => model.value && model.value === aiPreReviewModelValue.value),
);

/**
 * The one fact the privacy story rests on, kept on screen while the dropdown is
 * closed: which provider a run would send the brief to.
 */
const selectedAiPreReviewModelDescription = computed(() =>
  selectedAiPreReviewModel.value ? aiPreReviewModelOptionDescription(selectedAiPreReviewModel.value) : '',
);

/**
 * A configured value that names no offered model — a stale model, or a typo. The
 * run refuses until it names one, so the row says so where the user is looking
 * rather than leaving a blank select unexplained.
 */
const aiPreReviewModelNotOffered = computed(
  () =>
    aiPreReviewModelConfigured.value !== '' &&
    !aiPreReviewModels.value.some((model) => model.value === aiPreReviewModelConfigured.value),
);

function applyAiPreReviewChoices(choices: {
  models: AiPreReviewChatModelOption[];
  configured: string;
  reason?: string;
}) {
  aiPreReviewModels.value = choices.models;
  aiPreReviewModelReason.value = choices.reason ?? '';
  aiPreReviewModelConfigured.value = choices.configured;
  aiPreReviewModelValue.value = choices.configured;
}

/**
 * Reads the offered models from the host. Run on mount and from the refresh
 * button: the set of models changes between runs (a provider signs in, an
 * extension ships a new model), so a list read once would go stale with no way
 * to ask again.
 */
async function loadAiPreReviewModels() {
  if (aiPreReviewModelsLoading.value) {
    return;
  }
  aiPreReviewModelsLoading.value = true;
  try {
    applyAiPreReviewChoices(await state.loadAiPreReviewChatModels());
  } catch (error) {
    // A dropped or unanswered request: the message is the host-backed helper's
    // own localized timeout text, so it can be shown as it is.
    aiPreReviewModelReason.value = error instanceof Error && error.message ? error.message : t('common.requestFailed');
  } finally {
    aiPreReviewModelsLoading.value = false;
  }
}

/**
 * Stores the picked value and reports what happened. The select follows the
 * host, not the click: a write that failed puts the previous value back on
 * screen beside the error, so the row never shows a choice that was not stored
 * (the same discipline as the worktree cache directory field).
 */
async function handleAiPreReviewModelChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  await storeAiPreReviewModel(target.value);
}

async function storeAiPreReviewModel(value: string) {
  if (aiPreReviewModelSaving.value || value === aiPreReviewModelValue.value) {
    return;
  }
  const previous = aiPreReviewModelValue.value;
  aiPreReviewModelSaving.value = true;
  aiPreReviewModelStatus.value = null;
  aiPreReviewModelValue.value = value;
  try {
    const result = await state.saveAiPreReviewChatModel(value);
    if (result.error) {
      aiPreReviewModelValue.value = previous;
      aiPreReviewModelStatus.value = { message: result.error, type: 'error' };
      return;
    }
    aiPreReviewModelValue.value = result.value;
    aiPreReviewModelConfigured.value = result.value;
    aiPreReviewModelStatus.value = {
      message: result.value
        ? t('settings.aiPreReviewModel.saved', { value: result.value })
        : t('settings.aiPreReviewModel.cleared'),
      type: 'success',
    };
  } catch (error) {
    aiPreReviewModelValue.value = previous;
    aiPreReviewModelStatus.value = {
      message: error instanceof Error && error.message ? error.message : t('common.requestFailed'),
      type: 'error',
    };
  } finally {
    aiPreReviewModelSaving.value = false;
  }
}

onMounted(() => {
  void loadAiPreReviewModels();
});

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
      // The save is stored, so the editor is done: it closes back to the list
      // (no discard prompt — there is nothing left to discard) and the outcome
      // is reported where the user lands.
      closeEditor();
      setStatus(t('settings.status.successSaved'), 'success');
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
      // Same landing as the `saveInstanceResult` watcher: the save is stored, so
      // the editor closes and the outcome is reported in the list state.
      closeEditor();
      setStatus(t('settings.status.successSaved'), 'success');
    } else {
      setStatus(result.error ?? t('settings.status.errorSaved'), 'error');
    }
  },
});
</script>

<template>
  <!--
    Two states, one surface: the instance list (master) or the instance editor
    (detail). Exactly one of them is rendered, so the fields always belong to a
    view that says which instance it is showing. `v-if`/`v-else` rather than two
    toggled blocks: `v-show` would leave both in the document and the editor's
    inert controls would still be reachable by Tab.
  -->
  <!--
    The sticky height the scroll container reserves above a focused field is
    measured from the block that sticks (see the observer in the script), so the
    inline custom property is what `scroll-padding-top` reads.
  -->
  <div class="settings" :style="{ '--editor-sticky-height': `${editorStickyHeight}px` }">
    <div v-if="editorOpen" ref="editorRoot" class="instance-editor" tabindex="-1">
      <!--
        The editor's subject: the heading names the instance (name and URL), so
        the fields below it cannot be mistaken for another record's. The visible
        heading is not its own live region: opening the editor moves focus here,
        and a live region would announce the subject a second time on top of
        that.
      -->
      <div ref="editorHeading" class="editor-heading">
        <h2 class="editor-title">{{ editorTitle }}</h2>
        <div v-if="editingInstance" class="editor-subject">
          <span class="editor-subject-name">{{ editorSubjectName }}</span>
          <span class="editor-subject-url-group">
            <span class="editor-subject-url">{{ editorSubjectUrl }}</span>
            <vscode-button
              class="editor-copy-url"
              icon="copy"
              icon-only
              secondary
              :title="t('settings.instanceEditor.copyUrl')"
              :aria-label="t('settings.instanceEditor.copyUrl')"
              @click="state.copyToClipboard(editorSubjectUrl)"
            />
          </span>
        </div>
        <!-- The return path is stated first, before the fields: it is where a
             user who opened the wrong row looks. -->
        <button type="button" class="link-button editor-back" @click="requestCloseEditor">
          {{ t('settings.instanceEditor.backToList') }}
        </button>
      </div>

      <div class="editor-fields">
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

        <!--
          The declared server version: the escape hatch for the automatic probe
          (a reverse proxy that blocks /api/v1/version, a fork or version string
          the probe cannot read, an unreachable instance). Left empty it keeps the
          probe; filled in it wins over the probe and the cached result, so the
          feature gates follow what the user states. The host validates it and
          answers with its own message, which the status region below shows.

          The description's version example is the host's own floor text, passed
          in as an interpolation argument: a number written into the catalog would
          be a second copy of that fact and would keep naming an old release after
          the floor moves. The placeholder is a shape hint instead of that value,
          so it does not read as "type exactly this" on an instance that is far
          newer.
        -->
        <div class="form-row">
          <label for="forgejo-declared-version">{{ t('settings.declaredServerVersion.label') }}</label>
          <vscode-textfield
            id="forgejo-declared-version"
            :value="declaredServerVersion"
            :label="t('settings.declaredServerVersion.label')"
            :placeholder="t('settings.declaredServerVersion.placeholder')"
            type="text"
            @input="declaredServerVersion = ($event.target as HTMLInputElement).value"
          />
          <p class="field-description">
            {{ t('settings.declaredServerVersion.description', { version: state.minSupportedServerVersion.value }) }}
          </p>
        </div>

        <div class="actions">
          <vscode-button :disabled="!canSubmit || testing" @click="handleTest" secondary>
            {{ testing ? t('settings.testing') : t('settings.testConnection') }}
          </vscode-button>
          <vscode-button :disabled="!canSubmit || saving" @click="handleSubmit">
            <template v-if="editingInstance">{{
              saving ? t('settings.saving') : t('settings.updateInstance')
            }}</template>
            <template v-else>{{ saving ? t('settings.saving') : t('settings.addInstance') }}</template>
          </vscode-button>
          <vscode-button @click="requestCloseEditor" secondary>{{ t('settings.instanceEditor.cancel') }}</vscode-button>
        </div>

        <!-- The Test/Save outcome is a polite live region that is always in the
             document, empty until there is something to say. Rendered together
             with its text (the old `v-if="status"`), a region that appears at the
             same moment its content does is one assistive technology is allowed
             to miss, so an async "saved" or "wrong token" was never announced. -->
        <div :class="['status', statusType]" role="status" aria-live="polite">{{ status }}</div>
      </div>
    </div>

    <div v-else ref="listRoot" class="settings-list" tabindex="-1">
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

      <!--
        The AI pre-review chat model. The list comes from the running extension
        (`vscode.lm.selectChatModels()`), so it cannot be a contributed setting's
        dropdown; picking here writes the same value the QuickPick command does.
      -->
      <section class="setting-section">
        <h2>{{ t('settings.aiPreReviewModel.title') }}</h2>
        <p class="description">{{ t('settings.aiPreReviewModel.description') }}</p>
        <div class="form-row">
          <label for="ai-pre-review-model">{{ t('settings.aiPreReviewModel.selectLabel') }}</label>
          <vscode-single-select
            id="ai-pre-review-model"
            :value="aiPreReviewModelValue"
            :label="t('settings.aiPreReviewModel.selectLabel')"
            :disabled="aiPreReviewModelSaving"
            @change="handleAiPreReviewModelChange"
          >
            <vscode-option value="">{{ t('settings.aiPreReviewModel.askEachRun') }}</vscode-option>
            <vscode-option
              v-for="model in aiPreReviewModels"
              :key="model.value ?? `${model.vendor}/${model.family}/${model.id}`"
              :value="model.value"
              :disabled="!model.value"
              :description="aiPreReviewModelOptionDescription(model)"
            >
              {{ aiPreReviewModelOptionLabel(model) }}
            </vscode-option>
          </vscode-single-select>
          <div class="ai-pre-review-model-actions">
            <vscode-button secondary icon="refresh" :disabled="aiPreReviewModelsLoading" @click="loadAiPreReviewModels">
              {{ t('settings.aiPreReviewModel.refresh') }}
            </vscode-button>
          </div>
          <p v-if="selectedAiPreReviewModelDescription" class="field-description">
            {{ selectedAiPreReviewModelDescription }}
          </p>
          <p v-if="aiPreReviewModelNotOffered" class="field-description">
            {{ t('settings.aiPreReviewModel.configuredNotOffered', { value: aiPreReviewModelConfigured }) }}
          </p>
          <p class="field-description">{{ t('settings.aiPreReviewModel.note') }}</p>
        </div>
        <div v-if="aiPreReviewModelsLoading" class="empty-list">{{ t('settings.aiPreReviewModel.loading') }}</div>
        <div v-else-if="aiPreReviewModelReason" class="empty-list">{{ aiPreReviewModelReason }}</div>
        <div
          v-if="aiPreReviewModelStatus"
          :class="['status', aiPreReviewModelStatus.type]"
          role="status"
          aria-live="polite"
        >
          {{ aiPreReviewModelStatus.message }}
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
        <div class="section-header">
          <h2>{{ t('settings.savedInstances') }}</h2>
          <div class="section-actions">
            <!--
              Adding opens the same editor editing does; it is not a form at the
              end of the list. The button is the list's own way in, and the focus
              target the editor returns to when there is no row to return to.
            -->
            <vscode-button :ref="addInstanceButtonRef" icon="add" @click="openNewEditor">
              {{ t('settings.addInstance') }}
            </vscode-button>
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
        <!-- The Save outcome lands here, where the editor closed back to. -->
        <div :class="['status', statusType]" role="status" aria-live="polite">{{ status }}</div>
        <ul v-if="state.instances.value.length > 0" class="saved-list">
          <li v-for="instance in state.instances.value" :key="instance.id" class="saved-item">
            <div class="saved-info">
              <div class="saved-name">{{ instance.name }}</div>
              <div class="saved-url">{{ instance.url }}</div>
            </div>
            <div class="saved-actions">
              <vscode-button :ref="instanceEditButtonRef(instance.id)" @click="openEditor(instance)" secondary>
                {{ t('settings.editInstance') }}
              </vscode-button>
              <vscode-button @click="removeInstance(instance.id)">{{ t('settings.remove') }}</vscode-button>
            </div>
          </li>
        </ul>
        <div v-else class="empty-list">{{ t('settings.noSavedInstances') }}</div>
      </section>
    </div>

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
/*
 * The strip the sticky identity block occupies is treated as scrolled past:
 * `scroll-padding-top` moves the scrollport's own top edge down by the block's
 * measured height, so a field brought into view — by focus, or by
 * `scrollIntoView()` — stops below the block instead of under it. Without it the
 * declared-version field at the extreme bottom of a short panel landed behind
 * the block and only scrolling up recovered it.
 *
 * The value is the block's real height, published as a custom property from the
 * template (see `editorStickyHeight`), never a constant: the block is taller in
 * edit mode than in add mode, and taller still when the URL wraps at a narrow
 * width. `0px` is the list state, which has no sticky block, and the fallback
 * for an environment where the height has not been measured yet.
 */
.settings {
  display: flex;
  flex-direction: column;
  gap: 24px;
  height: 100%;
  overflow: auto;
  scroll-padding-top: var(--editor-sticky-height, 0px);
}

/*
 * The two states are both plain columns inside `.settings`; neither is a card.
 * The separation is structural (one is rendered and the other is not), so it
 * needs no frame to be read.
 */
.settings-list,
.instance-editor {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}

/*
 * The panel's controls are fluid rather than fixed-width.
 *
 * `vscode-textfield` sets `width: 320px` on its own host (the component's
 * stylesheet, not this one), so the field held that width at every sidebar size:
 * about a pixel wider than its column at the default 358 px panel — a horizontal
 * scrollbar track for one pixel of overflow — and 320 px against a 211/161 px
 * column at 250/200 px. `width: 100%` replaces that fixed width with the
 * column's own, and `max-width: 100%` keeps the host from being widened by a
 * long value inside it.
 *
 * This is the parent-override half of the control's published API: an outer
 * `vscode-textfield { ... }` rule on the host beats the shadow `:host` rule that
 * carries the fixed width (the same override `IssueForm.vue` uses). It is stated
 * once for every field in this view — the instance URL and token, the declared
 * server version and the worktree cache directory — instead of per instance.
 *
 * `vscode-single-select` already declares `max-width: 100%` and so cannot
 * overflow, but it is left at its own 320 px when the column is wider; filling
 * the column is the coherent end state for the controls beside fluid fields. Its
 * own dropdown is sized from the host's rect, so it follows.
 */
vscode-textfield,
vscode-single-select {
  width: 100%;
  max-width: 100%;
}

/*
 * The state roots take focus so a screen reader lands on the heading they hold —
 * that is what announces the view — but neither is a control, and a ring drawn
 * around the whole editor block reads as a warning about the block rather than
 * as "you are here". It was drawn in the theme's `--vscode-focusBorder`, which is
 * yellow in a theme that keeps that colour for warnings.
 *
 * `outline: none` rather than dropping the rule, because the browser paints a
 * `:focus-visible` ring of its own on anything focusable that matches, and these
 * roots match it whenever the open was keyboard-driven: with the declaration
 * rolled back to the UA origin the focused root reports `auto 1px` (the browser's
 * ring), where the author rule reports its own `1px solid`. Stating `none` is
 * what removes both, and `:focus` is stated beside `:focus-visible` so the intent
 * is "no ring in any focus state" rather than "no ring in the state that happens
 * to paint one today".
 *
 * Nothing is lost for a keyboard user: `tabindex="-1"` keeps these roots out of
 * the tab order (they are a programmatic destination, not a Tab stop), and the
 * controls inside them keep the rings their own components draw — a
 * `vscode-button` outlines its inner element in the focus colour and
 * `vscode-textfield` turns its wrapper's border to it. That is the affordance a
 * keyboard user actually needs, and no rule here touches it.
 */
.settings-list:focus,
.settings-list:focus-visible,
.instance-editor:focus,
.instance-editor:focus-visible {
  outline: none;
}

.instance-editor {
  gap: 16px;
}

/*
 * The editor's subject is kept on screen while the fields below it are edited:
 * the block sticks to the top of the panel's scroll column, so a later field
 * (the version declaration) can be reached without losing which instance is
 * being edited. It is the heading block itself that sticks — not a second,
 * repeated strip — so the editor still has exactly one heading and the name is
 * never announced twice.
 *
 * The opaque background is what makes that safe: without it the fields would
 * scroll through the text. `--vscode-sideBar-background` is the surface this
 * webview draws on — the rest of the webview uses the same token, with the
 * body's `--vscode-editor-background` as its fallback.
 */
.editor-heading {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
}

.editor-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

/*
 * The subject: the instance the fields below belong to. Its name is the
 * prominent line; the URL sits under it with the copy control beside it, and
 * both are allowed to shrink so a long URL wraps instead of widening the panel
 * (the same rule the saved-instance rows follow).
 */
.editor-subject {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.editor-subject-name {
  font-size: 0.95em;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.editor-subject-url-group {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.editor-subject-url {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  overflow-wrap: anywhere;
}

.editor-back {
  align-self: flex-start;
  margin-top: 4px;
  font-size: 0.9em;
}

/*
 * A short panel gets the compact form of the block: the URL line and its copy
 * control are dropped, leaving the mode and the instance name — the two facts
 * that say which record the fields below belong to.
 *
 * The measured padding above cannot rescue a panel this short on its own. It
 * moves where a focused field stops, but it cannot create scroll range: at a
 * 300 px panel the scroll is already at its end when the declared-version field
 * is reached, so the field stays where the exhausted scroll leaves it — behind
 * the block. Making the block shorter is what leaves the field room, and the URL
 * is the part of the block the editor can spare: the field below still holds it
 * in full, and the control that drops it returns as soon as the panel has the
 * room again. `display: none` is deliberately used rather than removing the
 * group, so the block keeps one shape in the DOM and the copy control keeps its
 * place in the tab order only where it is drawn.
 */
@media (max-height: 420px) {
  .editor-subject-url-group {
    display: none;
  }

  .editor-heading {
    padding-bottom: 8px;
  }
}

.editor-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.setting-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/*
 * The Saved Instances header: the section's name and the three controls that act
 * on the list. Both parts have a hard minimum — the heading is text, and a
 * `vscode-button` sets `white-space: nowrap` on its label — so at the sidebar's
 * narrowest the row has to wrap rather than push the buttons past the panel edge
 * and squeeze the heading to one character per line. `min-width: 0` is what lets
 * the heading's text block shrink to the row instead of holding it wide; the
 * buttons keep their intrinsic size, so they wrap as whole controls.
 */
.section-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.section-header h2 {
  min-width: 0;
}

.section-actions {
  display: flex;
  flex-wrap: wrap;
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

/*
 * The prose blocks of this view wrap a long identifier instead of pushing the
 * panel sideways.
 *
 * A description or note that names a setting, a command or a path carries a run
 * with nowhere to break — `forgejoToolkit.aiPreReviewChooseModel` is a single
 * 195.6 px line box at this view's 0.85em — and one line box wider than the
 * column is a horizontal scrollbar on `.settings`: the AI pre-review note alone
 * made it report 196 px of scroll width against 161 px of content at a 200 px
 * panel. The same run appears in a status message (an export path is a single
 * 610 px token, wider than the default panel) and in the empty state (a host
 * reason that names a setting), so the rule is stated once for every prose block
 * on the page rather than per string.
 *
 * `overflow-wrap: anywhere` breaks a run only when it cannot fit a line of its
 * own. Ordinary prose still wraps at its spaces and is never broken mid-word; the
 * exception is the row text that is truncated on purpose below (the saved
 * instance URL and the worktree cache path), which is clipped by its own
 * `overflow: hidden` rather than wrapped, and is not part of this rule.
 */
.description,
.field-description,
.empty-list,
.status {
  overflow-wrap: anywhere;
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

/*
 * The browse/restore pair under the cache-directory field. It is the same defect
 * as the Saved Instances header at the panel's narrowest — two fixed-width
 * `vscode-button`s that cannot fit — so it wraps on the same rule.
 */
.cache-directory-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}

/*
 * The refresh button under the chat-model select — the same shape as
 * `.cache-directory-actions` (a control above, its actions on the next line),
 * kept separate so the two rows can diverge without moving one.
 */
.ai-pre-review-model-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

/*
 * Three controls in one row (Test / Save / Cancel): at the sidebar's narrowest
 * they still do not fit, so the row wraps rather than overflowing the panel —
 * the same reason the model-refresh row wraps.
 */
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.status {
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 0.9em;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

/*
 * A status region with nothing to say is not a message, and the band — padding
 * plus background — is what it has to lose while it is silent. Left painted, the
 * always-present region between the section header and the first row read as a
 * stray rounded strip or as a loading placeholder, in both places this view
 * renders one.
 *
 * It stays in the document rather than being dropped with `v-if`: a live region
 * that appears at the same moment as its first text is one assistive technology
 * is allowed to miss, which is why the region is always rendered to begin with.
 * `display: none` would be that same mistake spelled differently — a region
 * hidden at announcement time is not announced either — so the empty state is
 * taken out of the *flow* instead: `position: absolute` with no offsets keeps
 * the element rendered and in the accessibility tree, and removing it from the
 * section's flex column is what collapses the two row gaps it would otherwise
 * add between its neighbours (measured: the header-to-first-row gap goes from
 * 40 px back to the section's own 12 px). With the first message `:empty` stops
 * matching, the region returns to its normal flow and the band is back: the same
 * element measured 0x0 px and transparent while empty, and the full 319x32 px
 * band the moment a message landed in it.
 *
 * `:empty` is what tells the two apart, and it is what the real DOM gives: Vue
 * compiles `{{ status }}` to a `textContent` write, so an empty status leaves no
 * text node (and no comment anchor) behind and the region matches `:empty`
 * exactly while it holds no message.
 */
.status:empty {
  position: absolute;
  padding: 0;
  background-color: transparent;
  border-radius: 0;
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

/*
 * The row has two parts with hard minimums — the action pair is fixed-width
 * `vscode-button`s and the info column has the floor below — so at the panel's
 * narrowest they cannot share a line. The row wraps then, and the info column
 * takes the line for itself, instead of the buttons squeezing it out of
 * existence. At the default width nothing wraps (measured at 358 px: info
 * 151 px, buttons 142 px, one line), and the worktree rows — the same shape with
 * their own action pair — are covered by the same rule.
 */
.saved-item {
  display: flex;
  flex-wrap: wrap;
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
 * Edit/Remove buttons out of view.
 *
 * The block yields, but no longer all the way to nothing. The actions are the
 * only part that cannot shrink, so with `flex: 1 1 auto` and `min-width: 0` they
 * simply took the row at the narrowest panel: a 143 px content box against 142 px
 * of buttons left the info column at 0 px and only the two buttons were drawn,
 * in the instance row and in the worktree rows alike. `flex: 1 1 0` replaces the
 * block's hypothetical size — its longest URL — with nothing, which is what lets
 * the two parts share a line while they fit (with the auto basis the row's line
 * breaking pushed the actions onto their own line even in a wide panel), and the
 * floor is the width below which they cannot: the row wraps there (see
 * `.saved-item`) and the block gets the whole line.
 *
 * The floor is capped at the block's own column (`min()`) because this class is
 * shared: the export dialog puts the same marker inside a checkbox label that is
 * narrower than a row's line, and a floor that could exceed its container would
 * be a new overflow rather than a fix.
 */
.saved-info {
  flex: 1 1 0;
  min-width: min(12ch, 100%);
  overflow-wrap: anywhere;
}

/*
 * The action pair keeps its own size, its trailing edge and its own wrap. The
 * pair is what has to stay reachable, so it is the one part `flex: 0 0 auto`
 * reserves; `margin-left: auto` holds it against the row's end on the single
 * line and on the line it wraps to, where `space-between` would otherwise leave
 * it at the start; and wrapping within itself is the same treatment every other
 * row of fixed-width buttons on this page gets, so a panel too narrow for the
 * pair cannot turn into a horizontal scrollbar.
 */
.saved-actions,
.worktree-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex: 0 0 auto;
  flex-wrap: wrap;
  margin-left: auto;
}

/*
 * The name is the row's identity, so it is stated in full: it wraps instead of
 * being cut with an ellipsis, which at every panel width hid the instance the row
 * belongs to (`cpf23333@192.168.1.100:3004` is 172.7 px in the 151 px column the
 * default panel gives it, so it was always clipped). Removing the single-line
 * clipping is the whole change — the name is already breakable: it has no natural
 * break in it, and `.saved-info` above carries the `overflow-wrap: anywhere` that
 * breaks such a run, which the name inherits as a child of that column.
 *
 * The two lines below the name do not get the same treatment: a URL is short
 * enough to fit the column at every width this panel is used at, and the worktree
 * row's cache path is long enough that wrapping it costs two more lines (measured
 * at a 200 px panel: the row grows from 131 px to 157 px) on a row that is asking
 * to be scanned. Both stay single-line and truncated.
 */
.saved-name {
  font-weight: 600;
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
  /* The dialog is `min(520px, calc(100vw - 32px))` wide, so at the sidebar's
     narrowest the body is 134 px and the row below has to fit in it. */
  min-width: 0;
}

/*
 * The export dialog's rows: `vscode-checkbox` is `display: inline-block` with no
 * width of its own, so the host was sized by its content (shrink-to-fit). The
 * URL inside it is `.saved-url`, single-line and truncated on purpose in the list,
 * and a truncated line still reports its full width as the row's minimum, so the
 * box grew past the dialog body instead of the text being cut. At 200 px it
 * measured 199.7 px inside a 134 px body.
 *
 * The checkbox row is a whole-row control, so it takes the row's width and its
 * label flows inside it: the host becomes fluid, and the URL wraps like any other
 * wrapping text (`overflow-wrap: anywhere`, since a URL has no space to break at)
 * — the checkbox keeps its own box, and the user reads the whole URL rather than a
 * clipped box. Only the URL needs this now: the name is a wrapping line in the
 * list itself (see `.saved-name`), so the dialog inherits that and no longer
 * overrides it.
 */
.export-dialog-content vscode-checkbox {
  display: block;
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

.export-dialog-content .saved-url {
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  overflow-wrap: anywhere;
}

/*
 * The export dialog's foot: three fixed-width buttons, so the same narrow-width
 * wrap as the cache-directory pair. `justify-content: flex-end` keeps the last
 * row against the edge when it wraps.
 */
.export-dialog-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
