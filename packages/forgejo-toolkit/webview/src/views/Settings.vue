<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted, onUnmounted, nextTick, useTemplateRef, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppState, saveInstanceTargetKey, type SaveInstanceTarget } from '../composables/useAppState';
import ModalDialog from '../components/ModalDialog.vue';
import AiTestReport from '../components/AiTestReport.vue';
import TokenScopeList from '../components/TokenScopeList.vue';
import ImportPreview from './ImportPreview.vue';
import { DEFAULT_SETTINGS_GROUP, SETTINGS_GROUPS, WIDE_NAV_MIN_WIDTH, type SettingsGroupId } from './settingsGroups';
import type { ForgejoInstance } from '../types/instance';
import type { Locale } from '../i18n';
import type {
  AiPreReviewChatModelOption,
  AiProviderDraftProbe,
  AiProviderEditorEntry,
  AiProviderTestReport,
  SettingsSurfaceSnapshot,
  SettingsSurfaceWritableKey,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import {
  AI_PRE_REVIEW_PROMPT_SCOPES,
  AI_TRANSPORT_CHOICES,
  PR_DESCRIPTION_PROMPT_SCOPES,
  stripUserinfo,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { inspectAiProviderBaseUrl } from '@cpf23333-forgejo-toolkit/shared/ai/providerPolicy';
import { generateAiProviderId, generateAiProviderName, uniqueAiProviderId } from '../utils/providerIdentity';

/**
 * The two settings that used to live in VS Code's own settings editor and are
 * rendered by this page now (`docs/design/settings-page.md` §1.3, §3.2):
 * `forgejoToolkit.notificationPollingInterval` as a bounded number field in the
 * notification section, and `forgejoToolkit.useMockApi` as a developer switch in
 * the 通用 group. Nothing is left to the native editor, so this page no longer
 * prints a setting id and no longer has a "more settings" pointer row (§2.2).
 *
 * They are spelled as full setting ids in `shared/webview/messages.ts`, not here:
 * the id is the key the write goes through, and the page's own label for each is
 * the catalogue entry named after it (`settings["forgejoToolkit.…"]`).
 */

const { t } = useI18n();
const state = useAppState();

// ---------------------------------------------------------------------------
// Where the page lives, and what that costs it.
//
// The page is an editor-area tab now (`docs/design/settings-page.md` §9.3), not
// one of the sidebar router's views: the sidebar's settings route was retired
// with it, so this component installs no router and reaches none — which is what
// makes it mountable from a panel bundle, where `vue-router` must not appear
// (`webview/vite.config.mts`, `src/__tests__/entryGraph.test.ts`).
//
// The one thing the route used to do for this page was show the **import
// preview** (the sidebar's `importPreview` view), which is why this page watched
// `state.importPreview` and pushed a route. The tab has nowhere to push to, so
// the preview is rendered **in place**, exactly as the setup wizard's panel does
// with its own (`views/Onboarding.vue`): the template picks one of the two, and
// the preview clears `state.importPreview` when it is done, which brings the
// settings page back. One copy of the preview, in the surface that asked for it.
// ---------------------------------------------------------------------------

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
// The endpoint editor is the second detail state. It is declared here rather than
// beside the rest of the endpoint state because the focus watcher below reads it,
// and hoisting the flag keeps every editor's transition in one place.
const providerEditorOpen = ref(false);

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
// The list controls focus returns to. The page has two master–detail pairs — the
// instance list/editor and the endpoint list/editor — so a target says which pair
// it belongs to as well as which row; the import preview is the third detail state
// and returns to the one control that opens it. Every target is filled through a
// `:ref` callback (`setListTargetButton`), which is also what Vue calls with `null`
// when a row leaves the list.
type ListReturnTarget =
  | { kind: 'instance'; id: string }
  | { kind: 'provider'; id: string }
  | { kind: 'addInstance' }
  | { kind: 'addProvider' }
  | { kind: 'importInstances' };

const addInstanceButton = ref<HTMLElement | null>(null);
const addProviderButton = ref<HTMLElement | null>(null);
const importInstancesButton = ref<HTMLElement | null>(null);
const instanceEditButtons = new Map<string, HTMLElement>();
const providerEditButtons = new Map<string, HTMLElement>();

function setListTargetButton(element: unknown, target: ListReturnTarget): void {
  const resolved = element instanceof HTMLElement ? element : null;
  if (target.kind === 'addInstance') {
    addInstanceButton.value = resolved;
    return;
  }
  if (target.kind === 'addProvider') {
    addProviderButton.value = resolved;
    return;
  }
  if (target.kind === 'importInstances') {
    importInstancesButton.value = resolved;
    return;
  }
  const buttons = target.kind === 'instance' ? instanceEditButtons : providerEditButtons;
  if (resolved) {
    buttons.set(target.id, resolved);
  } else {
    buttons.delete(target.id);
  }
}

/** The `:ref` binding for a row's Edit button (and its `null` on unmount). */
function instanceEditButtonRef(instanceId: string) {
  return (element: unknown) => setListTargetButton(element, { kind: 'instance', id: instanceId });
}

/** The `:ref` binding for the Add Instance button, which is not a row's. */
function addInstanceButtonRef(element: unknown) {
  setListTargetButton(element, { kind: 'addInstance' });
}

/** The `:ref` binding for an endpoint row's Edit button. */
function providerEditButtonRef(providerId: string) {
  return (element: unknown) => setListTargetButton(element, { kind: 'provider', id: providerId });
}

/** The `:ref` binding for the Add Endpoint button. */
function addProviderButtonRef(element: unknown) {
  setListTargetButton(element, { kind: 'addProvider' });
}

/** The `:ref` binding for the Import button, which opens the import preview. */
function importInstancesButtonRef(element: unknown) {
  setListTargetButton(element, { kind: 'importInstances' });
}

type FocusHandoff = {
  target: ListReturnTarget | undefined;
  attempts: number;
  frame: number | undefined;
  timeout: number | undefined;
};

let focusHandoff: FocusHandoff | null = null;

/**
 * The list control focus returns to: the row the editor was opened from, the
 * control that opened the import preview, or the section's own Add button when the
 * editor was the new-record mode (or the row is gone, which is what a removal
 * leaves). The list container is only the last resort — no list control to return
 * to at all.
 */
function listTarget(target: ListReturnTarget | undefined): HTMLElement | null {
  if (target?.kind === 'instance') {
    return instanceEditButtons.get(target.id) ?? addInstanceButton.value ?? listRoot.value;
  }
  if (target?.kind === 'provider') {
    return providerEditButtons.get(target.id) ?? addProviderButton.value ?? listRoot.value;
  }
  if (target?.kind === 'addProvider') {
    return addProviderButton.value ?? listRoot.value;
  }
  if (target?.kind === 'importInstances') {
    return importInstancesButton.value ?? listRoot.value;
  }
  return addInstanceButton.value ?? listRoot.value;
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
    const target = listTarget(handoff.target);
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

function focusListTarget(target: ListReturnTarget | undefined): void {
  cancelFocusHandoff();
  const handoff = { target, attempts: 0, frame: undefined, timeout: undefined };
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

/**
 * The page's own measured width, and the shape it decides
 * (`docs/design/settings-page.md` §9.3).
 *
 * The page carries two navigation shapes: a vertical list beside the content
 * when there is room for two columns, and a group selector in the sticky bar at
 * the top when there is not. The measurement is the same one the sticky height
 * comes from — **one** `ResizeObserver`, two readings (§9.3's "复用页面已经有的
 * 那次尺寸观察，不新开第二个观察者"); a second observer watching the same box
 * twice is exactly the "two sources for one fact" this page avoids everywhere
 * else.
 *
 * The width is read from the page's scroll root, which exists in **all three**
 * states — that is what keeps the shape from flipping back and forth when an
 * editor opens or closes, and what makes it readable while the endpoint editor
 * is open.
 */
const pageWidth = ref(0);

/** Which shape the page is in: the two-column one, or the one-column fallback. */
const wideNav = computed(() => pageWidth.value >= WIDE_NAV_MIN_WIDTH);

/** The page's scroll root: the box the width is read from, and the scrollport. */
const settingsRoot = useTemplateRef<HTMLElement | null>('settingsRoot');
/**
 * The narrow shape's sticky bar: the group selector. In the wide shape there is
 * no sticky block in the list state at all — the navigation is a column *beside*
 * the content, so nothing can cover a field — and while an editor is open the
 * editor's own heading is the sticky block.
 */
const paneBar = useTemplateRef<HTMLElement | null>('paneBar');

let stickyHeightObserver: ResizeObserver | null = null;

function stopObservingStickyHeight(): void {
  stickyHeightObserver?.disconnect();
  stickyHeightObserver = null;
}

/**
 * Re-reads both numbers, and keeps the one reader attached to both boxes. One
 * function for every caller: the watcher that follows the sticky block and the
 * scroll root in and out of the DOM, and the observer that follows a size change
 * within one mount. Re-observing a box the reader already holds is harmless — a
 * fresh observation of an unchanged box delivers nothing — so both paths leave
 * the same state behind and neither has to know which one it is.
 */
function syncStickyMetrics(): void {
  const root = settingsRoot.value;
  // The page's width, not the content column's: the threshold is about whether
  // a second column fits inside the page at all.
  pageWidth.value = root ? root.getBoundingClientRect().width : 0;
  // The block that sticks: the editor's identity block while one of the two
  // editors is open, the group bar in the narrow list state, and nothing in the
  // wide list state. Its border box is the sticky offset, which is the box the
  // observer is asked for, so what is measured here is what the browser will
  // offset by. `getBoundingClientRect` is read first: the container's padding has
  // to be right for the first paint, which cannot wait for the observer's own
  // first delivery.
  const block = editorHeading.value ?? paneBar.value;
  editorStickyHeight.value = block ? block.getBoundingClientRect().height : 0;

  stickyHeightObserver?.disconnect();
  stickyHeightObserver = null;
  if (typeof ResizeObserver !== 'function') {
    return;
  }
  stickyHeightObserver = new ResizeObserver(syncStickyMetrics);
  if (root) {
    stickyHeightObserver.observe(root, { box: 'border-box' });
  }
  if (block) {
    stickyHeightObserver.observe(block, { box: 'border-box' });
  }
}

// The block belongs to the render that created it, which is what a post-flush
// watcher runs after: a pre-flush one would read a block the same render is
// still creating. The scroll root is watched for the same reason and because it
// is the only one of the three that exists in **every** state: without it, the
// list state would never read the width at all.
watch([settingsRoot, editorHeading, paneBar], syncStickyMetrics, { flush: 'post' });

onUnmounted(() => {
  stopObservingStickyHeight();
});

// ---------------------------------------------------------------------------
// The group navigation (`docs/design/settings-page.md` §9.2, §9.3, §9.4).
//
// The page's eleven blocks are divided into six groups, and the group is a
// **view** of the list state, not a page state: all six panes stay mounted and
// the inactive ones carry `hidden` + `inert`. That is deliberate and it is the
// one thing §9.4 rule 1 insists on — `hidden` takes a pane out of the tab order
// as well as off the screen, so nothing inside an inactive group is reachable,
// while the controls themselves stay in the document. The page's own suites
// mount it once and query controls across groups (they have to: the whole point
// of the drift guard and of `Settings.settingsSurface.test.ts` is that every
// setting is rendered), and a design that unmounted the inactive groups would
// turn those checks into no-ops rather than failures.
//
// The two editors are page states, not groups. They keep their own single sticky
// heading and carry **no** navigation: an editor is opened from one group and
// holds fields the user may have typed into, so a group control inside it would
// have to either throw those fields away or sit there doing nothing. What the
// page owes instead is the return: the group is not touched while an editor is
// open, so closing one lands back in the group it was opened from, and the
// existing focus handoff then puts focus on the row's own Edit button — the two
// halves of §9.4 rule 3, and both of them structural rather than an extra
// mechanism.
//
// No group is remembered across a close (§9.4 rule 5): the tab is a new page
// when it is reopened, so this ref starts at the default every time.
// ---------------------------------------------------------------------------

/** The group the page is showing. Session state of this tab, and nothing more. */
const currentGroup = ref<SettingsGroupId>(DEFAULT_SETTINGS_GROUP);

/** The ids that join a group's navigation control to the pane it controls. */
function groupTabId(group: SettingsGroupId): string {
  return `settings-group-tab-${group}`;
}

function groupPanelId(group: SettingsGroupId): string {
  return `settings-group-panel-${group}`;
}

/** Whether one group is the one on screen. Used for `hidden` / `inert` and `aria-selected`. */
function isCurrentGroup(group: SettingsGroupId): boolean {
  return currentGroup.value === group;
}

/**
 * The vertical tab list's own elements, for the roving tabindex.
 *
 * Only the selected tab is a Tab stop (`tabindex="0"`), the rest are `-1`, which
 * is what the pattern asks for on a tablist: Tab enters the list once, and the
 * arrow keys move within it. Filled through a `:ref` callback, which Vue also
 * calls with `null` when the tab leaves the DOM (the wide shape is left).
 */
const groupTabs = new Map<SettingsGroupId, HTMLElement>();

function setGroupTab(group: SettingsGroupId, element: unknown): void {
  if (element instanceof HTMLElement) {
    groupTabs.set(group, element);
    return;
  }
  groupTabs.delete(group);
}

/** Shows one group. The only writer of `currentGroup`. */
function selectGroup(group: SettingsGroupId): void {
  currentGroup.value = group;
}

/** The narrow shape's selector, inside the sticky bar. */
function handleGroupSelect(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as SettingsGroupId;
  if (SETTINGS_GROUPS.some((group) => group.id === value)) {
    selectGroup(value);
  }
}

/**
 * The vertical tab list's keyboard model: `↑` / `↓` / `Home` / `End` move, and
 * the group follows immediately (the "automatic activation" half of the tab
 * pattern, which is what VS Code's own settings navigation does — arrowing
 * through the list shows each group as it is reached). `Enter` and `Space` need
 * no case here: they are a real `<button>`'s own activation, so the click
 * handler runs for them without this function being involved.
 */
function handleGroupKeydown(event: KeyboardEvent, group: SettingsGroupId): void {
  const index = SETTINGS_GROUPS.findIndex((entry) => entry.id === group);
  if (index < 0) {
    return;
  }
  const last = SETTINGS_GROUPS.length - 1;
  let next: number;
  switch (event.key) {
    case 'ArrowDown':
      next = index === last ? 0 : index + 1;
      break;
    case 'ArrowUp':
      next = index === 0 ? last : index - 1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = last;
      break;
    default:
      return;
  }
  event.preventDefault();
  const target = SETTINGS_GROUPS[next];
  selectGroup(target.id);
  // Focus follows activation, so the tab the user reached is the one a screen
  // reader reads — and the next arrow key starts from there.
  void nextTick(() => groupTabs.get(target.id)?.focus());
}

/**
 * One transition, stated once. Opening an editor moves focus to it, so the heading
 * naming the record (or the new-record mode) is what gets read; closing it hands
 * focus back to the list control the user came from. Both are deliberately not the
 * status region: its own live text would otherwise be the last thing announced,
 * over the view the user just arrived at.
 *
 * Watched on the two `…EditorOpen` flags rather than on the record: switching from
 * one instance's editor to another's keeps the editor open, so neither the focus
 * move nor the announcement should happen twice.
 */
let returnToListTarget: ListReturnTarget | undefined;

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
      focusListTarget(returnToListTarget);
    }
  },
  { flush: 'post' },
);

// The endpoint editor is the second master–detail pair, and it follows the same
// transition: focus enters on the heading, and leaving hands it back to the row (or
// to Add Endpoint when there is no row to return to).
watch(
  providerEditorOpen,
  (open, wasOpen) => {
    if (open) {
      cancelFocusHandoff();
      editorRoot.value?.focus();
      return;
    }
    if (wasOpen) {
      focusListTarget(returnToListTarget);
    }
  },
  { flush: 'post' },
);

/**
 * The import preview is the page's third detail state, and it follows the same
 * transition as the two editors.
 *
 * Its "heading" is inside `ImportPreview.vue`, which takes focus for itself on
 * mount, so the open half here only has to drop a handoff the state it replaces
 * may have left pending. The close half is the point: leaving the preview — by the
 * return control it is given (`requestLeaveImportPreview`), by its Cancel, or by a
 * successful import — hands focus back to the Import button that opened it.
 *
 * The group needs nothing here, and that is the design: nothing writes
 * `currentGroup` while the preview is on screen, so "back to the group the reader
 * came from" is the same structural fact §9.4 rule 3 relies on for the editors.
 * Focus and group are one move, not two mechanisms.
 */
watch(
  () => state.importPreview.value,
  (open, wasOpen) => {
    if (open) {
      cancelFocusHandoff();
      return;
    }
    if (wasOpen) {
      focusListTarget(returnToListTarget);
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
  returnToListTarget = { kind: 'instance', id: instance.id };
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
  returnToListTarget = { kind: 'addInstance' };
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
  // Where focus goes when the preview closes (see the `importPreview` watcher).
  // Recorded here, by the control that opens the state, exactly as `openEditor`
  // records the row it was opened from.
  returnToListTarget = { kind: 'importInstances' };
  state.previewImportInstances();
}

/**
 * The import preview's own return path, as the page's third detail state
 * (`docs/design/settings-page.md` §9.4 rule 3, §10.6).
 *
 * It is the editors' path: the click asks before throwing away what the reader has
 * not applied, keeps the state when they decline, and hands focus back to the
 * control that opened it (the watcher above). It is given to `ImportPreview` as its
 * `requestLeave`, so every way out of the preview — this page's return control and
 * the preview's own Cancel — is this one function, the way `Cancel Edit` and the
 * instance editor's Back are both `requestCloseEditor`.
 *
 * `dirty` is the preview's own answer to "has the reader chosen anything here?"
 * (which instances are selected, and each endpoint's conflict answer); the file
 * itself cannot be kept alive — leaving drops the host's stash, credentials and all
 * — which is why the guard is on the reader's choices and why the prompt is the
 * page's one discard sentence rather than a second wording for the same question.
 */
let importPreviewCancelInFlight = false;

async function requestLeaveImportPreview(dirty: boolean, leave: () => void) {
  if (dirty) {
    if (importPreviewCancelInFlight) {
      return;
    }
    importPreviewCancelInFlight = true;
    try {
      const discard = await state.showConfirm(t('common.discardChangesConfirm'));
      if (!discard) {
        return;
      }
    } catch {
      // The prompt never answered (a dropped reply): keep the preview rather than
      // discarding the reader's choices on a failed question.
      return;
    } finally {
      importPreviewCancelInFlight = false;
    }
  }
  leave();
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

// ---------------------------------------------------------------------------
// The settings this page presents itself (`docs/design/settings-page.md` §3.2,
// §3.5).
//
// Every setting in the surface snapshot gets a control here, and every one of them
// is read from, and written through, the host: the page never keeps a value of its
// own, and the host's answer to a write is the host's fresh reading of the state,
// so a control that a refused write bounced back shows what is stored rather than
// what was clicked. The snapshot also says which configuration **level** each
// effective value came from; where that is not the user's own level, the control
// carries a note saying so, because a write from this page would not take effect
// there. The one thing the page does keep is a *mirror* per control, because a
// `vscode-checkbox` toggles itself on click: the mirror is what the click sets
// optimistically, and the host's next reading is what puts it right again.
// ---------------------------------------------------------------------------

/** The host's last reading, or `undefined` until it answers. */
const settingsSurface = computed(() => state.settingsSurface.value);
/** What the host's own sentence about the last write is, and which setting it was about. */
const settingsSurfaceStatus = ref<{
  key: SettingsSurfaceWritableKey;
  message: string;
  type: 'success' | 'error';
} | null>(null);
/** The page-level read failure, when the nine settings could not be read at all. */
const settingsSurfaceLoadError = ref('');

const pollingEnabled = ref(false);
/**
 * The polling interval, in the two shapes the field needs: the number the host
 * reports (what the poller is using, and what a save's own comparison is about)
 * and the text the field holds while the user types. The text is a draft, not a
 * value: it is only read when the field's own Save control is pressed, and the
 * host's reading is what the next snapshot puts back (`docs/design/settings-page.md`
 * §3.2, and the timeout field's identical pair).
 */
const pollingIntervalSeconds = ref(300);
const pollingIntervalField = ref('300');
/** `forgejoToolkit.useMockApi`: the developer switch, off by default. */
const useMockApi = ref(false);
const mcpEnabledValue = ref(false);
const writeToolCreateIssueComment = ref(false);
const writeToolSubmitPullReview = ref(false);
const writeToolCancelActionRun = ref(false);
const mcpAuditToFile = ref(false);
const leaseEnabled = ref(false);
/**
 * The whole AI area's own switch, above every per-feature switch
 * (`docs/design/ai-model-transport.md` §8.3). It is one of the page's own
 * settings rather than part of the endpoint snapshot: the page has to be able to
 * write it, and the section it lives in says what being off means.
 */
const aiEnabled = ref(false);
const preReviewEnabled = ref(false);
/**
 * The stored prompt scope. The fallback is the host's own reading rule for a
 * value it cannot read (`ask`, the question) rather than a default of this page:
 * `aiPreReviewPromptScopeSettingValue` answers `ask` for anything unusable, so
 * the page cannot show a scope the run would not use.
 */
const promptScope = ref<SettingsSurfaceSnapshot['aiPreReviewPromptScope']>('ask');

/**
 * The PR-description feature's own switch and stored scope, with the same fallback
 * rule as the pair above: the host answers `ask` for any value it cannot read, so
 * the page cannot show a scope the run would not use, and the switch shows the
 * host's reading rather than a default of this page.
 */
const prDescriptionEnabled = ref(false);
const prDescriptionPromptScope = ref<SettingsSurfaceSnapshot['prDescriptionPromptScope']>('ask');

/**
 * Whether the host has reported at least once. Until it has, the controls are
 * disabled rather than showing a value the page invented: a switch whose stored
 * state is unknown must not look like a switch that is off.
 */
const settingsSurfaceReady = computed(() => settingsSurface.value !== undefined);
const settingsSurfaceSaving = ref<SettingsSurfaceWritableKey | null>(null);

/** The settings of one section, so only the section being written is disabled. */
const NOTIFICATION_SURFACE_KEYS: readonly SettingsSurfaceWritableKey[] = [
  'forgejoToolkit.notificationPollingEnabled',
  'forgejoToolkit.notificationPollingInterval',
  'forgejoToolkit.multiWindowLease',
];

/** The developer section's own setting: the switch is the whole of it. */
const DEVELOPER_SURFACE_KEYS: readonly SettingsSurfaceWritableKey[] = ['forgejoToolkit.useMockApi'];

const MCP_SURFACE_KEYS: readonly SettingsSurfaceWritableKey[] = [
  'forgejoToolkit.mcpEnabled',
  'forgejoToolkit.mcpWriteTools.createIssueComment',
  'forgejoToolkit.mcpWriteTools.submitPullReview',
  'forgejoToolkit.mcpWriteTools.cancelActionRun',
  'forgejoToolkit.mcpWriteAuditToFile',
];

const AI_SURFACE_KEYS: readonly SettingsSurfaceWritableKey[] = ['forgejoToolkit.aiEnabled'];

const PRE_REVIEW_SURFACE_KEYS: readonly SettingsSurfaceWritableKey[] = [
  'forgejoToolkit.aiPreReview',
  'forgejoToolkit.aiPreReviewPromptScope',
];

const PR_DESCRIPTION_SURFACE_KEYS: readonly SettingsSurfaceWritableKey[] = [
  'forgejoToolkit.prDescription',
  'forgejoToolkit.prDescriptionPromptScope',
];

/**
 * Whether one section's controls are waiting on a write.
 *
 * The gate is per section rather than one flag for the whole page: a write is a
 * `WorkspaceConfiguration.update` round trip, and greying out an unrelated switch
 * while it lands would claim the page is busy when only one of its controls is.
 */
function surfaceBusy(keys: readonly SettingsSurfaceWritableKey[]): boolean {
  const saving = settingsSurfaceSaving.value;
  return saving !== null && keys.includes(saving);
}

watch(
  settingsSurface,
  (snapshot) => {
    if (!snapshot) {
      return;
    }
    pollingEnabled.value = snapshot.notificationPollingEnabled;
    // The field is only overwritten when the interval the host reports actually
    // changed: another control's write must not discard text the user is typing
    // here, and a refused interval write leaves the host's reading where it was —
    // so the user's own input survives to be corrected (`§3.3` rule 1).
    if (snapshot.notificationPollingInterval !== pollingIntervalSeconds.value) {
      pollingIntervalSeconds.value = snapshot.notificationPollingInterval;
      pollingIntervalField.value = String(snapshot.notificationPollingInterval);
    }
    useMockApi.value = snapshot.useMockApi;
    mcpEnabledValue.value = snapshot.mcpEnabled;
    writeToolCreateIssueComment.value = snapshot.mcpWriteTools.createIssueComment;
    writeToolSubmitPullReview.value = snapshot.mcpWriteTools.submitPullReview;
    writeToolCancelActionRun.value = snapshot.mcpWriteTools.cancelActionRun;
    mcpAuditToFile.value = snapshot.mcpWriteAuditToFile;
    leaseEnabled.value = snapshot.multiWindowLease;
    aiEnabled.value = snapshot.aiEnabled;
    preReviewEnabled.value = snapshot.aiPreReview;
    promptScope.value = snapshot.aiPreReviewPromptScope;
    prDescriptionEnabled.value = snapshot.prDescription;
    prDescriptionPromptScope.value = snapshot.prDescriptionPromptScope;
  },
  { immediate: true },
);

/** Reads the settings the page's own sections present from the host once, when the page mounts. */
async function loadSettingsSurface(): Promise<void> {
  try {
    await state.loadSettingsSurface();
  } catch (error) {
    // A failed read leaves every one of those controls disabled and says so
    // once, in the header: the page cannot show what it was never told, and one
    // separate "could not be read" line per control would be several copies of
    // one fact.
    settingsSurfaceLoadError.value = t('settings.header.loadFailed', { error: errorText(error) });
  }
}

/**
 * Writes one setting through the host and reports what the host said.
 *
 * A refused or failed write is a sentence beside the section, and the control —
 * which renders the host's reading, not the click — is already back on the value
 * that is stored. The page adds no interpretation of its own to the host's
 * sentence (§3.3 rule 3).
 */
async function saveSettingsSurfaceValue(
  key: SettingsSurfaceWritableKey,
  value: boolean | string | number,
): Promise<void> {
  if (settingsSurfaceSaving.value !== null) {
    return;
  }
  settingsSurfaceSaving.value = key;
  settingsSurfaceStatus.value = null;
  try {
    const answer = await state.setSettingsSurfaceValue(key, value);
    if (answer.error) {
      settingsSurfaceStatus.value = { key, message: answer.error, type: 'error' };
    }
  } catch (error) {
    settingsSurfaceStatus.value = { key, message: errorText(error), type: 'error' };
  } finally {
    settingsSurfaceSaving.value = null;
  }
}

/**
 * The last write's sentence, when it was about one of these settings. A message
 * is rendered by the section it belongs to and nowhere else: the host's sentence
 * names the setting, and a failure of the MCP switch printed under the
 * notification section would be a second puzzle rather than a report.
 */
function surfaceStatusIn(keys: readonly SettingsSurfaceWritableKey[]) {
  const status = settingsSurfaceStatus.value;
  return status && keys.includes(status.key) ? status : null;
}

const notificationsSurfaceStatus = computed(() => surfaceStatusIn([...NOTIFICATION_SURFACE_KEYS]));

const developerSurfaceStatus = computed(() => surfaceStatusIn(DEVELOPER_SURFACE_KEYS));

const mcpSurfaceStatus = computed(() =>
  surfaceStatusIn([
    'forgejoToolkit.mcpEnabled',
    'forgejoToolkit.mcpWriteTools.createIssueComment',
    'forgejoToolkit.mcpWriteTools.submitPullReview',
    'forgejoToolkit.mcpWriteTools.cancelActionRun',
    'forgejoToolkit.mcpWriteAuditToFile',
  ]),
);

/** The AI switch's own section: its write's sentence is rendered there and nowhere else. */
const aiSurfaceStatus = computed(() => surfaceStatusIn(AI_SURFACE_KEYS));

const preReviewSurfaceStatus = computed(() =>
  surfaceStatusIn(['forgejoToolkit.aiPreReview', 'forgejoToolkit.aiPreReviewPromptScope']),
);

const prDescriptionSurfaceStatus = computed(() =>
  surfaceStatusIn(['forgejoToolkit.prDescription', 'forgejoToolkit.prDescriptionPromptScope']),
);

function handlePollingEnabledChange(event: Event): void {
  pollingEnabled.value = (event.target as HTMLInputElement).checked;
  void saveSettingsSurfaceValue('forgejoToolkit.notificationPollingEnabled', pollingEnabled.value);
}

/**
 * Writes the polling interval the field holds, in seconds.
 *
 * The field is typed rather than toggled, so this is the only place the draft is
 * read — and it is read as a **number**, the shape `writeSettingsSurfaceValue`
 * validates against the manifest's own range. An empty field is `0` there
 * (`Number('')`), which is below the manifest's `minimum` and is refused as out
 * of range like any other value outside it, so the page never has to say what an
 * empty box means; it states the range below the field and leaves the refusal to
 * the host (`§3.3` rules 1 and 3).
 */
function savePollingInterval(): void {
  void saveSettingsSurfaceValue(
    'forgejoToolkit.notificationPollingInterval',
    Number(pollingIntervalField.value.trim()),
  );
}

/**
 * Flips the developer mock switch. It is a page-owned setting like the rest: the
 * host writes the user level and answers with its fresh reading, so the checkbox
 * can never show a state that was not stored.
 */
function handleUseMockApiChange(event: Event): void {
  useMockApi.value = (event.target as HTMLInputElement).checked;
  void saveSettingsSurfaceValue('forgejoToolkit.useMockApi', useMockApi.value);
}

function handleMcpEnabledChange(event: Event): void {
  mcpEnabledValue.value = (event.target as HTMLInputElement).checked;
  void saveSettingsSurfaceValue('forgejoToolkit.mcpEnabled', mcpEnabledValue.value);
}

type McpWriteToolSwitch = 'createIssueComment' | 'submitPullReview' | 'cancelActionRun';

/** The full setting id of one write tool, from the container key §5 of the MCP record uses. */
const WRITE_TOOL_SETTING_IDS: Readonly<Record<McpWriteToolSwitch, SettingsSurfaceWritableKey>> = {
  createIssueComment: 'forgejoToolkit.mcpWriteTools.createIssueComment',
  submitPullReview: 'forgejoToolkit.mcpWriteTools.submitPullReview',
  cancelActionRun: 'forgejoToolkit.mcpWriteTools.cancelActionRun',
};

const writeToolValues: Readonly<Record<McpWriteToolSwitch, Ref<boolean>>> = {
  createIssueComment: writeToolCreateIssueComment,
  submitPullReview: writeToolSubmitPullReview,
  cancelActionRun: writeToolCancelActionRun,
};

function handleWriteToolChange(tool: McpWriteToolSwitch, event: Event): void {
  const target = writeToolValues[tool];
  target.value = (event.target as HTMLInputElement).checked;
  void saveSettingsSurfaceValue(WRITE_TOOL_SETTING_IDS[tool], target.value);
}

function handleMcpAuditChange(event: Event): void {
  mcpAuditToFile.value = (event.target as HTMLInputElement).checked;
  void saveSettingsSurfaceValue('forgejoToolkit.mcpWriteAuditToFile', mcpAuditToFile.value);
}

function handleLeaseChange(event: Event): void {
  leaseEnabled.value = (event.target as HTMLInputElement).checked;
  void saveSettingsSurfaceValue('forgejoToolkit.multiWindowLease', leaseEnabled.value);
}

function handleAiEnabledChange(event: Event): void {
  aiEnabled.value = (event.target as HTMLInputElement).checked;
  void saveSettingsSurfaceValue('forgejoToolkit.aiEnabled', aiEnabled.value);
}

function handlePreReviewEnabledChange(event: Event): void {
  preReviewEnabled.value = (event.target as HTMLInputElement).checked;
  void saveSettingsSurfaceValue('forgejoToolkit.aiPreReview', preReviewEnabled.value);
}

/**
 * Stores the prompt scope. The five values come from the shared enumeration the
 * host reads and writes with, so the page cannot offer one the host would refuse
 * (§3.2); a value that could not be stored leaves the select on the host's own
 * reading, beside the host's sentence.
 */
function handlePromptScopeChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as SettingsSurfaceSnapshot['aiPreReviewPromptScope'];
  promptScope.value = value;
  void saveSettingsSurfaceValue('forgejoToolkit.aiPreReviewPromptScope', value);
}

/**
 * The page's own wording for one scope: shorter than the manifest's
 * `enumDescriptions`, and synonymous with it (`docs/design/settings-page.md`
 * §3.2). The five labels exist in both catalogues for every value of the shared
 * enumeration — `Settings.settingsSurface.test.ts` holds the two lists together,
 * which is what a `v-for` over that enumeration needs to stay honest.
 */
function promptScopeLabel(scope: SettingsSurfaceSnapshot['aiPreReviewPromptScope']): string {
  return t(`settings.aiPreReview.scopeOption.${scope}`);
}

/**
 * The PR-description feature's own switch and scope.
 *
 * A second pair rather than a reuse of the pre-review's, because the two features
 * send different content at different moments (`docs/design/ai-model-transport.md`
 * §7.6): the page mirrors what the host reads, and the host reads two settings.
 */
function handlePrDescriptionEnabledChange(event: Event): void {
  prDescriptionEnabled.value = (event.target as HTMLInputElement).checked;
  void saveSettingsSurfaceValue('forgejoToolkit.prDescription', prDescriptionEnabled.value);
}

/**
 * Stores the PR-description scope, from the same shared enumeration the host reads
 * and writes with — so the page cannot offer a value the host would refuse, and
 * cannot offer the pre-review's values, which mean something else here.
 */
function handlePrDescriptionScopeChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as SettingsSurfaceSnapshot['prDescriptionPromptScope'];
  prDescriptionPromptScope.value = value;
  void saveSettingsSurfaceValue('forgejoToolkit.prDescriptionPromptScope', value);
}

/** The page's own wording for one PR-description scope, per the shared enumeration. */
function prDescriptionScopeLabel(scope: SettingsSurfaceSnapshot['prDescriptionPromptScope']): string {
  return t(`settings.prDescription.scopeOption.${scope}`);
}

/**
 * Opens VS Code's own settings editor, filtered to this extension (§2.1).
 *
 * One action for the page header **and for every source note**: the host runs the
 * `forgejoToolkit.openNativeSettings` command, which is the same command the
 * palette offers, and the filter is part of it. A note's reader has to go and
 * change the workspace copy of a setting, so it is the same destination the page
 * header opens — there is no second entry point to keep in step.
 */
function openNativeSettings(): void {
  state.openNativeSettings();
}

/**
 * The configuration level a setting's effective value comes from, when that level
 * is **not** the user's own (`docs/design/settings-page.md` §3.5), or `undefined`
 * when this page's own writes are in charge.
 *
 * The page writes the user level and renders the effective value, so a workspace
 * value beats anything written here: without this note a click on such a control
 * looks like it did nothing. The host's snapshot says which level each value came
 * from, and this turns "above the user level" into the two strings a note needs —
 * the level's own name and its sentence. `workspace` is the only such level left:
 * the host reads without a resource URI, where a workspace-folder value never
 * appears, so that level is not in the type at all (§3.5). `aiEnabled` is the one
 * control on the page with no note: the manifest scopes it to `machine`, so the
 * host never reports a workspace level for it and markup that can never appear
 * would be a rule pretending to be one.
 *
 * The map is read as a **required** field. `readSettingsSurface` fills an entry
 * for every writable key, so a reading that carries none is a host bug rather
 * than a page state: an optional chain here turned exactly that bug into a page
 * that quietly rendered no markers at all. The type is what makes such a reading
 * not compile, and this read is what makes one that arrives anyway fail loudly
 * instead of silently unmarking every overridden control.
 */
function sourceOverride(key: SettingsSurfaceWritableKey): { level: string; sentence: string } | undefined {
  const source = settingsSurface.value?.sources[key];
  if (source === 'workspace') {
    return { level: t('settings.source.level.workspace'), sentence: t('settings.source.overrides.workspace') };
  }
  return undefined;
}

/**
 * Reads everything this page renders, from the host.
 *
 * One function because there are two occasions for it: the mount, and the tab
 * being shown again (`docs/design/settings-page.md` §9.3 — a tab that is still
 * alive must not come back holding the snapshot it read before it was hidden).
 * The host pushes `refreshSettings` when it becomes visible again, and what the
 * page does with it is exactly what it does on mount: ask. The reply to each
 * request is the host's reading, so the page never keeps a value of its own
 * across the gap.
 */
function reloadSettingsPage(): void {
  void loadAiPreReviewModels();
  void loadProviderSettings();
  void loadSettingsSurface();
}

onMounted(() => {
  reloadSettingsPage();
});

watch(
  () => state.settingsRefreshTick.value,
  () => {
    reloadSettingsPage();
  },
);

// ---------------------------------------------------------------------------
// The AI endpoints: the list (master) and the endpoint editor (detail).
//
// The section follows the instance list's pattern rather than inventing a second
// one: the list is the master, adding and editing are the same editor, the editor
// is a state of the page rather than a form inside a row, and closing it hands
// focus back to the row it was opened from. The endpoint editor's own fields are
// grouped the way the record groups them (`docs/design/ai-model-transport.md`
// §8.1): identity, address, the model declaration, the custom header **names**, and
// then the secrets — which are the only fields whose values never travel back.
// ---------------------------------------------------------------------------

/** One AI feature a binding may name, spelled as the host spells it. */
type AiFeatureId = string;

/** One value of `forgejoToolkit.aiTransport`, as the shared enumeration spells it (§8.4). */
type AiTransportChoice = (typeof AI_TRANSPORT_CHOICES)[number];

/**
 * The endpoint editor's own state. It is a draft rather than the snapshot: the
 * fields are edited while the stored configuration stays untouched, and the
 * secrets it carries are values the user has just typed (never a value read back).
 */
interface ProviderDraft {
  id: string;
  name: string;
  baseUrl: string;
  auth: 'bearer' | 'api-key-header' | 'none';
  models: Array<{ id: string; name: string }>;
  /** `value` is what the user typed in this session; `set` is what the host reported. */
  headers: Array<{ name: string; value: string; set: boolean }>;
  /** The typed API key; empty means "keep whatever is stored". */
  key: string;
}

/** The id the endpoint editor was opened on: `null` is the add mode. */
const editingProviderId = ref<string | null>(null);
/** The address the editor opened with, for the heading that names its subject. */
const openedProviderAddress = ref('');
const providerDraft = ref<ProviderDraft>(emptyProviderDraft());
const providerSaving = ref(false);
const providerRemovingId = ref<string | null>(null);
const providerTestingId = ref<string | null>(null);
const providerRechecking = ref(false);
const providerStatus = ref<{ message: string; type: 'idle' | 'success' | 'error' }>({ message: '', type: 'idle' });
/** The last test report, and the endpoint it belongs to (reports are per endpoint). */
const providerTestReport = ref<AiProviderTestReport | null>(null);
const providerTestReportId = ref<string | null>(null);
let providerCancelInFlight = false;

function emptyProviderDraft(): ProviderDraft {
  return {
    id: '',
    name: '',
    baseUrl: '',
    auth: 'bearer',
    models: [{ id: '', name: '' }],
    headers: [],
    key: '',
  };
}

/**
 * The host's last reading of the AI endpoint surface. Everything this section
 * renders comes from it — the endpoint list, the reader's rejections, the transport
 * value, the timeout and the §9.3 capability answer — so the page can never show a
 * state the host never reported. The global AI switch is the one AI setting that is
 * not here: it is one of the page's own settings, read from `settingsSurface` like
 * every other switch the page renders with a control.
 */
const providerSnapshot = computed(() => state.aiProviderSettings.value);
const providerEntries = computed(() => providerSnapshot.value?.providers ?? []);
const providerRejections = computed(() => providerSnapshot.value?.rejected ?? []);
const bindingFeatures = computed(() => providerSnapshot.value?.features ?? []);

/** The §9.3 answer, or `undefined` while nothing has been read yet. */
const capability = computed(() => providerSnapshot.value?.capability);
const capabilityReason = computed(() => {
  const answer = capability.value;
  return answer !== undefined && !answer.available ? answer.reason : '';
});
/**
 * Whether the two routes of the §9.3 block have anything to offer, and which one
 * the reason discriminator puts first.
 *
 * The branch is on the host's **code**, never on which editor is on screen: the
 * block is the same block in the list and in the endpoint editor, and a page that
 * changed its advice depending on where the user happened to be would be advice
 * about the page rather than about the state.
 */
const capabilityCode = computed(() => {
  const answer = capability.value;
  return answer !== undefined && !answer.available ? answer.code : undefined;
});
const capabilityEndpointFirst = computed(() => {
  const code = capabilityCode.value;
  // "Nothing is configured" and "what is configured cannot serve the feature" are
  // both answered by configuring an endpoint; "the editor offers no model" and
  // "the editor's own model API failed" are answered on the editor's side first.
  return code !== 'no-model' && code !== 'editor-unusable';
});

/** The policy values, mirrored locally so a control can be edited before it is saved. */
const policyTransport = ref<'auto' | 'vscode-lm' | 'openai-compatible'>('auto');
const policyTimeoutMs = ref(30_000);
const policyTimeoutField = ref('30000');
const policySaving = ref(false);
const policyStatus = ref<{ message: string; type: 'idle' | 'success' | 'error' }>({ message: '', type: 'idle' });

/** The per-feature binding drafts, and the signature of what the host last applied. */
const bindingProvider = reactive<Record<AiFeatureId, string>>({});
const bindingModel = reactive<Record<AiFeatureId, string>>({});
const bindingSaving = reactive<Record<AiFeatureId, boolean>>({});
const appliedBindingSignatures = new Map<AiFeatureId, string>();

/**
 * The default destination drafts (§8.4) and the signature of what the host last
 * applied — the same "only re-apply what changed" discipline the bindings use, so
 * a snapshot push cannot overwrite a value the user is typing.
 */
const defaultProvider = ref('');
const defaultModel = ref('');
const defaultModelStatus = ref<{ message: string; type: 'idle' | 'success' | 'error' }>({
  message: '',
  type: 'idle',
});
const defaultSaving = ref(false);
let appliedDefaultSignature: string | undefined;

/** The transport choice, in the order the manifest's own dropdown shows it. */
const transportChoices = AI_TRANSPORT_CHOICES;

/**
 * Which halves of the AI area the chosen transport can actually use (§3.2).
 *
 * The page presents the configuration that matches the choice rather than both at
 * once: `auto` uses both routes and may use either, so it shows both and states
 * the precedence; the two explicit choices each fix one route, so the one they
 * cannot use is hidden with a sentence saying so and how to get it back. Nothing
 * here is a write: switching the transport is the user's own control above.
 */
const usesEditorModels = computed(() => policyTransport.value !== 'openai-compatible');
/** The endpoint list, its editor, the default row and the timeout: the direct route's own surface. */
const usesConfiguredEndpoint = computed(() => policyTransport.value !== 'vscode-lm');

/** A feature's label, falling back to the id the host sent rather than to English prose. */
function featureLabel(feature: AiFeatureId): string {
  const key = `settings.aiProviders.bindings.feature.${feature}`;
  const label = t(key);
  return label === key ? feature : label;
}

function providerSecretNames(entry: { headers: Array<{ name: string; shadowed: boolean }> }): string[] {
  return entry.headers.filter((header) => header.shadowed).map((header) => header.name);
}

function storedHeaderCount(entry: { headers: Array<{ set: boolean }> }): number {
  return entry.headers.filter((header) => header.set).length;
}

/** The one-line answer to "can this endpoint be used": its credential state. */
function providerKeyFact(entry: { auth: string; keySet: boolean }): string {
  if (entry.auth === 'none') {
    return t('settings.aiProviders.row.keyNotNeeded');
  }
  return entry.keySet ? t('settings.aiProviders.row.keySet') : t('settings.aiProviders.row.keyMissing');
}

function setProviderStatus(message: string, type: 'idle' | 'success' | 'error' = 'idle'): void {
  providerStatus.value = { message, type };
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t('common.requestFailed');
}

/**
 * Reads the whole AI endpoint surface from the host.
 *
 * A failed read is a line on the page rather than a broken section: the endpoint
 * list is a convenience over `settings.json`, and a page that rendered nothing
 * because one message was dropped would be worse than one that says so.
 */
async function loadProviderSettings(): Promise<void> {
  try {
    await state.loadAiProviderSettings();
    setProviderStatus('');
  } catch (error) {
    setProviderStatus(t('settings.aiProviders.status.loadFailed', { error: errorText(error) }), 'error');
  }
}

/** Re-reads what the host reports, after a write it already answered. */
async function refreshProviderSettings(): Promise<void> {
  try {
    await state.loadAiProviderSettings();
  } catch (error) {
    setProviderStatus(t('settings.aiProviders.status.loadFailed', { error: errorText(error) }), 'error');
  }
}

/**
 * Puts the default row's two controls on one reading of the host's state.
 *
 * The watcher below runs this on every snapshot that changed, and the refused-write
 * path runs it **directly** as well. That second call is not redundant: a refusal
 * usually answers with the very value the host already reported, and an assignment
 * of an identical value is not a change Vue reacts to — so waiting for the push
 * would leave the field showing a default that was never stored. Applying the
 * reading is the only way to say "this is what is actually configured".
 */
function applyDefaultModelReading(reading: { providerId: string; modelId: string }): void {
  appliedDefaultSignature = `${reading.providerId}/${reading.modelId}`;
  defaultProvider.value = reading.providerId;
  defaultModel.value = reading.modelId;
}

/**
 * Reads back what the host reports after a write it refused, so the control cannot
 * keep showing a value that was not stored.
 */
async function resyncDefaultModel(): Promise<void> {
  await refreshProviderSettings();
  applyDefaultModelReading(providerSnapshot.value?.defaultModel ?? { providerId: '', modelId: '' });
}

// The snapshot is the section's single source of truth, so the mirrors follow it
// rather than being updated by hand at every call site: a push the host makes
// after a write the page did not request lands here too.
watch(
  providerSnapshot,
  (snapshot) => {
    if (!snapshot) {
      return;
    }
    policyTransport.value = snapshot.transport;
    if (snapshot.requestTimeoutMs !== policyTimeoutMs.value) {
      policyTimeoutMs.value = snapshot.requestTimeoutMs;
      policyTimeoutField.value = String(snapshot.requestTimeoutMs);
    }
    for (const feature of snapshot.features.length > 0 ? snapshot.features : []) {
      const binding = snapshot.bindings.find((candidate) => candidate.feature === feature);
      const signature = `${binding?.providerId ?? ''}/${binding?.modelId ?? ''}`;
      // Only re-apply what changed: a snapshot push must not overwrite a draft the
      // user is typing into an unrelated feature's binding.
      if (appliedBindingSignatures.get(feature) === signature) {
        continue;
      }
      appliedBindingSignatures.set(feature, signature);
      bindingProvider[feature] = binding?.providerId ?? '';
      bindingModel[feature] = binding?.modelId ?? '';
    }
    if (appliedDefaultSignature !== `${snapshot.defaultModel.providerId}/${snapshot.defaultModel.modelId}`) {
      applyDefaultModelReading(snapshot.defaultModel);
    }
  },
  { immediate: true },
);

/**
 * The endpoint editor closes with its record.
 *
 * The host's snapshot is the authority on what is configured, so an endpoint that
 * is gone from it (removed in another window, or by a hand edit) cannot leave the
 * editor bound to a record that no longer exists — its Save and Test buttons would
 * answer "no endpoint with that id". With no record left there is nothing to
 * preserve, so this path takes no discard prompt.
 */
watch(providerSnapshot, (snapshot) => {
  const id = editingProviderId.value;
  if (id === null || !snapshot) {
    return;
  }
  if (!snapshot.providers.some((entry) => entry.id === id)) {
    closeProviderEditor();
  }
});

/** Opens the editor for a row, with the row's stored state loaded into the draft. */
function openProviderEditor(entry: AiProviderEditorEntry): void {
  returnToListTarget = { kind: 'provider', id: entry.id };
  providerDraft.value = {
    id: entry.id,
    name: entry.name,
    baseUrl: entry.baseUrl,
    // An entry the reader could not read never reaches here (it is in `rejected`),
    // so `auth` is always one of the three values the manifest contributes.
    auth: entry.auth,
    models: entry.models.length > 0 ? entry.models.map((model) => ({ ...model })) : [{ id: '', name: '' }],
    headers: entry.headers.map((header) => ({ name: header.name, value: '', set: header.set })),
    key: '',
  };
  editingProviderId.value = entry.id;
  openedProviderAddress.value = entry.address;
  providerTestReport.value = null;
  providerTestReportId.value = null;
  providerSaving.value = false;
  resetDraftProbe();
  setProviderStatus('');
  providerEditorOpen.value = true;
}

/** Opens the editor in its add mode: the same fields, nothing loaded. */
function openNewProviderEditor(): void {
  returnToListTarget = { kind: 'addProvider' };
  providerDraft.value = emptyProviderDraft();
  editingProviderId.value = null;
  openedProviderAddress.value = '';
  providerTestReport.value = null;
  providerTestReportId.value = null;
  providerSaving.value = false;
  resetDraftProbe();
  setProviderStatus('');
  providerEditorOpen.value = true;
}

/**
 * Returns to the list, unconditionally. Used where the editor cannot stay open: a
 * saved configuration, or an endpoint the host no longer reports.
 */
function closeProviderEditor(): void {
  editingProviderId.value = null;
  providerEditorOpen.value = false;
  providerDraft.value = emptyProviderDraft();
  openedProviderAddress.value = '';
  providerSaving.value = false;
  resetDraftProbe();
}

/** Whether the draft holds anything the endpoint list would lose by closing it. */
const providerDraftDirty = computed(() => {
  const draft = providerDraft.value;
  if (draft.key !== '') {
    return true;
  }
  if (draft.headers.some((header) => header.value !== '')) {
    return true;
  }
  const stored = editingProviderId.value
    ? providerEntries.value.find((entry) => entry.id === editingProviderId.value)
    : undefined;
  if (!stored) {
    // The add mode is dirty as soon as anything a new endpoint would keep is set.
    return (
      draft.id !== '' ||
      draft.name !== '' ||
      draft.baseUrl !== '' ||
      draft.models.some((model) => model.id !== '' || model.name !== '') ||
      draft.headers.some((header) => header.name !== '')
    );
  }
  return (
    draft.name !== stored.name ||
    draft.baseUrl !== stored.baseUrl ||
    draft.auth !== stored.auth ||
    JSON.stringify(draft.models) !==
      JSON.stringify(stored.models.map((model) => ({ id: model.id, name: model.name }))) ||
    JSON.stringify(draft.headers.map((header) => header.name)) !==
      JSON.stringify(stored.headers.map((header) => header.name))
  );
});

/**
 * The Cancel/Back control's own path: it asks before throwing typed input away,
 * with the same pure-UI confirmation every other dirty form on this page uses.
 * Removing an endpoint is a host command and is confirmed host-side, so it must
 * not be double-prompted here.
 */
async function requestCloseProviderEditor(): Promise<void> {
  if (providerDraftDirty.value) {
    if (providerCancelInFlight) {
      return;
    }
    providerCancelInFlight = true;
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
      providerCancelInFlight = false;
    }
  }
  closeProviderEditor();
}

function addProviderModel(): void {
  providerDraft.value.models.push({ id: '', name: '' });
}

function removeProviderModel(index: number): void {
  providerDraft.value.models.splice(index, 1);
  if (providerDraft.value.models.length === 0) {
    providerDraft.value.models.push({ id: '', name: '' });
  }
}

function addProviderHeader(): void {
  providerDraft.value.headers.push({ name: '', value: '', set: false });
}

function removeProviderHeader(index: number): void {
  providerDraft.value.headers.splice(index, 1);
}

/** Whether a model id is declared more than once in the draft (the host refuses it too). */
function duplicateModelIds(): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const model of providerDraft.value.models) {
    const id = model.id.trim();
    if (id === '') {
      continue;
    }
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  return duplicates;
}

/** Whether a header name is declared more than once in the draft. */
function duplicateHeaderNames(): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const header of providerDraft.value.headers) {
    const name = header.name.trim();
    if (name === '') {
      continue;
    }
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }
  return duplicates;
}

/** Whether the draft's header name collides with the auth style the transport sends itself. */
function headerIsAuthOwned(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'authorization' || normalized === 'api-key';
}

/**
 * Whether a header value travels as a query parameter rather than as a header.
 *
 * `api-version` is Azure's own spelling and the transport sends it in the URL
 * (§6.2); the page says so on the row rather than letting the user believe a header
 * was sent. The check is by name only — the value's location is what it describes.
 */
function headerQueryCarried(name: string): boolean {
  return name.trim().toLowerCase() === 'api-version';
}

/** Whether the endpoint being edited has an API key stored (never the key itself). */
const storedKeySet = computed(() => {
  const id = editingProviderId.value;
  if (id === null) {
    return false;
  }
  return providerEntries.value.find((entry) => entry.id === id)?.keySet ?? false;
});

/**
 * Saves the draft: the configuration first, then every secret value the user
 * typed, in that order and for one reason.
 *
 * A secret can only be stored for an endpoint that exists — the host refuses an
 * orphan secret, because nothing would ever show it and an endpoint later
 * configured under that id would send it — so a **new** endpoint has to be written
 * before its key and header values can be. When the configuration write succeeds
 * but a secret write fails, the editor stays open with the typed value still in
 * the field and a line saying so: closing it would discard a value the user
 * entered and the page never read back.
 */
async function saveProvider(): Promise<void> {
  if (providerSaving.value) {
    return;
  }
  const draft = providerDraft.value;
  providerSaving.value = true;
  setProviderStatus(t('settings.aiProviders.editor.saving'));
  try {
    const saved = await state.saveAiProvider({
      id: draft.id.trim(),
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      models: draft.models
        .filter((model) => model.id.trim() !== '')
        .map((model) => ({ id: model.id.trim(), name: model.name.trim() })),
      auth: draft.auth,
      headers: draft.headers.map((header) => header.name.trim()).filter((name) => name !== ''),
    });
    if (saved.error) {
      setProviderStatus(saved.error, 'error');
      return;
    }
    const id = saved.id;
    if (draft.key !== '') {
      const result = await state.setAiProviderSecret(id, undefined, draft.key);
      if (result.error) {
        setProviderStatus(t('settings.aiProviders.editor.secretFailed', { error: result.error }), 'error');
        return;
      }
    }
    for (const header of draft.headers) {
      if (header.name.trim() === '' || header.value === '') {
        continue;
      }
      const result = await state.setAiProviderSecret(id, header.name.trim(), header.value);
      if (result.error) {
        setProviderStatus(t('settings.aiProviders.editor.secretFailed', { error: result.error }), 'error');
        return;
      }
    }
    await refreshProviderSettings();
    closeProviderEditor();
    setProviderStatus(t('settings.aiProviders.status.saved', { id }), 'success');
  } catch (error) {
    setProviderStatus(errorText(error), 'error');
  } finally {
    providerSaving.value = false;
  }
}

/**
 * Clears one stored secret.
 *
 * It needs the endpoint to exist, so it is only offered in the edit mode; the
 * confirmation is the host's own for the removal of an endpoint, but there is none
 * for clearing a value, and a confirmation written here would be the webview
 * re-implementing a host-side discipline. The value can be entered again, which is
 * what makes an unconfirmed clear acceptable.
 */
async function clearProviderSecret(headerName?: string): Promise<void> {
  const id = editingProviderId.value;
  if (id === null) {
    return;
  }
  try {
    const result =
      headerName === undefined
        ? await state.setAiProviderSecret(id, undefined, '')
        : await state.setAiProviderSecret(id, headerName, '');
    if (result.error) {
      setProviderStatus(result.error, 'error');
      return;
    }
    const header =
      headerName === undefined
        ? undefined
        : providerDraft.value.headers.find((candidate) => candidate.name.trim() === headerName);
    if (header) {
      header.set = false;
      header.value = '';
    }
    await refreshProviderSettings();
    setProviderStatus(t('settings.aiProviders.status.secretCleared'), 'success');
  } catch (error) {
    setProviderStatus(errorText(error), 'error');
  }
}

/**
 * Runs the §8.7 probe for one endpoint and renders its report.
 *
 * This is the only action on this page that sends a request to the endpoint, and it
 * happens only because a control was clicked — never from a load, a save or a
 * render. The report names the address and, when it failed locally, says that
 * nothing was sent.
 */
async function runProviderTest(id: string): Promise<void> {
  if (providerTestingId.value !== null) {
    return;
  }
  providerTestingId.value = id;
  providerTestReport.value = null;
  providerTestReportId.value = null;
  try {
    const report = await state.testAiProvider(id);
    providerTestReport.value = report;
    providerTestReportId.value = report.providerId;
  } catch (error) {
    setProviderStatus(errorText(error), 'error');
  } finally {
    providerTestingId.value = null;
  }
}

/** The report for the endpoint the page is currently showing, if any. */
function reportForCurrentView(): AiProviderTestReport | null {
  const report = providerTestReport.value;
  if (!report) {
    return null;
  }
  const subject = providerEditorOpen.value ? editingProviderId.value : undefined;
  if (subject !== undefined && subject !== null && report.providerId !== subject) {
    return null;
  }
  return report;
}

/**
 * The model ids a successful test reported that the editor does not declare yet.
 *
 * The record's §8.7 step 2 prefills the endpoint's model list from the list the
 * endpoint itself reported, and it is the model **declaration** being filled in — not
 * a whitelist (§8.1) — so the prefilled rows are ordinary rows the user may edit or
 * delete. Only the ids the draft is missing are offered, so pressing the control
 * twice cannot duplicate a declaration.
 */
function reportedModelsToAdd(): string[] {
  const report = providerEditorOpen.value ? reportForCurrentView() : null;
  if (!report?.ok || report.models === undefined) {
    return [];
  }
  const declared = new Set(providerDraft.value.models.map((model) => model.id.trim()).filter((id) => id !== ''));
  return report.models.filter((id) => id !== '' && !declared.has(id));
}

/** Appends the reported models to the draft, replacing the empty placeholder row. */
function addReportedModels(): void {
  addDraftModels(reportedModelsToAdd());
}

/**
 * Adds the model ids a probe reported that the draft does not declare yet, and
 * answers how many were added.
 *
 * Shared by the explicit test's button and the automatic probe, because the
 * record's rule for both is the same (§4.5): the report is a **prefill**, so the
 * ids go in as ordinary rows — editable and removable — the user's own rows are
 * never touched, and a draft holding only the empty placeholder has that
 * placeholder replaced rather than added to. Nothing is overwritten and nothing
 * is renamed.
 */
function addDraftModels(candidateIds: string[]): number {
  const declared = new Set(providerDraft.value.models.map((model) => model.id.trim()).filter((id) => id !== ''));
  const missing = candidateIds.filter((id) => id !== '' && !declared.has(id));
  if (missing.length === 0) {
    return 0;
  }
  const placeholderOnly =
    providerDraft.value.models.length === 1 &&
    providerDraft.value.models[0]!.id.trim() === '' &&
    providerDraft.value.models[0]!.name.trim() === '';
  if (placeholderOnly) {
    providerDraft.value.models = [];
  }
  for (const id of missing) {
    providerDraft.value.models.push({ id, name: '' });
  }
  return missing.length;
}

// ---------------------------------------------------------------------------
// The automatic model probe (`docs/design/settings-page.md` §4) and the identity
// this page generates for a new endpoint (§5).
//
// The probe is the first path in this extension that sends a request without a
// click, and the record's §8.1 states that cost in the open: a user who typed a
// wrong address and then a credential will send one `GET /models` to that
// address. Everything below is the mitigation the same record requires — one
// shot per input combination, 800 ms of idle, cancelled by any further typing,
// never armed for an address the shared URL rule refuses, `GET /models` only, and
// a failure that is reported without blocking the form.
// ---------------------------------------------------------------------------

/** How long the editor has to be idle before the draft probe fires (§4.3). */
const DRAFT_PROBE_IDLE_MS = 800;

/** The last draft probe's report, rendered by the same component as the clicked test. */
const draftProbeReport = ref<AiProviderTestReport | null>(null);
const draftProbeState = ref<'idle' | 'probing' | 'done'>('idle');
/** How many rows the last probe added, for the status line under the model list. */
const draftProbeAddedCount = ref(0);
let draftProbeTimer: number | undefined;
/**
 * The input combination the last probe was fired for. One shot per combination:
 * the user asks again with the probe control, not by re-typing what is already
 * there (§4.3).
 */
let lastProbedSignature: string | null = null;
/** Whether the address field has been left once, so its local refusal can be shown. */
const providerAddressCommitted = ref(false);
/**
 * Whether the user has changed the address, the authentication style or the
 * credential since this editor opened (§4.3, §8.1).
 *
 * The probe exists for "I just finished typing an address and a credential", so
 * **only an edit may arm it**. Opening an existing endpoint — or switching from
 * one endpoint to another — fills these fields too, and a watcher over their
 * values cannot tell that apart from typing: with `auth: none` the credential is
 * not needed, so an existing credential-less endpoint armed the probe the moment
 * its editor was opened and sent a `GET /models` about a second later, before any
 * input. This flag is what the watched signature is missing: it is set by the
 * three input handlers and by nothing else, and cleared on every transition in or
 * out of the editor.
 */
const providerDraftEdited = ref(false);
/**
 * The values this page generated, while the field still holds them untouched. A
 * generated value follows the address; the moment the user edits the field, the
 * field is theirs and generation stops for it (§5.1).
 */
let generatedProviderId: string | null = null;
let generatedProviderName: string | null = null;

/** The address's verdict, computed once for the row warning, the probe and the identity. */
const providerDraftVerdict = computed(() => inspectAiProviderBaseUrl(providerDraft.value.baseUrl.trim()));

/** Why the typed address cannot be used, once the user has left the field (§3.3 rule 1). */
const providerDraftAddressReason = computed(() => {
  if (!providerAddressCommitted.value || providerDraft.value.baseUrl.trim() === '') {
    return '';
  }
  const verdict = providerDraftVerdict.value;
  return verdict.ok ? '' : verdict.reason;
});

/**
 * The input combination the automatic probe would run for, or `null` when it must
 * not run at all: no editor, a save in flight, **nothing edited yet**, no freshly
 * typed credential, an address that is not a usable URL yet, or an endpoint list
 * the host has not reported yet.
 *
 * The signature holds the typed key so that typing a different one counts as a
 * new combination. It is a value in this component's memory only: it is never
 * rendered, never logged and never sent anywhere — only the probe's own payload
 * carries the credential, and only to the host.
 */
const draftProbeSignature = computed<string | null>(() => {
  if (!providerEditorOpen.value || providerSaving.value || providerRemovingId.value !== null) {
    return null;
  }
  if (!providerDraftEdited.value) {
    // Field values are not input: an editor that was just opened (or switched to
    // another endpoint) has a valid address and, under `auth: none`, needs no
    // credential — so without this the opening itself armed a probe (§4.3). An
    // edit is required in every case, `auth: none` included.
    return null;
  }
  if (!providerSnapshot.value) {
    // The endpoint list is what the draft's own credential store reads through, so
    // an unread host is "do not send" rather than "probably fine".
    return null;
  }
  if (!providerDraftVerdict.value.ok) {
    return null;
  }
  const draft = providerDraft.value;
  if (draft.auth !== 'none' && draft.key.trim() === '') {
    // A stored key is not a new one: opening an existing endpoint and leaving the
    // field empty is not an input event, and the probe is for "I just typed the
    // address and the credential" (§4.3).
    return null;
  }
  return JSON.stringify([
    draft.baseUrl.trim(),
    draft.auth,
    draft.key,
    draft.headers.map((header) => [header.name.trim(), header.value]),
  ]);
});

function cancelDraftProbe(): void {
  if (draftProbeTimer !== undefined) {
    window.clearTimeout(draftProbeTimer);
    draftProbeTimer = undefined;
  }
}

onUnmounted(() => {
  cancelDraftProbe();
});

watch(draftProbeSignature, (signature) => {
  // Any further typing cancels the pending probe and starts the window again.
  cancelDraftProbe();
  if (signature === null || signature === lastProbedSignature) {
    return;
  }
  draftProbeTimer = window.setTimeout(() => {
    draftProbeTimer = undefined;
    void runDraftProbe(signature);
  }, DRAFT_PROBE_IDLE_MS);
});

/** The editor's current fields, as the host's draft probe takes them (§4.2). */
function draftProbePayload(): AiProviderDraftProbe {
  const draft = providerDraft.value;
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    auth: draft.auth,
    key: draft.key,
    headers: draft.headers
      .filter((header) => header.name.trim() !== '' && header.value !== '')
      .map((header) => ({ name: header.name.trim(), value: header.value })),
  };
}

/**
 * Runs one draft probe and renders its report.
 *
 * The combination is marked as probed **before** the request goes out: a watcher
 * that fires again while the answer is in flight must not queue a second one. A
 * failure is a report card and never a native dialog — this page has not raised
 * one for a setting, and a probe the user did not click must not start.
 */
async function runDraftProbe(signature: string | null): Promise<void> {
  lastProbedSignature = signature;
  draftProbeState.value = 'probing';
  try {
    applyDraftProbeReport(await state.testAiProviderDraft(draftProbePayload()));
  } catch (error) {
    draftProbeState.value = 'idle';
    setProviderStatus(errorText(error), 'error');
  }
}

/** The editor's own "probe again" control: an explicit run that ignores the idle rules. */
function probeDraftModels(): void {
  cancelDraftProbe();
  void runDraftProbe(draftProbeSignature.value);
}

function applyDraftProbeReport(report: AiProviderTestReport): void {
  draftProbeReport.value = report;
  draftProbeState.value = 'done';
  draftProbeAddedCount.value = report.ok && report.models !== undefined ? addDraftModels(report.models) : 0;
}

/**
 * What the line under the model list says: the probe in progress, how many rows it
 * filled in, or — for a failure or a local refusal — that it did not answer and
 * where the host's own reason is.
 *
 * The failed case has to be said **here** as well as in the report card: the card
 * sits below the model rows and is routinely below the fold, so an empty status
 * line left a failed probe looking like nothing had happened.
 */
const draftProbeStatus = computed(() => {
  if (draftProbeState.value === 'probing') {
    return t('settings.aiProviders.probe.probing');
  }
  if (draftProbeState.value !== 'done') {
    return '';
  }
  const report = draftProbeReport.value;
  if (!report) {
    return '';
  }
  if (!report.ok) {
    return report.ran ? t('settings.aiProviders.probe.failed') : t('settings.aiProviders.probe.refused');
  }
  return draftProbeAddedCount.value > 0
    ? t('settings.aiProviders.probe.added', { count: draftProbeAddedCount.value })
    : t('settings.aiProviders.probe.unchanged');
});

/**
 * Whether the last probe answered, which is when the "this is not consent" line
 * belongs under the model rows (§8 question 2).
 *
 * Only an answer may carry that sentence: a probe that failed or was refused
 * sends nothing at all, so it cannot be mistaken for permission and needs no
 * disclaimer. A success is the one outcome a reader can turn into "so this
 * endpoint is allowed" — and it is not allowed by any of what the probe did.
 */
const draftProbeSucceeded = computed(() => draftProbeState.value === 'done' && draftProbeReport.value?.ok === true);

function handleProviderBaseUrlInput(event: Event): void {
  providerDraft.value.baseUrl = (event.target as HTMLInputElement).value;
  providerAddressCommitted.value = false;
  providerDraftEdited.value = true;
  syncGeneratedProviderIdentity();
}

/**
 * The authentication style is one of the three fields an edit may arm the probe
 * with (§4.3): switching to `auth: none` is what makes an address enough on its
 * own, so it is an input event in its own right.
 */
function handleProviderAuthChange(event: Event): void {
  providerDraft.value.auth = (event.target as HTMLSelectElement).value as typeof providerDraft.value.auth;
  providerDraftEdited.value = true;
}

/** The credential the user typed. A stored key is never read back, so a value here is always new. */
function handleProviderKeyInput(event: Event): void {
  providerDraft.value.key = (event.target as HTMLInputElement).value;
  providerDraftEdited.value = true;
}

function handleProviderIdInput(event: Event): void {
  // The field is the user's from here on: generation never overwrites what they
  // typed, and never renames an endpoint behind their back (§5.2 rule 3).
  generatedProviderId = null;
  providerDraft.value.id = (event.target as HTMLInputElement).value;
}

function handleProviderNameInput(event: Event): void {
  generatedProviderName = null;
  providerDraft.value.name = (event.target as HTMLInputElement).value;
}

/**
 * Fills the id and the display name a new endpoint's address suggests (§5.1).
 *
 * Only in the add mode, and only for a field that is empty or still holds what
 * this function generated: an id the user typed is theirs, and an id that follows
 * every keystroke of the address would be unusable. Both values land in the
 * fields, where the user sees them and can change them; nothing is generated at
 * save time.
 */
function syncGeneratedProviderIdentity(): void {
  if (editingProviderId.value !== null) {
    return;
  }
  const address = providerDraft.value.baseUrl.trim();
  if (address === '') {
    return;
  }
  const draft = providerDraft.value;
  if (draft.id === '' || draft.id === generatedProviderId) {
    const taken = [
      ...providerEntries.value.map((entry) => entry.id),
      ...providerRejections.value.map((rejection) => rejection.id ?? ''),
    ];
    const next = uniqueAiProviderId(generateAiProviderId(address), taken);
    generatedProviderId = next;
    draft.id = next;
  }
  if (draft.name === '' || draft.name === generatedProviderName) {
    const next = generateAiProviderName(address);
    if (next !== '') {
      generatedProviderName = next;
      draft.name = next;
    }
  }
}

/** Clears this editor's probe state, on every transition in or out of it. */
function resetDraftProbe(): void {
  cancelDraftProbe();
  draftProbeReport.value = null;
  draftProbeState.value = 'idle';
  draftProbeAddedCount.value = 0;
  lastProbedSignature = null;
  providerAddressCommitted.value = false;
  providerDraftEdited.value = false;
  generatedProviderId = null;
  generatedProviderName = null;
}

/**
 * Removes one endpoint. The host pops its own confirmation before it executes, so
 * a `cancelled` answer is "the user said no", not a failure.
 */
async function removeProvider(id: string): Promise<void> {
  if (providerRemovingId.value !== null) {
    return;
  }
  providerRemovingId.value = id;
  try {
    const result = await state.removeAiProvider(id);
    if (result.cancelled) {
      setProviderStatus(t('settings.aiProviders.status.removeCancelled'));
      return;
    }
    if (result.error) {
      setProviderStatus(result.error, 'error');
      return;
    }
    if (editingProviderId.value === id) {
      closeProviderEditor();
    }
    await refreshProviderSettings();
    setProviderStatus(t('settings.aiProviders.status.removed', { id }), 'success');
  } catch (error) {
    setProviderStatus(errorText(error), 'error');
  } finally {
    providerRemovingId.value = null;
  }
}

/** Writes the model policy, reverting the controls the host refused. */
async function savePolicy(overrides: Partial<{ requestTimeoutMs: number }> = {}): Promise<void> {
  if (policySaving.value) {
    return;
  }
  const policy = {
    transport: policyTransport.value,
    requestTimeoutMs: overrides.requestTimeoutMs ?? policyTimeoutMs.value,
  };
  policySaving.value = true;
  try {
    const result = await state.setAiModelPolicy(policy);
    if (result.error) {
      policyStatus.value = { message: result.error, type: 'error' };
      // The controls go back to what the host reports: a switch left showing a
      // state that was never stored is exactly the lie this page exists to avoid.
      await refreshProviderSettings();
      return;
    }
    policyTransport.value = result.transport;
    policyTimeoutMs.value = result.requestTimeoutMs;
    policyTimeoutField.value = String(result.requestTimeoutMs);
    policyStatus.value = { message: t('settings.aiProviders.status.policySaved'), type: 'success' };
  } catch (error) {
    policyStatus.value = { message: errorText(error), type: 'error' };
  } finally {
    policySaving.value = false;
  }
}

/**
 * Saves the transport. It is a control of this page (§1.3): the choice decides
 * which half of the AI area the page presents, so it cannot live only in the
 * editor's own settings UI. The write goes through the same policy message the
 * timeout uses, and the host writes only the values that differ — so choosing a
 * transport here cannot revert a value the user changed in the settings editor
 * between opening this page and pressing this control.
 */
function handlePolicyTransportChange(event: Event): void {
  policyTransport.value = (event.target as HTMLSelectElement).value as AiTransportChoice;
  void savePolicy();
}

/** Saves the idle timeout, which is typed rather than toggled. */
function savePolicyTimeout(): void {
  const value = Number(policyTimeoutField.value.trim());
  void savePolicy({ requestTimeoutMs: value });
}

/**
 * Re-reads the models the editor offers, and with them the §9.3 answer.
 *
 * This is the clickable half of the "install a model extension" route: the page
 * cannot install anything, and the honest action it can offer is to look again —
 * every model-contributing extension is listed by the same API, so a model that
 * appeared while this page was open shows up here.
 */
async function recheckOfferedModels(): Promise<void> {
  if (providerRechecking.value) {
    return;
  }
  providerRechecking.value = true;
  try {
    await Promise.all([loadAiPreReviewModels(), refreshProviderSettings()]);
  } catch (error) {
    setProviderStatus(errorText(error), 'error');
  } finally {
    providerRechecking.value = false;
  }
}

/** Stores or clears one feature's binding (§8.4). */
async function saveBinding(feature: AiFeatureId, clear = false): Promise<void> {
  if (bindingSaving[feature]) {
    return;
  }
  bindingSaving[feature] = true;
  try {
    const providerId = clear ? '' : (bindingProvider[feature] ?? '');
    const modelId = clear ? '' : (bindingModel[feature] ?? '');
    const result = await state.setAiModelBinding({ feature, providerId, modelId });
    if (result.error) {
      // The draft goes back to the host's own reading instead of keeping a value
      // that was refused.
      appliedBindingSignatures.delete(feature);
      await refreshProviderSettings();
      setProviderStatus(result.error, 'error');
      return;
    }
    setProviderStatus(
      t(providerId === '' ? 'settings.aiProviders.status.bindingCleared' : 'settings.aiProviders.status.bindingSaved'),
      'success',
    );
  } catch (error) {
    setProviderStatus(errorText(error), 'error');
  } finally {
    bindingSaving[feature] = false;
  }
}

/**
 * Stores or clears the **default** destination the per-feature overrides sit on
 * top of (§8.4).
 *
 * The row submits its whole state, exactly as the override rows do: an empty pair
 * clears the default, and a half-filled pair is refused by the host with its own
 * sentence rather than completed with a guess — a model on its own names nowhere
 * to send to. A refused write puts both controls back on the host's reading, so
 * the row can never keep showing a default that was never stored.
 */
async function saveDefaultModel(clear = false): Promise<void> {
  if (defaultSaving.value) {
    return;
  }
  const providerId = clear ? '' : defaultProvider.value.trim();
  const modelId = clear ? '' : defaultModel.value.trim();
  // A half-filled pair is the host's refusal to make — it owns the sentence, and
  // this page never writes its own validation. What is left here is presentation:
  // the model field beside a chosen endpoint is not an empty default, and the row
  // says so rather than leaving a blank line under a filled select.
  if (!clear && providerId !== '' && modelId === '') {
    defaultModelStatus.value = { message: t('settings.aiProviders.defaultModel.halfConfigured'), type: 'error' };
    return;
  }
  defaultSaving.value = true;
  try {
    const result = await state.setAiDefaultModel({ providerId, modelId });
    if (result.error) {
      // The controls go back to what the host reports: a pair left showing values
      // that were never stored is exactly the lie this page exists to avoid.
      await resyncDefaultModel();
      defaultModelStatus.value = { message: result.error, type: 'error' };
      return;
    }
    defaultModelStatus.value = {
      message: t(
        providerId === '' ? 'settings.aiProviders.defaultModel.cleared' : 'settings.aiProviders.defaultModel.saved',
      ),
      type: 'success',
    };
  } catch (error) {
    defaultModelStatus.value = { message: errorText(error), type: 'error' };
  } finally {
    defaultSaving.value = false;
  }
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
      // No navigation: this page *is* the surface the import was started from,
      // and the tab has nowhere else to go. The sidebar version replaced the
      // route with the dashboard, which was how the user got back to a page that
      // existed somewhere in the same router — the tab reports the count in its
      // own status line and stays where it is (`docs/design/settings-page.md`
      // §9.3).
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
    inline custom property is what `scroll-padding-top` reads. The scroll root is
    also what the page's own width is read from (see `pageWidth`), which is why it
    carries a template ref.
  -->
  <div ref="settingsRoot" class="settings" :style="{ '--editor-sticky-height': `${editorStickyHeight}px` }">
    <!--
      The import preview replaces the page while it is open, and this page is the
      only surface that can open one now: the sidebar's `importPreview` route was
      retired with its settings route, so the preview is rendered here instead of
      being navigated to (`docs/design/settings-page.md` §9.3). Clearing
      `state.importPreview` is what brings the page back — by the return control
      below, by the preview's own Cancel, or by a successful import — and the
      `importPreview` watcher in the script is what puts focus back on the Import
      button that opened it.

      That return control is this page's, not the preview's: its destination is
      this page's list, its guard is this page's discard question, and the preview
      hands over the two facts it alone has (`requestLeave`). It is a text link
      rather than the two editor headings' `.editor-band-back` band control — the
      preview's own heading is the component's, and its shape is unchanged — but
      it keeps the same wording shape and the same place in the reading order, so
      the three detail states of this page offer the same way out first — and the
      preview's own Cancel goes through that same guard, exactly as `Cancel Edit`
      goes through `requestCloseEditor`.
    -->
    <ImportPreview v-if="state.importPreview.value" :request-leave="requestLeaveImportPreview">
      <template #return-path="{ leave }">
        <button type="button" class="link-button editor-back import-preview-back" @click="leave">
          {{ t('settings.importPreview.backToList') }}
        </button>
      </template>
    </ImportPreview>
    <template v-else>
      <!--
      The page header. It is visible in all three states — the instance list and
      both editors — because it is a property of the page and not of a section
      (`docs/design/settings-page.md` §2.1): it answers "where are the rest of
      this extension's settings", which is a question about the page. The control
      runs the `forgejoToolkit.openNativeSettings` command, which opens VS Code's
      own settings editor **filtered to this extension** — the unfiltered editor
      is exactly the place the user could not find these settings in.
    -->
      <header class="settings-header">
        <vscode-button secondary icon="settings-gear" @click="openNativeSettings">
          {{ t('settings.header.openNativeSettings') }}
        </vscode-button>
        <p class="field-description">{{ t('settings.header.openNativeSettingsDescription') }}</p>
        <div v-if="settingsSurfaceLoadError" class="status error" role="status" aria-live="polite">
          {{ settingsSurfaceLoadError }}
        </div>
      </header>

      <div v-if="editorOpen" ref="editorRoot" class="instance-editor" tabindex="-1">
        <!--
        The editor's identity band: the way out, the title, and the record the
        fields below belong to — in that order, and all three in the sticky block
        (`docs/design/settings-page.md` §3.4). The band names the instance (name
        and URL) so the fields below it cannot be mistaken for another record's.
        The visible heading is not its own live region: opening the editor moves
        focus here, and a live region would announce the band a second time on top
        of that.
      -->
        <div ref="editorHeading" class="editor-heading">
          <!--
            The identity band's first line, and the heading block's first
            element: the way out is read before the identity rather than after
            it (`docs/design/settings-page.md` §3.4). It is a real `<button>`
            with a codicon, an accessible name and a tooltip, so it is in the tab
            order and Enter/Space activate it without a pointer.
          -->
          <button
            type="button"
            class="link-button editor-band-back"
            :title="t('settings.instanceEditor.backToListTitle')"
            @click="requestCloseEditor"
          >
            <i class="codicon codicon-arrow-left" aria-hidden="true"></i>
            {{ t('settings.instanceEditor.backToList') }}
          </button>
          <h2 class="editor-title">{{ editorTitle }}</h2>
          <div v-if="editingInstance" class="editor-identity">
            <span class="editor-identity-name">{{ editorSubjectName }}</span>
            <span class="editor-identity-url-group">
              <span class="editor-identity-url">{{ editorSubjectUrl }}</span>
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
            <vscode-button @click="requestCloseEditor" secondary>{{
              t('settings.instanceEditor.cancel')
            }}</vscode-button>
          </div>

          <!-- The Test/Save outcome is a polite live region that is always in the
             document, empty until there is something to say. Rendered together
             with its text (the old `v-if="status"`), a region that appears at the
             same moment its content does is one assistive technology is allowed
             to miss, so an async "saved" or "wrong token" was never announced. -->
          <div :class="['status', statusType]" role="status" aria-live="polite">{{ status }}</div>
        </div>
      </div>

      <!--
      The endpoint editor: the same detail half as the instance editor, for the
      other master. Its heading is that editor's band element for element — the
      way out first, then the title, then the record's identity with the copy
      control beside the address — so the two editors read as one pattern rather
      than two (`docs/design/settings-page.md` §3.4).
    -->
      <div v-else-if="providerEditorOpen" ref="editorRoot" class="instance-editor" tabindex="-1">
        <div ref="editorHeading" class="editor-heading">
          <button
            type="button"
            class="link-button editor-band-back"
            :title="t('settings.aiProviders.backToListTitle')"
            @click="requestCloseProviderEditor"
          >
            <i class="codicon codicon-arrow-left" aria-hidden="true"></i>
            {{ t('settings.aiProviders.backToList') }}
          </button>
          <h2 class="editor-title">
            {{ editingProviderId ? t('settings.aiProviders.editTitle') : t('settings.aiProviders.addTitle') }}
          </h2>
          <div v-if="editingProviderId && openedProviderAddress" class="editor-identity">
            <span class="editor-identity-name">{{ providerDraft.name }}</span>
            <span class="editor-identity-url-group">
              <span class="editor-identity-url">{{ openedProviderAddress }}</span>
              <vscode-button
                class="editor-copy-url"
                icon="copy"
                icon-only
                secondary
                :title="t('settings.aiProviders.testReport.address')"
                :aria-label="t('settings.aiProviders.testReport.address')"
                @click="state.copyToClipboard(openedProviderAddress)"
              />
            </span>
          </div>
        </div>

        <div class="editor-fields">
          <div class="form-row">
            <label for="ai-provider-id">{{ t('settings.aiProviders.editor.id') }}</label>
            <vscode-textfield
              id="ai-provider-id"
              :value="providerDraft.id"
              :label="t('settings.aiProviders.editor.id')"
              :disabled="editingProviderId !== null"
              @input="handleProviderIdInput"
            />
            <!--
            The price of the id is stated where it is created, not only where it is
            locked (§5.3): the secret keys derive from it, so a later change loses
            the stored credentials. Shown in the add mode, right under the field —
            the moment the user can still choose.
          -->
            <p v-if="editingProviderId === null" class="field-description">
              {{ t('settings.aiProviders.editor.idCreateWarning') }}
            </p>
            <p class="field-description">{{ t('settings.aiProviders.editor.idDescription') }}</p>
            <p v-if="editingProviderId" class="field-description">{{ t('settings.aiProviders.editor.idLocked') }}</p>
          </div>

          <div class="form-row">
            <label for="ai-provider-name">{{ t('settings.aiProviders.editor.name') }}</label>
            <vscode-textfield
              id="ai-provider-name"
              :value="providerDraft.name"
              :label="t('settings.aiProviders.editor.name')"
              @input="handleProviderNameInput"
            />
            <p class="field-description">{{ t('settings.aiProviders.editor.nameDescription') }}</p>
          </div>

          <div class="form-row">
            <label for="ai-provider-base-url">{{ t('settings.aiProviders.editor.baseUrl') }}</label>
            <vscode-textfield
              id="ai-provider-base-url"
              :value="providerDraft.baseUrl"
              :label="t('settings.aiProviders.editor.baseUrl')"
              type="url"
              @input="handleProviderBaseUrlInput"
              @change="providerAddressCommitted = true"
            />
            <p class="field-description">{{ t('settings.aiProviders.editor.baseUrlDescription') }}</p>
            <!--
            What is wrong locally, said on the row and with the field left as the
            user typed it (§3.3 rule 1). The reason is the shared verdict's own
            sentence, and it appears once the user has left the field rather than
            on every keystroke of an address being typed.
          -->
            <p v-if="providerDraftAddressReason" class="field-description warn">
              {{ t('settings.aiProviders.editor.addressInvalid', { reason: providerDraftAddressReason }) }}
            </p>
          </div>

          <div class="form-row">
            <label for="ai-provider-auth">{{ t('settings.aiProviders.editor.auth') }}</label>
            <vscode-single-select
              id="ai-provider-auth"
              :value="providerDraft.auth"
              :label="t('settings.aiProviders.editor.auth')"
              @change="handleProviderAuthChange"
            >
              <vscode-option value="bearer">{{ t('settings.aiProviders.editor.authBearer') }}</vscode-option>
              <vscode-option value="api-key-header">{{
                t('settings.aiProviders.editor.authApiKeyHeader')
              }}</vscode-option>
              <vscode-option value="none">{{ t('settings.aiProviders.editor.authNone') }}</vscode-option>
            </vscode-single-select>
          </div>

          <!--
          The credential itself. The stored value is never read back into the
          webview, so the field is always empty and the two states it can be in are
          said in words beside it; clearing is its own control because the only way
          to unset a secret is to submit an empty one.
        -->
          <div class="form-row">
            <label for="ai-provider-key">{{ t('settings.aiProviders.editor.key') }}</label>
            <vscode-textfield
              id="ai-provider-key"
              :value="providerDraft.key"
              :label="t('settings.aiProviders.editor.key')"
              type="password"
              :disabled="providerDraft.auth === 'none'"
              @input="handleProviderKeyInput"
            />
            <p class="field-description">{{ t('settings.aiProviders.editor.keyDescription') }}</p>
            <p v-if="providerDraft.auth === 'none'" class="field-description">
              {{ t('settings.aiProviders.editor.keyNotNeeded') }}
            </p>
            <template v-else>
              <p class="field-description">
                {{ storedKeySet ? t('settings.aiProviders.editor.keySet') : t('settings.aiProviders.editor.keyUnset') }}
              </p>
              <div v-if="storedKeySet" class="cache-directory-actions">
                <vscode-button secondary @click="clearProviderSecret()">
                  {{ t('settings.aiProviders.editor.clearKey') }}
                </vscode-button>
              </div>
            </template>
          </div>

          <div class="form-row">
            <label>{{ t('settings.aiProviders.editor.models') }}</label>
            <div
              v-for="(model, index) in providerDraft.models"
              :key="`model-${index}`"
              class="repeatable-row"
              :class="{ invalid: duplicateModelIds().has(model.id.trim()) }"
            >
              <vscode-textfield
                class="repeatable-id"
                :value="model.id"
                :label="t('settings.aiProviders.editor.modelId')"
                :placeholder="t('settings.aiProviders.editor.modelId')"
                @input="model.id = ($event.target as HTMLInputElement).value"
              />
              <vscode-textfield
                class="repeatable-name"
                :value="model.name"
                :label="t('settings.aiProviders.editor.modelName')"
                :placeholder="t('settings.aiProviders.editor.modelName')"
                @input="model.name = ($event.target as HTMLInputElement).value"
              />
              <vscode-button
                secondary
                icon="trash"
                icon-only
                :title="t('settings.aiProviders.editor.removeModel')"
                :aria-label="t('settings.aiProviders.editor.removeModel')"
                @click="removeProviderModel(index)"
              />
              <p v-if="duplicateModelIds().has(model.id.trim())" class="field-description">
                {{ t('settings.aiProviders.editor.modelDuplicate') }}
              </p>
            </div>
            <p class="field-description">{{ t('settings.aiProviders.editor.modelsDescription') }}</p>
            <div class="cache-directory-actions">
              <vscode-button secondary icon="add" @click="addProviderModel">
                {{ t('settings.aiProviders.editor.addModel') }}
              </vscode-button>
            </div>
            <!--
            The automatic model probe (§4.5): one line saying what the list is
            doing or where its new rows came from, so "these rows appeared by
            themselves" always has an answer. The report below it is the host's own
            wording, and the control after it is the one the record keeps there for
            good — the retry after a failure is exactly this button.
          -->
            <p class="field-description probe-status" role="status" aria-live="polite">{{ draftProbeStatus }}</p>
            <!--
            What a successful probe must not be read as (`docs/design/settings-page.md`
            §8 question 2): the endpoint answering with a model list says only that
            this address and credential reach it, not that content may be sent to it.
            It stands next to the status line rather than in the report card because
            the card is shared with the pressed "Test connection", where the same
            sentence is off topic, and because this is where the rows the probe just
            filled in are explained.
          -->
            <p v-if="draftProbeSucceeded" class="field-description probe-consent">
              {{ t('settings.aiProviders.probe.notConsent') }}
            </p>
            <AiTestReport v-if="draftProbeReport" source="automatic" :report="draftProbeReport" />
            <div class="cache-directory-actions">
              <vscode-button
                secondary
                icon="refresh"
                :disabled="draftProbeState === 'probing' || providerDraft.baseUrl.trim() === ''"
                @click="probeDraftModels"
              >
                {{
                  draftProbeState === 'probing'
                    ? t('settings.aiProviders.probe.probingAction')
                    : t('settings.aiProviders.probe.action')
                }}
              </vscode-button>
            </div>
          </div>

          <div class="form-row">
            <label>{{ t('settings.aiProviders.editor.headers') }}</label>
            <div
              v-for="(header, index) in providerDraft.headers"
              :key="`header-${index}`"
              class="repeatable-row"
              :class="{ invalid: duplicateHeaderNames().has(header.name.trim()) || headerIsAuthOwned(header.name) }"
            >
              <vscode-textfield
                class="repeatable-id"
                :value="header.name"
                :label="t('settings.aiProviders.editor.headerName')"
                :placeholder="t('settings.aiProviders.editor.headerName')"
                @input="header.name = ($event.target as HTMLInputElement).value"
              />
              <vscode-textfield
                class="repeatable-name"
                :value="header.value"
                :label="t('settings.aiProviders.editor.headerValue')"
                :placeholder="
                  header.set ? t('settings.aiProviders.editor.headerSet') : t('settings.aiProviders.editor.headerUnset')
                "
                type="password"
                @input="header.value = ($event.target as HTMLInputElement).value"
              />
              <vscode-button
                secondary
                icon="trash"
                icon-only
                :title="t('settings.aiProviders.editor.removeHeader')"
                :aria-label="t('settings.aiProviders.editor.removeHeader')"
                @click="removeProviderHeader(index)"
              />
              <p v-if="duplicateHeaderNames().has(header.name.trim())" class="field-description">
                {{ t('settings.aiProviders.editor.headerDuplicate') }}
              </p>
              <p v-else-if="headerIsAuthOwned(header.name)" class="field-description">
                {{ t('settings.aiProviders.editor.headerShadowed') }}
              </p>
              <p v-else-if="headerQueryCarried(header.name)" class="field-description">
                {{ t('settings.aiProviders.editor.headerQueryCarried') }}
              </p>
              <div v-if="header.set && header.name.trim() !== ''" class="cache-directory-actions">
                <vscode-button secondary @click="clearProviderSecret(header.name.trim())">
                  {{ t('settings.aiProviders.editor.clearHeader') }}
                </vscode-button>
              </div>
            </div>
            <p class="field-description">{{ t('settings.aiProviders.editor.headersDescription') }}</p>
            <div class="cache-directory-actions">
              <vscode-button secondary icon="add" @click="addProviderHeader">
                {{ t('settings.aiProviders.editor.addHeader') }}
              </vscode-button>
            </div>
          </div>

          <div class="actions">
            <vscode-button
              secondary
              :disabled="editingProviderId === null || providerTestingId !== null"
              @click="editingProviderId && runProviderTest(editingProviderId)"
            >
              {{ providerTestingId ? t('settings.aiProviders.testing') : t('settings.aiProviders.test') }}
            </vscode-button>
            <vscode-button :disabled="providerSaving" @click="saveProvider">
              {{ providerSaving ? t('settings.aiProviders.editor.saving') : t('settings.aiProviders.editor.save') }}
            </vscode-button>
            <vscode-button secondary @click="requestCloseProviderEditor">
              {{ t('settings.aiProviders.editor.cancel') }}
            </vscode-button>
          </div>

          <!-- The test report the editor's own Test button produced. -->
          <AiTestReport v-if="reportForCurrentView()" source="explicit" :report="reportForCurrentView()!" />
          <!--
          The report's own next step when the endpoint answered with a model list:
          prefill the declaration from it. A control rather than an automatic write,
          because the list is the endpoint's claim about itself and the declaration
          is the user's.
        -->
          <div v-if="reportedModelsToAdd().length > 0" class="cache-directory-actions">
            <vscode-button secondary @click="addReportedModels">
              {{ t('settings.aiProviders.editor.addReportedModels', { count: reportedModelsToAdd().length }) }}
            </vscode-button>
          </div>

          <div :class="['status', providerStatus.type]" role="status" aria-live="polite">
            {{ providerStatus.message }}
          </div>
        </div>
      </div>

      <div v-else ref="listRoot" class="settings-list" :class="{ 'wide-nav': wideNav }" tabindex="-1">
        <!--
        The group navigation, in the two shapes §9.3 decides. Both are driven by
        the width the page measures for itself (`pageWidth`, read by the same
        ResizeObserver that feeds `--editor-sticky-height`), and neither is a user
        setting: there is no "layout" switch anywhere (§9.4 rule 5, §9.5 rule 4).
      -->
        <!--
        The narrow shape: one content column, and the group selector in a sticky
        bar. It is the same `vscode-single-select` this page already renders its
        enumerations with, so the narrow shape adds a control rather than a second
        navigation idiom — and it adds no column, which is the whole reason the
        wide shape can be given up.
      -->
        <div v-if="!wideNav" ref="paneBar" class="settings-pane-bar">
          <vscode-single-select
            id="settings-group-select"
            :value="currentGroup"
            :label="t('settings.groups.label')"
            @change="handleGroupSelect"
          >
            <vscode-option v-for="group in SETTINGS_GROUPS" :key="group.id" :value="group.id">
              {{ t(group.labelKey) }}
            </vscode-option>
          </vscode-single-select>
        </div>

        <!--
        The wide shape: the six group names in a vertical list beside the content,
        which is the shape VS Code's own settings page uses. It is a first-party
        list rather than a component-library one — `vscode-tabs` is a *horizontal*
        strip with no vertical presentation, `vscode-radio-group` means "pick one
        value" and draws radio dots, and a tree would claim the six groups are a
        hierarchy when they are siblings (§9.3's implementation note). Its
        `role="tablist"` + `aria-orientation="vertical"` states exactly what it is:
        a vertical set of tabs, one selected, controlling the pane below. No icons
        (§9.6 question 5, as the maintainer decided): the group names are the whole
        navigation.
      -->
        <div v-if="wideNav" class="settings-nav">
          <div
            class="settings-nav-list"
            role="tablist"
            aria-orientation="vertical"
            :aria-label="t('settings.groups.label')"
          >
            <button
              v-for="group in SETTINGS_GROUPS"
              :key="group.id"
              :id="groupTabId(group.id)"
              :ref="(element) => setGroupTab(group.id, element)"
              class="settings-nav-item"
              type="button"
              role="tab"
              :aria-selected="isCurrentGroup(group.id) ? 'true' : 'false'"
              :aria-controls="groupPanelId(group.id)"
              :tabindex="isCurrentGroup(group.id) ? 0 : -1"
              @click="selectGroup(group.id)"
              @keydown="handleGroupKeydown($event, group.id)"
            >
              {{ t(group.labelKey) }}
            </button>
          </div>
        </div>

        <div class="settings-panes">
          <!--
          The six panes, all mounted, the inactive ones hidden — see the group
          comment in the script for why unmounting them is the one thing this
          design must not do (`hidden` also removes them from the tab order, which
          is the property the two editor states keep by rendering only one of
          themselves). `[hidden]` needs its own `display: none` in the stylesheet,
          because a `display` declaration on the element beats the user agent's
          rule for the attribute and a flex pane would otherwise stay visible.
        -->
          <section
            :id="groupPanelId('general')"
            class="settings-pane"
            role="tabpanel"
            :aria-labelledby="groupTabId('general')"
            :hidden="!isCurrentGroup('general')"
            :inert="isCurrentGroup('general') ? undefined : true"
          >
            <h2 class="settings-pane-title">{{ t('settings.groups.general') }}</h2>
            <section class="setting-section">
              <h2>{{ t('settings.language') }}</h2>
              <p class="description">{{ t('settings.languageDescription') }}</p>
              <div class="form-row">
                <vscode-single-select
                  :value="selectedLocale"
                  :label="t('settings.language')"
                  @change="handleLocaleChange"
                >
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
        The developer passage (`docs/design/settings-page.md` §1.3, §3.2). It is
        the one place on this page a switch is addressed to whoever works on the
        extension rather than to whoever uses it, and it says so in its own
        heading and its first sentence: `useMockApi` intercepts every Forgejo
        request this extension makes and answers it from the build's fixtures, so
        what the page shows is sample data, not the reader's server. It needs a
        window reload because activation reads it once — and this extension has no
        reload action of its own, so the note names VS Code's own command instead
        of inventing a second one.
      -->
            <section class="setting-section">
              <h2>{{ t('settings.developer.title') }}</h2>
              <p class="description">{{ t('settings.developer.description') }}</p>
              <div class="form-row checkbox-row">
                <vscode-checkbox
                  id="use-mock-api"
                  :checked="useMockApi"
                  :disabled="!settingsSurfaceReady || surfaceBusy(DEVELOPER_SURFACE_KEYS)"
                  @change="handleUseMockApiChange"
                >
                  {{ t('settings.developer.mockApi') }}
                </vscode-checkbox>
                <p class="field-description">{{ t('settings.developer.mockApiDescription') }}</p>
                <p class="field-description">{{ t('settings.developer.mockApiReload') }}</p>
                <p v-if="sourceOverride('forgejoToolkit.useMockApi')" class="field-description source-note">
                  <span class="source-badge">{{ sourceOverride('forgejoToolkit.useMockApi')?.level }}</span>
                  {{ sourceOverride('forgejoToolkit.useMockApi')?.sentence }}
                  <button type="button" class="link-button" @click="openNativeSettings">
                    {{ t('settings.header.openNativeSettings') }}
                  </button>
                </p>
              </div>
              <div
                v-if="developerSurfaceStatus"
                :class="['status', developerSurfaceStatus.type]"
                role="status"
                aria-live="polite"
              >
                {{ developerSurfaceStatus.message }}
              </div>
            </section>
          </section>

          <section
            :id="groupPanelId('notifications')"
            class="settings-pane"
            role="tabpanel"
            :aria-labelledby="groupTabId('notifications')"
            :hidden="!isCurrentGroup('notifications')"
            :inert="isCurrentGroup('notifications') ? undefined : true"
          >
            <h2 class="settings-pane-title">{{ t('settings.groups.notifications') }}</h2>
            <!--
        Notifications. The polling switch and the polling interval are both
        settings of this section (`docs/design/settings-page.md` §1.3, §3.2): the
        dashboard explains the unread badge with the first, and the interval is the
        number the second one paces itself by, so "how often does this window ask"
        is answered where the switch that turns asking off already lives. Nothing
        is left to VS Code's own editor here, so the "more settings" pointer row
        that used to stand in the interval's place is gone (§2.2).
      -->
            <section class="setting-section">
              <h2>{{ t('settings.notifications.title') }}</h2>
              <p class="description">{{ t('settings.notifications.description') }}</p>
              <div class="form-row">
                <vscode-checkbox
                  id="notification-polling-enabled"
                  :checked="pollingEnabled"
                  :disabled="!settingsSurfaceReady || surfaceBusy(NOTIFICATION_SURFACE_KEYS)"
                  @change="handlePollingEnabledChange"
                >
                  {{ t('settings.notifications.enabled') }}
                </vscode-checkbox>
                <p class="field-description">{{ t('settings.notifications.enabledDefault') }}</p>
                <p v-if="!pollingEnabled" class="field-description">{{ t('settings.notifications.disabledHint') }}</p>
                <p
                  v-if="sourceOverride('forgejoToolkit.notificationPollingEnabled')"
                  class="field-description source-note"
                >
                  <span class="source-badge">{{
                    sourceOverride('forgejoToolkit.notificationPollingEnabled')?.level
                  }}</span>
                  {{ sourceOverride('forgejoToolkit.notificationPollingEnabled')?.sentence }}
                  <button type="button" class="link-button" @click="openNativeSettings">
                    {{ t('settings.header.openNativeSettings') }}
                  </button>
                </p>
              </div>

              <div class="form-row">
                <label for="notification-polling-interval">{{ t('settings.notifications.interval') }}</label>
                <vscode-textfield
                  id="notification-polling-interval"
                  :value="pollingIntervalField"
                  :label="t('settings.notifications.interval')"
                  type="number"
                  :disabled="!settingsSurfaceReady || surfaceBusy(NOTIFICATION_SURFACE_KEYS)"
                  @input="pollingIntervalField = ($event.target as HTMLInputElement).value"
                />
                <div class="cache-directory-actions">
                  <vscode-button
                    secondary
                    :disabled="!settingsSurfaceReady || surfaceBusy(NOTIFICATION_SURFACE_KEYS)"
                    @click="savePollingInterval"
                  >
                    {{ t('settings.notifications.intervalSave') }}
                  </vscode-button>
                </div>
                <p class="field-description">{{ t('settings.notifications.intervalDescription') }}</p>
                <p
                  v-if="sourceOverride('forgejoToolkit.notificationPollingInterval')"
                  class="field-description source-note"
                >
                  <span class="source-badge">{{
                    sourceOverride('forgejoToolkit.notificationPollingInterval')?.level
                  }}</span>
                  {{ sourceOverride('forgejoToolkit.notificationPollingInterval')?.sentence }}
                  <button type="button" class="link-button" @click="openNativeSettings">
                    {{ t('settings.header.openNativeSettings') }}
                  </button>
                </p>
              </div>

              <div class="settings-group">
                <h3>{{ t('settings.multiWindow.title') }}</h3>
                <div class="form-row">
                  <vscode-checkbox
                    id="multi-window-lease"
                    :checked="leaseEnabled"
                    :disabled="!settingsSurfaceReady || surfaceBusy(NOTIFICATION_SURFACE_KEYS)"
                    @change="handleLeaseChange"
                  >
                    {{ t('settings.multiWindow.lease') }}
                  </vscode-checkbox>
                  <p class="field-description">{{ t('settings.multiWindow.default') }}</p>
                  <!--
              The degraded case `leaseDegradedNotice` reports once in a toast has
              its readable home here: the setting is what decides whether the
              mechanism runs at all, so this is where "what happens when the
              editor cannot tell which window is focused" belongs.
            -->
                  <p class="field-description">{{ t('settings.multiWindow.description') }}</p>
                  <p v-if="!leaseEnabled" class="field-description">{{ t('settings.multiWindow.offHint') }}</p>
                  <p v-if="sourceOverride('forgejoToolkit.multiWindowLease')" class="field-description source-note">
                    <span class="source-badge">{{ sourceOverride('forgejoToolkit.multiWindowLease')?.level }}</span>
                    {{ sourceOverride('forgejoToolkit.multiWindowLease')?.sentence }}
                    <button type="button" class="link-button" @click="openNativeSettings">
                      {{ t('settings.header.openNativeSettings') }}
                    </button>
                  </p>
                </div>
              </div>

              <div
                v-if="notificationsSurfaceStatus"
                :class="['status', notificationsSurfaceStatus.type]"
                role="status"
                aria-live="polite"
              >
                {{ notificationsSurfaceStatus.message }}
              </div>
            </section>
          </section>

          <section
            :id="groupPanelId('mcp')"
            class="settings-pane"
            role="tabpanel"
            :aria-labelledby="groupTabId('mcp')"
            :hidden="!isCurrentGroup('mcp')"
            :inert="isCurrentGroup('mcp') ? undefined : true"
          >
            <h2 class="settings-pane-title">{{ t('settings.groups.mcp') }}</h2>
            <!--
        The MCP surface: the master switch, the three per-tool write gates and the
        audit's destination. They belong on one screen because they are one
        confirmation model — the gates are only understandable together
        (`docs/design/mcp-write-tools-confirmation.md` §3.3), and the audit is
        where the answer to "what did the agent change" is written.
      -->
            <section class="setting-section">
              <h2>{{ t('settings.mcp.title') }}</h2>
              <p class="description">{{ t('settings.mcp.description') }}</p>
              <div class="form-row">
                <vscode-checkbox
                  id="mcp-enabled"
                  :checked="mcpEnabledValue"
                  :disabled="!settingsSurfaceReady || surfaceBusy(MCP_SURFACE_KEYS)"
                  @change="handleMcpEnabledChange"
                >
                  {{ t('settings.mcp.enabled') }}
                </vscode-checkbox>
                <p class="field-description">{{ t('settings.mcp.enabledDefault') }}</p>
                <p v-if="!mcpEnabledValue" class="field-description">{{ t('settings.mcp.disabledHint') }}</p>
                <p v-if="sourceOverride('forgejoToolkit.mcpEnabled')" class="field-description source-note">
                  <span class="source-badge">{{ sourceOverride('forgejoToolkit.mcpEnabled')?.level }}</span>
                  {{ sourceOverride('forgejoToolkit.mcpEnabled')?.sentence }}
                  <button type="button" class="link-button" @click="openNativeSettings">
                    {{ t('settings.header.openNativeSettings') }}
                  </button>
                </p>
              </div>

              <div class="settings-group">
                <h3>{{ t('settings.mcp.writeTools.title') }}</h3>
                <p class="description">{{ t('settings.mcp.writeTools.description') }}</p>
                <div class="form-row checkbox-row">
                  <vscode-checkbox
                    id="mcp-write-create-issue-comment"
                    :checked="writeToolCreateIssueComment"
                    :disabled="!settingsSurfaceReady || surfaceBusy(MCP_SURFACE_KEYS)"
                    @change="handleWriteToolChange('createIssueComment', $event)"
                  >
                    {{ t('settings.mcp.writeTools.createIssueComment') }}
                  </vscode-checkbox>
                  <p
                    v-if="sourceOverride('forgejoToolkit.mcpWriteTools.createIssueComment')"
                    class="field-description source-note"
                  >
                    <span class="source-badge">{{
                      sourceOverride('forgejoToolkit.mcpWriteTools.createIssueComment')?.level
                    }}</span>
                    {{ sourceOverride('forgejoToolkit.mcpWriteTools.createIssueComment')?.sentence }}
                    <button type="button" class="link-button" @click="openNativeSettings">
                      {{ t('settings.header.openNativeSettings') }}
                    </button>
                  </p>
                </div>
                <div class="form-row checkbox-row">
                  <vscode-checkbox
                    id="mcp-write-submit-pull-review"
                    :checked="writeToolSubmitPullReview"
                    :disabled="!settingsSurfaceReady || surfaceBusy(MCP_SURFACE_KEYS)"
                    @change="handleWriteToolChange('submitPullReview', $event)"
                  >
                    {{ t('settings.mcp.writeTools.submitPullReview') }}
                  </vscode-checkbox>
                  <p
                    v-if="sourceOverride('forgejoToolkit.mcpWriteTools.submitPullReview')"
                    class="field-description source-note"
                  >
                    <span class="source-badge">{{
                      sourceOverride('forgejoToolkit.mcpWriteTools.submitPullReview')?.level
                    }}</span>
                    {{ sourceOverride('forgejoToolkit.mcpWriteTools.submitPullReview')?.sentence }}
                    <button type="button" class="link-button" @click="openNativeSettings">
                      {{ t('settings.header.openNativeSettings') }}
                    </button>
                  </p>
                </div>
                <div class="form-row checkbox-row">
                  <vscode-checkbox
                    id="mcp-write-cancel-action-run"
                    :checked="writeToolCancelActionRun"
                    :disabled="!settingsSurfaceReady || surfaceBusy(MCP_SURFACE_KEYS)"
                    @change="handleWriteToolChange('cancelActionRun', $event)"
                  >
                    {{ t('settings.mcp.writeTools.cancelActionRun') }}
                  </vscode-checkbox>
                  <p
                    v-if="sourceOverride('forgejoToolkit.mcpWriteTools.cancelActionRun')"
                    class="field-description source-note"
                  >
                    <span class="source-badge">{{
                      sourceOverride('forgejoToolkit.mcpWriteTools.cancelActionRun')?.level
                    }}</span>
                    {{ sourceOverride('forgejoToolkit.mcpWriteTools.cancelActionRun')?.sentence }}
                    <button type="button" class="link-button" @click="openNativeSettings">
                      {{ t('settings.header.openNativeSettings') }}
                    </button>
                  </p>
                </div>
                <!-- One line for all three: the model is "off by default, one gate per tool". -->
                <p class="field-description">{{ t('settings.mcp.writeTools.default') }}</p>
              </div>

              <div class="settings-group">
                <h3>{{ t('settings.mcp.audit.title') }}</h3>
                <div class="form-row">
                  <vscode-checkbox
                    id="mcp-write-audit-to-file"
                    :checked="mcpAuditToFile"
                    :disabled="!settingsSurfaceReady || surfaceBusy(MCP_SURFACE_KEYS)"
                    @change="handleMcpAuditChange"
                  >
                    {{ t('settings.mcp.audit.enabled') }}
                  </vscode-checkbox>
                  <p class="field-description">{{ t('settings.mcp.audit.default') }}</p>
                  <p v-if="mcpAuditToFile" class="field-description">{{ t('settings.mcp.audit.file') }}</p>
                  <p v-if="sourceOverride('forgejoToolkit.mcpWriteAuditToFile')" class="field-description source-note">
                    <span class="source-badge">{{ sourceOverride('forgejoToolkit.mcpWriteAuditToFile')?.level }}</span>
                    {{ sourceOverride('forgejoToolkit.mcpWriteAuditToFile')?.sentence }}
                    <button type="button" class="link-button" @click="openNativeSettings">
                      {{ t('settings.header.openNativeSettings') }}
                    </button>
                  </p>
                </div>
              </div>

              <div v-if="mcpSurfaceStatus" :class="['status', mcpSurfaceStatus.type]" role="status" aria-live="polite">
                {{ mcpSurfaceStatus.message }}
              </div>
            </section>
          </section>

          <section
            :id="groupPanelId('ai')"
            class="settings-pane"
            role="tabpanel"
            :aria-labelledby="groupTabId('ai')"
            :hidden="!isCurrentGroup('ai')"
            :inert="isCurrentGroup('ai') ? undefined : true"
          >
            <h2 class="settings-pane-title">{{ t('settings.groups.ai') }}</h2>
            <!--
        The whole AI area's own switch, and the only control this section has.
        It sits above the per-feature sections on purpose: this one says "do not
        use AI at all", the feature switches below say "this feature is on", and
        each feature's own consent question is what decides whether content leaves
        the machine (`docs/design/ai-model-transport.md` §8.3). It is never hidden
        and never disabled by anything it gates — it is the one control whose whole
        job is to be found when everything else is off — and when it is off the
        sentence below says what that means and how to undo it, while every other
        control on this page stays visible and editable, because this page is their
        only writable source.
      -->
            <section class="setting-section">
              <h2>{{ t('settings.ai.title') }}</h2>
              <p class="description">{{ t('settings.ai.description') }}</p>

              <div class="form-row">
                <vscode-checkbox
                  id="ai-enabled"
                  :checked="aiEnabled"
                  :disabled="!settingsSurfaceReady || surfaceBusy(AI_SURFACE_KEYS)"
                  @change="handleAiEnabledChange"
                >
                  {{ t('settings.ai.enabled') }}
                </vscode-checkbox>
                <p class="field-description">{{ t('settings.ai.enabledDefault') }}</p>
                <p v-if="!aiEnabled" class="field-description warn">{{ t('settings.ai.disabledHint') }}</p>
              </div>

              <div v-if="aiSurfaceStatus" :class="['status', aiSurfaceStatus.type]" role="status" aria-live="polite">
                {{ aiSurfaceStatus.message }}
              </div>
            </section>

            <!--
        The AI pre-review: the feature switch, the prompt scope and the chat
        model, in that order — first what turns the feature on, then what it may
        send, then which model sends it (`docs/design/settings-page.md` §3.2).
        The model's list comes from the running extension
        (`vscode.lm.selectChatModels()`), so it cannot be a contributed setting's
        dropdown; picking here writes the same value the QuickPick command does.
      -->
            <section class="setting-section">
              <h2>{{ t('settings.aiPreReview.title') }}</h2>
              <p class="description">{{ t('settings.aiPreReview.description') }}</p>

              <div class="form-row">
                <vscode-checkbox
                  id="ai-pre-review-enabled"
                  :checked="preReviewEnabled"
                  :disabled="!settingsSurfaceReady || surfaceBusy(PRE_REVIEW_SURFACE_KEYS)"
                  @change="handlePreReviewEnabledChange"
                >
                  {{ t('settings.aiPreReview.enabled') }}
                </vscode-checkbox>
                <p class="field-description">{{ t('settings.aiPreReview.enabledDefault') }}</p>
                <!--
            The two rows below stay usable while the feature is off: choosing a
            scope or a model is configuration, not use, and the consent question
            the scope exists for is asked by the run itself. The hint says what
            being off means for them instead of disabling them.
          -->
                <p v-if="!preReviewEnabled" class="field-description">{{ t('settings.aiPreReview.disabledHint') }}</p>
                <p v-if="sourceOverride('forgejoToolkit.aiPreReview')" class="field-description source-note">
                  <span class="source-badge">{{ sourceOverride('forgejoToolkit.aiPreReview')?.level }}</span>
                  {{ sourceOverride('forgejoToolkit.aiPreReview')?.sentence }}
                  <button type="button" class="link-button" @click="openNativeSettings">
                    {{ t('settings.header.openNativeSettings') }}
                  </button>
                </p>
              </div>

              <!--
          The egress scope. It is the single source of the answer — the modal asks
          once and writes here — so the page renders the host's reading and offers
          exactly the values the host accepts, from the shared enumeration. It
          never corrects a value it cannot read: the host reads such a value as
          `ask`, and that is what the select then shows.
        -->
              <div class="form-row">
                <label for="ai-pre-review-scope">{{ t('settings.aiPreReview.scope') }}</label>
                <vscode-single-select
                  id="ai-pre-review-scope"
                  :value="promptScope"
                  :label="t('settings.aiPreReview.scope')"
                  :disabled="!settingsSurfaceReady || surfaceBusy(PRE_REVIEW_SURFACE_KEYS)"
                  @change="handlePromptScopeChange"
                >
                  <vscode-option v-for="scope in AI_PRE_REVIEW_PROMPT_SCOPES" :key="scope" :value="scope">
                    {{ promptScopeLabel(scope) }}
                  </vscode-option>
                </vscode-single-select>
                <p class="field-description">{{ t('settings.aiPreReview.scopeDescription') }}</p>
                <p class="field-description">{{ t('settings.aiPreReview.scopeDefault') }}</p>
                <p v-if="sourceOverride('forgejoToolkit.aiPreReviewPromptScope')" class="field-description source-note">
                  <span class="source-badge">{{ sourceOverride('forgejoToolkit.aiPreReviewPromptScope')?.level }}</span>
                  {{ sourceOverride('forgejoToolkit.aiPreReviewPromptScope')?.sentence }}
                  <button type="button" class="link-button" @click="openNativeSettings">
                    {{ t('settings.header.openNativeSettings') }}
                  </button>
                </p>
              </div>

              <!--
          The editor's own chat-model row. It is shown exactly when the editor's
          models can serve a run (`vscode-lm`, and `auto` while it prefers them):
          under an explicit `openai-compatible` choice nothing here consults them, so
          the row is replaced by the sentence that says why and how to get it back —
          and the setting itself stays reachable in VS Code's own settings editor
          meanwhile, so it is hidden rather than removed.
        -->
              <div v-if="usesEditorModels" class="form-row">
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
                  <vscode-button
                    secondary
                    icon="refresh"
                    :disabled="aiPreReviewModelsLoading"
                    @click="loadAiPreReviewModels"
                  >
                    {{ t('settings.aiPreReviewModel.refresh') }}
                  </vscode-button>
                </div>
                <p class="field-description">{{ t('settings.aiPreReviewModel.description') }}</p>
                <p v-if="selectedAiPreReviewModelDescription" class="field-description">
                  {{ selectedAiPreReviewModelDescription }}
                </p>
                <p v-if="aiPreReviewModelNotOffered" class="field-description">
                  {{ t('settings.aiPreReviewModel.configuredNotOffered', { value: aiPreReviewModelConfigured }) }}
                </p>
                <p class="field-description">{{ t('settings.aiPreReviewModel.note') }}</p>
              </div>
              <p v-else class="field-description">
                {{ t('settings.aiProviders.policy.precedenceEndpoint') }}
              </p>
              <template v-if="usesEditorModels">
                <div v-if="aiPreReviewModelsLoading" class="empty-list">
                  {{ t('settings.aiPreReviewModel.loading') }}
                </div>
                <div v-else-if="aiPreReviewModelReason" class="empty-list">{{ aiPreReviewModelReason }}</div>
                <div
                  v-if="aiPreReviewModelStatus"
                  :class="['status', aiPreReviewModelStatus.type]"
                  role="status"
                  aria-live="polite"
                >
                  {{ aiPreReviewModelStatus.message }}
                </div>
              </template>
              <div
                v-if="preReviewSurfaceStatus"
                :class="['status', preReviewSurfaceStatus.type]"
                role="status"
                aria-live="polite"
              >
                {{ preReviewSurfaceStatus.message }}
              </div>
            </section>

            <!--
        The PR-description draft. A section of its own rather than a row under the
        pre-review: the two features have separate switches and separate scopes
        (`docs/design/ai-model-transport.md` §7.6), so the page has to show two
        pairs, and the scope dropdown is where a user who declined the modal finds
        the answer they gave.
      -->
            <section class="setting-section">
              <h2>{{ t('settings.prDescription.title') }}</h2>
              <p class="description">{{ t('settings.prDescription.description') }}</p>

              <div class="form-row">
                <vscode-checkbox
                  id="pr-description-enabled"
                  :checked="prDescriptionEnabled"
                  :disabled="!settingsSurfaceReady || surfaceBusy(PR_DESCRIPTION_SURFACE_KEYS)"
                  @change="handlePrDescriptionEnabledChange"
                >
                  {{ t('settings.prDescription.enabled') }}
                </vscode-checkbox>
                <p class="field-description">{{ t('settings.prDescription.enabledDefault') }}</p>
                <!--
            The scope row stays usable while the feature is off, for the same reason
            the pre-review's does: choosing a scope is configuration, not use.
          -->
                <p v-if="!prDescriptionEnabled" class="field-description">
                  {{ t('settings.prDescription.disabledHint') }}
                </p>
                <p v-if="sourceOverride('forgejoToolkit.prDescription')" class="field-description source-note">
                  <span class="source-badge">{{ sourceOverride('forgejoToolkit.prDescription')?.level }}</span>
                  {{ sourceOverride('forgejoToolkit.prDescription')?.sentence }}
                  <button type="button" class="link-button" @click="openNativeSettings">
                    {{ t('settings.header.openNativeSettings') }}
                  </button>
                </p>
              </div>

              <div class="form-row">
                <label for="pr-description-scope">{{ t('settings.prDescription.scope') }}</label>
                <vscode-single-select
                  id="pr-description-scope"
                  :value="prDescriptionPromptScope"
                  :label="t('settings.prDescription.scope')"
                  :disabled="!settingsSurfaceReady || surfaceBusy(PR_DESCRIPTION_SURFACE_KEYS)"
                  @change="handlePrDescriptionScopeChange"
                >
                  <vscode-option v-for="scope in PR_DESCRIPTION_PROMPT_SCOPES" :key="scope" :value="scope">
                    {{ prDescriptionScopeLabel(scope) }}
                  </vscode-option>
                </vscode-single-select>
                <p class="field-description">{{ t('settings.prDescription.scopeDescription') }}</p>
                <p class="field-description">{{ t('settings.prDescription.scopeDefault') }}</p>
                <p
                  v-if="sourceOverride('forgejoToolkit.prDescriptionPromptScope')"
                  class="field-description source-note"
                >
                  <span class="source-badge">{{
                    sourceOverride('forgejoToolkit.prDescriptionPromptScope')?.level
                  }}</span>
                  {{ sourceOverride('forgejoToolkit.prDescriptionPromptScope')?.sentence }}
                  <button type="button" class="link-button" @click="openNativeSettings">
                    {{ t('settings.header.openNativeSettings') }}
                  </button>
                </p>
              </div>

              <div
                v-if="prDescriptionSurfaceStatus"
                :class="['status', prDescriptionSurfaceStatus.type]"
                role="status"
                aria-live="polite"
              >
                {{ prDescriptionSurfaceStatus.message }}
              </div>
            </section>

            <!--
        The AI endpoints. This is the master half of the second master–detail pair;
        the editor is a state of the page, exactly as the instance editor is, and
        adding opens the same editor editing does.
      -->
            <section class="setting-section">
              <div class="section-header">
                <h2>{{ t('settings.aiProviders.title') }}</h2>
              </div>
              <p class="description">{{ t('settings.aiProviders.description') }}</p>

              <!--
          The transport choice (§3.2). It is a control here rather than a pointer to
          VS Code's own settings editor, because it is what decides which half of
          this area the page presents: the editor's own chat-model row, the endpoint
          surface, or both with `auto`'s precedence stated in one sentence. The
          select goes through the same policy write the timeout below uses, and the
          host writes only the value that differs.
        -->
              <div class="form-row">
                <label for="ai-transport">{{ t('settings.aiProviders.policy.transport') }}</label>
                <vscode-single-select
                  id="ai-transport"
                  :value="policyTransport"
                  :label="t('settings.aiProviders.policy.transport')"
                  :disabled="policySaving"
                  @change="handlePolicyTransportChange"
                >
                  <vscode-option value="auto">{{ t('settings.aiProviders.policy.transportAuto') }}</vscode-option>
                  <vscode-option value="vscode-lm">{{
                    t('settings.aiProviders.policy.transportVscodeLm')
                  }}</vscode-option>
                  <vscode-option value="openai-compatible">
                    {{ t('settings.aiProviders.policy.transportOpenAiCompatible') }}
                  </vscode-option>
                </vscode-single-select>
                <p class="field-description">{{ t('settings.aiProviders.policy.transportDescription') }}</p>
                <p v-if="policyTransport === 'auto'" class="field-description">
                  {{ t('settings.aiProviders.policy.precedenceAuto') }}
                </p>
                <p v-else-if="policyTransport === 'vscode-lm'" class="field-description">
                  {{ t('settings.aiProviders.policy.precedenceEditor') }}
                </p>
                <p v-else class="field-description">{{ t('settings.aiProviders.policy.precedenceEndpoint') }}</p>
              </div>

              <!--
          The capability block is about the route the transport actually takes, so it
          belongs to the transport choice rather than to the endpoint list: an
          explicit openai-compatible run never asks this editor's models, and the
          block would then be offering "install a chat model" as a way out of a
          choice that does not use one. It keeps both routes for every choice that
          does consult them, whatever the host's reason code is.
        -->
              <div
                v-if="usesEditorModels && capability && !capability.available"
                class="capability-block"
                role="status"
                aria-live="polite"
              >
                <p class="capability-title">{{ t('settings.aiProviders.notUsable.title') }}</p>
                <p class="field-description">{{ capabilityReason }}</p>
                <div class="capability-route" :class="{ first: !capabilityEndpointFirst }">
                  <p class="field-description">{{ t('settings.aiProviders.notUsable.installRoute') }}</p>
                  <div class="cache-directory-actions">
                    <vscode-button
                      :secondary="!capabilityEndpointFirst"
                      :disabled="providerRechecking"
                      icon="refresh"
                      @click="recheckOfferedModels"
                    >
                      {{
                        providerRechecking
                          ? t('settings.aiProviders.notUsable.rechecking')
                          : t('settings.aiProviders.notUsable.installAction')
                      }}
                    </vscode-button>
                  </div>
                </div>
                <div class="capability-route" :class="{ first: capabilityEndpointFirst }">
                  <p class="field-description">{{ t('settings.aiProviders.notUsable.endpointRoute') }}</p>
                  <div class="cache-directory-actions">
                    <vscode-button :secondary="capabilityEndpointFirst" @click="openNewProviderEditor">
                      {{ t('settings.aiProviders.notUsable.endpointAction') }}
                    </vscode-button>
                  </div>
                </div>
                <p v-if="capabilityCode === 'bind'" class="field-description">
                  {{ t('settings.aiProviders.notUsable.bindHint') }}
                </p>
                <!--
            Belt and braces for the global switch: the page renders this block from
            the endpoint snapshot and the switch from the settings surface, and the
            two are read at different moments. With AI off the two routes above do
            not fix anything, so the same sentence the switch's own section shows is
            repeated here rather than leaving the reader with advice about the wrong
            problem.
          -->
                <p v-if="capabilityCode === 'ai-off'" class="field-description">
                  {{ t('settings.ai.disabledHint') }}
                </p>
              </div>

              <div class="form-row">
                <label for="ai-request-timeout">{{ t('settings.aiProviders.policy.timeout') }}</label>
                <vscode-textfield
                  id="ai-request-timeout"
                  :value="policyTimeoutField"
                  :label="t('settings.aiProviders.policy.timeout')"
                  type="number"
                  @input="policyTimeoutField = ($event.target as HTMLInputElement).value"
                />
                <div class="cache-directory-actions">
                  <vscode-button secondary :disabled="policySaving" @click="savePolicyTimeout">
                    {{
                      policySaving
                        ? t('settings.aiProviders.policy.saving')
                        : t('settings.aiProviders.policy.timeoutSave')
                    }}
                  </vscode-button>
                </div>
                <p class="field-description">{{ t('settings.aiProviders.policy.timeoutDescription') }}</p>
              </div>

              <!--
          The endpoint surface: the list, its editor and the default destination.
          All three are configuration of the **direct** route, so the transport
          choice decides whether they are on screen — an explicit vscode-lm run
          reaches none of them. What is hidden here is hidden with the sentence that
          says so and how to bring it back (the transport select above owns it), so
          nothing becomes unreachable.
        -->
              <div v-if="usesConfiguredEndpoint">
                <div class="section-actions">
                  <vscode-button :ref="addProviderButtonRef" icon="add" @click="openNewProviderEditor">
                    {{ t('settings.aiProviders.add') }}
                  </vscode-button>
                </div>

                <!--
            The default destination, and the primary path: it is the one statement
            that makes the direct route usable for every feature at once, while the
            overrides below are opt-in. The endpoint select lists what is configured
            (plus the stored value when it names something that is not), and the
            model is free text for the reason §8.1 gives — an endpoint's model list
            is a declaration, not a whitelist.
          -->
                <div class="form-row">
                  <label for="ai-default-provider">{{ t('settings.aiProviders.defaultModel.provider') }}</label>
                  <vscode-single-select
                    id="ai-default-provider"
                    :value="defaultProvider"
                    :label="t('settings.aiProviders.defaultModel.provider')"
                    :disabled="defaultSaving"
                    @change="defaultProvider = ($event.target as HTMLSelectElement).value"
                  >
                    <vscode-option value="">{{ t('settings.aiProviders.bindings.none') }}</vscode-option>
                    <vscode-option v-for="entry in providerEntries" :key="entry.id" :value="entry.id">
                      {{ entry.name }}
                    </vscode-option>
                    <vscode-option
                      v-if="defaultProvider !== '' && !providerEntries.some((entry) => entry.id === defaultProvider)"
                      :value="defaultProvider"
                    >
                      {{ defaultProvider }}
                    </vscode-option>
                  </vscode-single-select>
                  <vscode-textfield
                    id="ai-default-model"
                    :value="defaultModel"
                    :label="t('settings.aiProviders.defaultModel.model')"
                    :placeholder="t('settings.aiProviders.defaultModel.modelPlaceholder')"
                    :disabled="defaultSaving"
                    @input="defaultModel = ($event.target as HTMLInputElement).value"
                  />
                  <div class="cache-directory-actions">
                    <vscode-button :disabled="defaultSaving" @click="saveDefaultModel()">
                      {{
                        defaultSaving
                          ? t('settings.aiProviders.defaultModel.saving')
                          : t('settings.aiProviders.defaultModel.save')
                      }}
                    </vscode-button>
                    <vscode-button secondary :disabled="defaultSaving" @click="saveDefaultModel(true)">
                      {{ t('settings.aiProviders.defaultModel.clear') }}
                    </vscode-button>
                  </div>
                  <p class="field-description">{{ t('settings.aiProviders.defaultModel.description') }}</p>
                  <p
                    v-if="defaultProvider !== '' && !providerEntries.some((entry) => entry.id === defaultProvider)"
                    class="field-description warn"
                  >
                    {{ t('settings.aiProviders.defaultModel.missingProvider', { id: defaultProvider }) }}
                  </p>
                  <p v-if="defaultProvider !== '' && defaultModel !== ''" class="field-description">
                    {{
                      t('settings.aiProviders.defaultModel.statusSet', {
                        provider: defaultProvider,
                        model: defaultModel,
                      })
                    }}
                  </p>
                  <p v-else-if="defaultProvider === '' && defaultModel === ''" class="field-description">
                    {{ t('settings.aiProviders.defaultModel.statusUnset') }}
                  </p>
                  <div
                    v-if="defaultModelStatus.message"
                    :class="['status', defaultModelStatus.type]"
                    role="status"
                    aria-live="polite"
                  >
                    {{ defaultModelStatus.message }}
                  </div>
                </div>

                <ul v-if="providerEntries.length > 0" class="saved-list">
                  <li v-for="entry in providerEntries" :key="entry.id" class="saved-item">
                    <div class="saved-info">
                      <div class="saved-name">{{ entry.name }}</div>
                      <div class="saved-url">{{ entry.address }}</div>
                      <div class="provider-facts">
                        <span class="provider-fact">{{ providerKeyFact(entry) }}</span>
                        <span v-if="entry.headers.length > 0" class="provider-fact">
                          {{
                            t('settings.aiProviders.row.headersSet', {
                              set: storedHeaderCount(entry),
                              total: entry.headers.length,
                            })
                          }}
                        </span>
                        <span v-if="providerSecretNames(entry).length > 0" class="provider-fact warn">
                          {{ t('settings.aiProviders.row.shadowed', { names: providerSecretNames(entry).join(', ') }) }}
                        </span>
                        <span v-if="entry.addressError" class="provider-fact warn">
                          {{ t('settings.aiProviders.row.addressError', { reason: entry.addressError }) }}
                        </span>
                        <span v-if="entry.insecure" class="provider-fact warn">
                          {{ t('settings.aiProviders.row.insecure') }}
                        </span>
                        <span v-if="entry.models.length === 0" class="provider-fact">
                          {{ t('settings.aiProviders.row.noModels') }}
                        </span>
                      </div>
                    </div>
                    <div class="saved-actions">
                      <vscode-button
                        secondary
                        :disabled="providerTestingId !== null"
                        @click="runProviderTest(entry.id)"
                      >
                        {{
                          providerTestingId === entry.id
                            ? t('settings.aiProviders.testing')
                            : t('settings.aiProviders.test')
                        }}
                      </vscode-button>
                      <vscode-button
                        :ref="providerEditButtonRef(entry.id)"
                        secondary
                        @click="openProviderEditor(entry)"
                      >
                        {{ t('settings.aiProviders.edit') }}
                      </vscode-button>
                      <vscode-button :disabled="providerRemovingId !== null" @click="removeProvider(entry.id)">
                        {{
                          providerRemovingId === entry.id
                            ? t('settings.aiProviders.removePending')
                            : t('settings.aiProviders.remove')
                        }}
                      </vscode-button>
                    </div>
                    <!-- The report for this row, when its own Test button produced one. -->
                    <AiTestReport
                      v-if="providerTestReportId === entry.id && providerTestReport"
                      source="explicit"
                      :report="providerTestReport"
                    />
                  </li>
                </ul>
                <div v-else class="empty-list">{{ t('settings.aiProviders.none') }}</div>

                <!--
            The entries the settings reader refused. They are named rather than hidden:
            a provider silently vanishing from the list is exactly the undiagnosable
            state this page exists to prevent, and the reason is the reader's own.
          -->
                <div v-if="providerRejections.length > 0" class="rejected-block">
                  <h3>{{ t('settings.aiProviders.rejected.title') }}</h3>
                  <p class="field-description">{{ t('settings.aiProviders.rejected.intro') }}</p>
                  <ul class="rejected-list">
                    <li v-for="entry in providerRejections" :key="`rejected-${entry.index}`">
                      {{
                        entry.id
                          ? t('settings.aiProviders.rejected.entryNamed', {
                              index: entry.index + 1,
                              id: entry.id,
                              reason: entry.reason,
                            })
                          : t('settings.aiProviders.rejected.entryUnnamed', {
                              index: entry.index + 1,
                              reason: entry.reason,
                            })
                      }}
                    </li>
                  </ul>
                </div>
              </div>

              <p v-else class="field-description">{{ t('settings.aiProviders.policy.hiddenForEditor') }}</p>

              <div v-if="policyStatus.message" :class="['status', policyStatus.type]" role="status" aria-live="polite">
                {{ policyStatus.message }}
              </div>

              <div :class="['status', providerStatus.type]" role="status" aria-live="polite">
                {{ providerStatus.message }}
              </div>
            </section>

            <!--
        The per-feature overrides. They are their own section because they answer a
        different question from the default above — which **one** feature departs
        from it, and why — and because the record keeps them a separate setting. The
        empty option on every row is the answer most features give: follow the
        default, which is what a user who configures nothing gets.
      -->
            <section class="setting-section">
              <h2>{{ t('settings.aiProviders.bindings.title') }}</h2>
              <p class="description">{{ t('settings.aiProviders.bindings.description') }}</p>
              <div v-if="bindingFeatures.length === 0" class="empty-list">
                {{ t('settings.aiProviders.bindings.empty') }}
              </div>
              <div v-for="feature in bindingFeatures" :key="`binding-${feature}`" class="form-row binding-row">
                <label :for="`ai-binding-${feature}`">{{ featureLabel(feature) }}</label>
                <vscode-single-select
                  :id="`ai-binding-${feature}`"
                  :value="bindingProvider[feature] ?? ''"
                  :label="featureLabel(feature)"
                  :disabled="bindingSaving[feature] === true"
                  @change="bindingProvider[feature] = ($event.target as HTMLSelectElement).value"
                >
                  <vscode-option value="">{{ t('settings.aiProviders.bindings.none') }}</vscode-option>
                  <vscode-option v-for="entry in providerEntries" :key="entry.id" :value="entry.id">
                    {{ entry.name }}
                  </vscode-option>
                </vscode-single-select>
                <vscode-textfield
                  :value="bindingModel[feature] ?? ''"
                  :label="t('settings.aiProviders.bindings.model')"
                  :placeholder="t('settings.aiProviders.bindings.modelPlaceholder')"
                  :disabled="bindingSaving[feature] === true"
                  @input="bindingModel[feature] = ($event.target as HTMLInputElement).value"
                />
                <p
                  v-if="
                    (bindingProvider[feature] ?? '') !== '' &&
                    !providerEntries.some((entry) => entry.id === bindingProvider[feature])
                  "
                  class="field-description warn"
                >
                  {{ t('settings.aiProviders.bindings.missingProvider', { id: bindingProvider[feature] }) }}
                </p>
                <div class="cache-directory-actions">
                  <vscode-button :disabled="bindingSaving[feature] === true" @click="saveBinding(feature)">
                    {{
                      bindingSaving[feature] === true
                        ? t('settings.aiProviders.bindings.saving')
                        : t('settings.aiProviders.bindings.save')
                    }}
                  </vscode-button>
                  <vscode-button
                    secondary
                    :disabled="bindingSaving[feature] === true"
                    @click="saveBinding(feature, true)"
                  >
                    {{ t('settings.aiProviders.bindings.clear') }}
                  </vscode-button>
                </div>
              </div>
            </section>
          </section>

          <section
            :id="groupPanelId('worktree')"
            class="settings-pane"
            role="tabpanel"
            :aria-labelledby="groupTabId('worktree')"
            :hidden="!isCurrentGroup('worktree')"
            :inert="isCurrentGroup('worktree') ? undefined : true"
          >
            <h2 class="settings-pane-title">{{ t('settings.groups.worktree') }}</h2>
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
                      <vscode-button @click="deleteWorktree(worktree.id)">{{
                        t('settings.worktree.delete')
                      }}</vscode-button>
                    </div>
                  </li>
                </ul>
              </div>
              <div v-else class="empty-list">{{ t('settings.worktree.noWorktrees') }}</div>
              <div v-if="worktreeError" class="status error">{{ worktreeError }}</div>
            </section>
          </section>

          <section
            :id="groupPanelId('instances')"
            class="settings-pane"
            role="tabpanel"
            :aria-labelledby="groupTabId('instances')"
            :hidden="!isCurrentGroup('instances')"
            :inert="isCurrentGroup('instances') ? undefined : true"
          >
            <h2 class="settings-pane-title">{{ t('settings.groups.instances') }}</h2>
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
                  <vscode-button
                    :ref="importInstancesButtonRef"
                    icon="file-directory"
                    @click="handleImportInstances"
                    secondary
                  >
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
          </section>
        </div>
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
    </template>
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
 * The editor's identity band (`docs/design/settings-page.md` §3.4).
 *
 * Three lines, in the order they are read: the way out, the title, the identity.
 * It is the block that sticks to the top of the panel's scroll column — not a
 * second, repeated strip — so the editor still has exactly one heading and the
 * record's name is never announced twice.
 *
 * A grid rather than a stack of margins, so the three lines share one left edge
 * at every width and the gap between them is one declaration. `align-content:
 * start` is what keeps a short band's rows from spreading: the band still fits
 * its own content, so the value measured into `--editor-sticky-height` stays the
 * height the fields have to clear.
 *
 * The opaque background is what makes the stickiness safe: without it the fields
 * would scroll through the band. `--vscode-sideBar-background` is the surface
 * this webview draws on — the rest of the webview uses the same token, with the
 * body's `--vscode-editor-background` as its fallback — and the hairline under
 * it (`--vscode-panel-border`) is what makes the block read as a band rather
 * than as text that happens to be above the fields.
 */
.editor-heading {
  position: sticky;
  top: 0;
  z-index: 1;
  display: grid;
  align-content: start;
  align-items: start;
  gap: 6px;
  min-width: 0;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
}

/*
 * The way out. It is the band's first line, and it holds its line: at a narrow
 * width the name and the address below give way and wrap, this control does not.
 * `justify-self` keeps it the width of its own label in a grid whose items
 * otherwise fill the column.
 *
 * `display` is stated because the `inline-flex` is what puts the codicon and the
 * label on one line: the global `.link-button` reset says `inline`, and this
 * rule's extra class is what decides between the two.
 */
.editor-heading .editor-band-back {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.9em;
  white-space: nowrap;
}

/*
 * The title. It repeats the page's `h2` element rule on purpose rather than
 * abandoning the element for a class: the two are the same declaration, and
 * stating them here is what keeps the heading the page's own `h2` style wherever
 * a later element rule lands.
 */
.editor-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

/*
 * The identity line: the record's name, then the address in monospace with its
 * copy control immediately beside it. `flex-wrap` is the narrow-width answer —
 * the name and the address move onto separate lines rather than widening the
 * panel — while `min-width: 0` on both halves is what lets either of them
 * shrink below its content width instead of holding the line open.
 */
.editor-identity {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 12px;
  min-width: 0;
}

.editor-identity-name {
  min-width: 0;
  font-size: 0.95em;
  font-weight: 600;
  overflow-wrap: anywhere;
}

/*
 * The address and the control that copies it, as one group: the copy control is
 * the address's own affordance, so it sits directly beside the value rather than
 * at the far end of the line. The value ellipsises instead of wrapping — it is
 * an address, and the field below holds it in full — while the control never
 * shrinks and never wraps, which is why the value is the half that gives way.
 */
.editor-identity-url-group {
  display: flex;
  flex: 1 1 12ch;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.editor-identity-url {
  flex: 0 1 auto;
  min-width: 0;
  font-family: var(--vscode-editor-font-family), monospace;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The copy control is a control: it keeps its size while the address shrinks. */
.editor-identity-url-group .editor-copy-url {
  flex: 0 0 auto;
}

/*
 * A short panel gets the compact form of the band: the identity line is dropped,
 * leaving the way out and the title — the two facts that say where you are and
 * how to leave.
 *
 * The measured padding above cannot rescue a panel this short on its own. It
 * moves where a focused field stops, but it cannot create scroll range: at a
 * 300 px panel the scroll is already at its end when the declared-version field
 * is reached, so the field stays where the exhausted scroll leaves it — behind
 * the band. Making the band shorter is what leaves the field room, and the
 * identity line is the part of it the editor can spare: the record is named in
 * the field below, and the address is in the URL field. `display: none` is
 * deliberately used rather than removing the group, so the band keeps one shape
 * in the DOM and the copy control keeps its place in the tab order only where it
 * is drawn.
 */
@media (max-height: 420px) {
  .editor-identity {
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
 * The group navigation (`docs/design/settings-page.md` §9.3).
 *
 * Two shapes, one current group. The wide one is a vertical list beside the
 * content — the shape the editor's own settings page uses — and the narrow one is
 * the group selector in a sticky bar, which adds no column. The switch is the
 * page's own measured width, so nothing here is a user setting.
 */
.settings-list.wide-nav {
  /* Two columns: the navigation, then the content. `flex-start` is what lets the
     sticky navigation stay at the top of the scrollport instead of stretching to
     the full height of a long content column. */
  flex-direction: row;
  align-items: flex-start;
  gap: 24px;
}

.settings-nav {
  /* 150 px is the width the threshold's arithmetic reserves for it (§9.3): the
     six names are short, and the column is a name list rather than a control
     column. `flex: 0 0` keeps it from being squeezed by a long content value. */
  flex: 0 0 150px;
  position: sticky;
  top: 0;
  min-width: 0;
}

.settings-nav-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/*
 * One group in the vertical list. It borrows the editor's own list variables —
 * selection, hover and the focus ring — so it reads as part of the editor rather
 * than as a control of ours, which is what §9.3 asks for ("只用编辑器列表那几个
 * 主题变量"). No icons: the group name is the whole item.
 */
.settings-nav-item {
  display: block;
  width: 100%;
  padding: 4px 10px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--vscode-foreground);
  font: inherit;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.settings-nav-item:hover {
  background-color: var(--vscode-list-hoverBackground);
}

.settings-nav-item[aria-selected='true'] {
  background-color: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}

/* The list is entered with Tab and navigated with the arrow keys (roving
   tabindex), so the ring is what says which item the arrow keys are on. */
.settings-nav-item:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

/*
 * The narrow shape's sticky bar. It is the block the scroll container reserves
 * space for in that shape — its height is published as `--editor-sticky-height`
 * by the same observer that measures the editors' heading, so a focused field
 * stops below it instead of under it. The opaque background is what makes that
 * safe: without it the content would scroll through the text.
 */
.settings-pane-bar {
  position: sticky;
  top: 0;
  z-index: 1;
  padding-bottom: 8px;
  background-color: var(--vscode-editor-background);
}

/*
 * The content column: the panes, one per group. It is a plain column like
 * `.settings-list` itself; the separation between groups is structural (only one
 * pane is on screen), so it needs no frame.
 */
.settings-panes {
  display: flex;
  flex-direction: column;
  gap: 24px;
  flex: 1 1 auto;
  min-width: 0;
}

/*
 * One group's pane. `[hidden]` is restated because the pane is a flex container
 * and an author `display` declaration beats the user agent's rule for the
 * attribute: without this line a hidden group would still be laid out, which is
 * exactly the failure the design's "mount everything, hide the inactive ones"
 * arrangement must not have. `hidden` is also what takes the inactive groups out
 * of the tab order — the property the two editor states keep by rendering only
 * one of themselves.
 */
.settings-pane {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}

.settings-pane[hidden] {
  display: none;
}

/*
 * The group's own name, at the top of its pane. It is the same text the
 * navigation shows (§9.6 question 5, as the maintainer decided: the name appears
 * as a heading in the content as well), and the rule under it is what separates
 * the group from the blocks inside it without turning either into a card.
 */
.settings-pane-title {
  padding-bottom: 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 1.05rem;
}

/*
 * The page header: the one control that opens VS Code's own settings editor,
 * filtered to this extension, plus the sentence saying what it is. It is a column
 * like every other block, and it is deliberately not sticky — the settings it
 * opens are not a property of the record being edited, so it does not have to
 * follow the fields.
 */
.settings-header {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

/*
 * A group inside a section: the multi-window half of the notification section,
 * the two groups of the MCP section. It is one step down the hierarchy (an `h3`
 * under the section's `h2`), and the hierarchy is carried by the heading and the
 * spacing alone — no frame, no rule down its side. A bordered box would read as a
 * card (a control), and the page's own left rules are reserved for the two places
 * that really mark something: a row the host would refuse, and a probe report.
 */
.settings-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.settings-group h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

/*
 * A source note (`docs/design/settings-page.md` §3.5): the marker plus the
 * sentence a control carries when the level that holds its effective value is not
 * the user's own, and the action that opens the filtered settings editor so the
 * reader can go and change the copy that wins. It reads as a `field-description`
 * — it is one more line under the control it is about, not a second control — and
 * its action is a link, the same shape as the page's other navigational controls.
 */
.source-note {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
}

/*
 * The level's own name, in the editor's badge colours: the same small tag VS Code
 * itself puts next to a setting it has something to say about, and the tokens
 * every other badge in this webview uses.
 */
.source-badge {
  flex: 0 0 auto;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 0.9em;
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

/*
 * The line under the endpoint editor's model rows: what the automatic probe is
 * doing, or how many rows it filled in. It is a live region so the answer arrives
 * announced rather than only painted, and it is empty (`:empty` below) until
 * there is something to say.
 */
.probe-status {
  min-height: 0;
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
 * 610 px token, wider than the default panel), in the empty state (a host reason
 * that names a setting) and in the AI endpoints section (a reader's own rejection
 * reason, a provider's address, and the sentence the endpoint probe answers with),
 * so the rule is stated once for every prose block on the page rather than
 * per string.
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
.status,
.provider-fact,
.rejected-list li,
.source-note {
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

/*
 * The §9.3 "no usable model" block.
 *
 * It is a block rather than another description line because it is the state a user
 * with no model provider lands in, and it has to be visible before the endpoint
 * list rather than after it. The left border is what makes it a block without
 * turning it into a card: a card would read as a control and as a second section,
 * and the section it belongs to is the endpoint list itself.
 */
.capability-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 8px 0 8px 12px;
  border-left: 3px solid var(--vscode-editorWarning-foreground, var(--vscode-panel-border));
}

.capability-title {
  margin: 0;
  font-size: 0.95em;
  font-weight: 600;
}

/*
 * One route of the block. The first one is the one the reason code puts first, and
 * it says so with a slightly heavier frame rather than with a colour: both routes
 * are legitimate answers, and a route drawn as "the wrong one" would be advice the
 * code does not support.
 */
.capability-route {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.capability-route.first {
  padding-left: 8px;
  border-left: 2px solid var(--vscode-focusBorder);
}

/*
 * The endpoint row's facts: one line per fact, each of which wraps rather than
 * widening the row. They are a column inside `.saved-info` (which already carries
 * the floor and the wrapping), so they only have to stack and to mark a warning.
 */
.provider-facts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
  min-width: 0;
}

.provider-fact {
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
}

/*
 * A fact that says something was refused or is insecure is stated in the theme's
 * own warning colour — the same token VS Code uses for the same kind of message —
 * and never in a colour of this view's own invention.
 */
.provider-fact.warn {
  color: var(--vscode-editorWarning-foreground);
}

/*
 * One repeatable group inside the endpoint editor: a model entry, or a header
 * name/value pair. The fields share a line while they fit and wrap when they do
 * not — the header pair is two text fields plus a remove control, which cannot fit
 * the sidebar's narrowest column — and an entry the host would refuse (a duplicate
 * name, a name the auth style owns) is marked on its own border instead of by
 * disabling it, so the user can still fix it in place.
 */
.repeatable-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
  min-width: 0;
  padding: 4px 0 4px 8px;
  border-left: 2px solid transparent;
}

.repeatable-row.invalid {
  border-left-color: var(--vscode-editorWarning-foreground, var(--vscode-panel-border));
}

.repeatable-row .repeatable-id,
.repeatable-row .repeatable-name {
  flex: 1 1 120px;
  min-width: 0;
}

/* The reason a repeatable row is marked is its own paragraph, so it takes a line. */
.repeatable-row .field-description {
  flex: 1 0 100%;
}

/*
 * The refused-entry block. It is prose about configuration, not a control, so it
 * is three stacked lines rather than a bordered box, and its list keeps the
 * markers so several entries are separable.
 */
.rejected-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.rejected-block h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

.rejected-list {
  margin: 0;
  padding-left: 20px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

/* The binding row's own fields stack; the label is the feature's name. */
.binding-row {
  min-width: 0;
}

/*
 * A description that reports a refusal is stated in the theme's own warning
 * colour — the same token VS Code uses for the same kind of message — and never
 * in a colour of this view's own invention. One rule for every such line on the
 * page: the binding that names a missing endpoint, the endpoint editor's refused
 * address, and the global AI switch while it is off.
 */
.field-description.warn {
  color: var(--vscode-editorWarning-foreground);
}
</style>
