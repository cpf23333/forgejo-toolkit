<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { postMessage } from './composables/vscode';
import type {
  NotificationSummaryPanelOutcome,
  NotificationSummaryPanelPayload,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The notification-summary panel: one discussion's answer, in an editor-area tab.
 *
 * It exists because the answer is **prose someone else wrote about prose someone
 * else wrote**, and the three things a reader needs about it do not fit in a
 * notification row (`docs/design/notification-summary.md` §4): which **model**
 * answered, which **scope tier this run actually used**, and whether this answer
 * was **truncated**. The header states those three as facts; the body holds the
 * answer as read-only text, selectable and copyable, with a single regenerate.
 *
 * Four properties this component holds to:
 *
 * 1. **One panel, re-rendered — never a second one.** The host owns the tab
 *    (`createWebviewPanel` with a fixed `viewType`), and every later run arrives as
 *    a `notificationSummaryPanelPayload` message that **replaces** the payload
 *    wholesale. Nothing of the previous notification is kept, so there is no way
 *    for two answers to be on screen at once and no accumulation to clean up.
 * 2. **The state is the payload, not a copy of it.** `payload` holds the message's
 *    own object, field for field. The lesson this repository already paid for
 *    (`useAppState`'s import preview: a payload grew `encrypted`, a hand-written
 *    field list dropped it, and every test stayed green) is that a handler which
 *    re-lists a payload's fields is how a field disappears; here there is no list
 *    to fall out of step.
 * 3. **A cut answer is never passed off as a complete one.** The header's
 *    truncation fact and the body's own note both appear when the payload says
 *    `truncated`, because that is the one claim the reader would otherwise make
 *    wrongly (§7).
 * 4. **Nothing here writes anything.** The only messages this panel posts are "run
 *    it again once" and "open the settings" — the run itself is host-side, and no
 *    answer of this feature reaches the server at all (§8).
 */
const { t } = useI18n();

const payload = ref<NotificationSummaryPanelPayload | undefined>(
  window.__FORGEJO_TOOLKIT_CONFIG__?.notificationSummary,
);
/**
 * Whether the single regenerate of this answer has been asked for.
 *
 * "Regenerable once" (`docs/design/notification-summary.md` §4.1) is about one
 * answer: the action is spent on the click, and a payload that arrives afterwards
 * is a new answer with its own single regenerate.
 */
const regenerated = ref(false);

/**
 * The answer's prose, when the payload actually carries any.
 *
 * `outcome: 'answer'` is the host's claim that a model produced prose; the claim and
 * the prose are read together, so a payload that says "answer" without one falls into
 * the state arm below rather than rendering a heading, three facts and an empty body —
 * a blank page under "Truncated: No" would read as a complete answer of nothing.
 */
const answerText = computed(() => {
  const answer = payload.value?.answer;
  return typeof answer === 'string' && answer.trim() !== '' ? answer : undefined;
});
const isAnswer = computed(() => payload.value?.outcome === 'answer' && answerText.value !== undefined);
const offersRegenerate = computed(() => {
  const outcome = payload.value?.outcome;
  return (
    outcome === 'answer' ||
    outcome === 'refused' ||
    outcome === 'too-long' ||
    outcome === 'read-failed' ||
    outcome === 'no-scope' ||
    outcome === 'cancelled'
  );
});
/**
 * The states whose only fix is a setting, so the panel offers the one settings
 * destination a webview can reach — the same action the settings page's own "no
 * usable model" block uses (`ai-model-transport.md` §8.7).
 */
const offersSettings = computed(() => {
  const outcome = payload.value?.outcome;
  return outcome === 'unavailable' || outcome === 'no-scope';
});

/**
 * The model's identifiers as the header renders them: `vendor/family`, and the
 * vendor alone when the model has no family.
 *
 * A configured endpoint's models carry a `vendor` (the provider's id) and an `id`
 * and no family at all, so an unconditional `vendor/family` would render
 * `(local-gateway/)` — which reads as a missing value rather than as a model that
 * has none. `AiPreReviewPanel.vue` renders the same pair the same way.
 */
const modelIdentifiers = computed(() => {
  const model = payload.value?.model;
  if (!model) {
    return '';
  }
  return (model.family ?? '').trim() === '' ? model.vendor : `${model.vendor}/${model.family}`;
});

/**
 * Which part of the run was cut, as the host spells it.
 *
 * The two cuts are different promises and must not be merged into one sentence
 * (`docs/design/notification-summary.md` §7): a cut **answer** means the endpoint
 * stopped at its own output limit, so the prose itself is incomplete; a cut
 * **material** means the model was shown a trimmed discussion — entries skipped in
 * the middle, quoted blocks removed, over-long entries cut, each already declared
 * inside the material — and the summary is faithful to what it saw, not itself cut.
 * Derived from the shared payload's own field so the spellings cannot drift.
 */
type TruncationReason = NonNullable<NotificationSummaryPanelPayload['truncationReason']>;

const truncationReason = computed<TruncationReason | undefined>(() => payload.value?.truncationReason);

/**
 * Whether anything was cut at all.
 *
 * The reason is the authority when the host sends one; the boolean it has always
 * sent is the fallback, so a payload from a host that predates the reason still gets
 * a truncation fact rather than a claim of completeness.
 */
const hasTruncation = computed(() => truncationReason.value !== undefined || payload.value?.truncated === true);

/**
 * The truncation fact's **value**, which names what was cut.
 *
 * Three-valued in the fallback for the reason the old wording was: `false` is a run
 * that made the claim and cut nothing, absent is "no run made the claim at all", and
 * the two must not print the same word. A `truncated: true` with no reason says only
 * that something was cut — it is never turned into "the answer may be incomplete",
 * which is exactly the overclaim this split exists to fix.
 */
const truncatedLabel = computed(() => {
  switch (truncationReason.value) {
    case 'answer':
      return t('notificationSummary.truncatedAnswer');
    case 'material':
      return t('notificationSummary.truncatedMaterial');
    case 'material-and-answer':
      return t('notificationSummary.truncatedBoth');
    default:
      break;
  }
  if (payload.value?.truncated === true) {
    return t('notificationSummary.truncatedUnknown');
  }
  if (payload.value?.truncated === false) {
    return t('notificationSummary.truncatedNo');
  }
  return t('notificationSummary.notRecorded');
});

/**
 * The body's own sentence about the cut, or `undefined` when there is nothing to say.
 *
 * The header states the fact; this says what it means for the prose below, and the
 * **material** arm says the opposite of the old wording on purpose: a trimmed
 * discussion makes the summary faithful to what the model saw, while only the
 * endpoint's own output limit makes the answer incomplete.
 */
const truncationNote = computed(() => {
  switch (truncationReason.value) {
    case 'answer':
      return t('notificationSummary.truncatedBodyAnswer');
    case 'material':
      return t('notificationSummary.truncatedBodyMaterial');
    case 'material-and-answer':
      return t('notificationSummary.truncatedBodyBoth');
    default:
      return payload.value?.truncated === true ? t('notificationSummary.truncatedBodyUnknown') : undefined;
  }
});

/**
 * The state's own standing sentence, one per arm of the run's outcome.
 *
 * The host writes the sentence that needs a cause only it knows — which model,
 * which endpoint, which read failed — and it travels as `failure`; what is here is
 * what is true of the arm itself, so the two can never contradict each other.
 */
const stateSentence = computed(() => {
  switch (payload.value?.outcome as NotificationSummaryPanelOutcome | undefined) {
    case 'unavailable':
      return t('notificationSummary.unavailable');
    case 'refused':
      return t('notificationSummary.refused');
    case 'empty':
      return t('notificationSummary.empty');
    case 'too-long':
      return t('notificationSummary.tooLong');
    case 'read-failed':
      return t('notificationSummary.readFailed');
    case 'no-scope':
      return t('notificationSummary.noScope');
    case 'cancelled':
      return t('notificationSummary.cancelled');
    default:
      return t('notificationSummary.failed');
  }
});

/** The host's own sentence, shown only when it adds something to the standing one. */
const failureDetail = computed(() => {
  const failure = payload.value?.failure;
  return typeof failure === 'string' && failure.trim() !== '' && failure !== stateSentence.value ? failure : undefined;
});

function regenerate(): void {
  if (regenerated.value || !offersRegenerate.value) {
    return;
  }
  regenerated.value = true;
  postMessage({ command: 'notificationSummaryRegenerate' });
}

function openSettings(): void {
  postMessage({ command: 'openNativeSettings' });
}

function handleMessage(event: MessageEvent): void {
  const data = event.data as { command?: string; payload?: NotificationSummaryPanelPayload } | undefined;
  if (data?.command === 'notificationSummaryPanelPayload' && data.payload) {
    // Assigned whole, and the one-shot regenerate is re-armed: this is a new
    // answer, whichever notification it is about. See property 1 and 2 above.
    payload.value = data.payload;
    regenerated.value = false;
  }
}

onMounted(() => {
  window.addEventListener('message', handleMessage);
});

onUnmounted(() => {
  window.removeEventListener('message', handleMessage);
});
</script>

<template>
  <main v-if="payload" class="panel notification-summary">
    <header class="header">
      <h1 class="title">{{ t('notificationSummary.title') }}</h1>
      <p class="identity summary-target">
        {{ payload.owner }}/{{ payload.repo }}#{{ payload.index }}
        <span v-if="payload.title" class="identity-title">— {{ payload.title }}</span>
      </p>
      <!--
        The three facts the record requires of this header (§4). They are stated
        even when a run never got far enough to have one, because "this run did not
        record a model" and "the model's name was empty" must not read alike — and
        the truncation fact is the one that decides whether the prose below is a
        complete answer.
      -->
      <dl class="facts">
        <div class="fact fact-model">
          <dt>{{ t('notificationSummary.model') }}</dt>
          <dd class="fact-value">
            <template v-if="payload.model">
              {{ payload.model.name }} <code class="identifiers">{{ modelIdentifiers }}</code>
            </template>
            <template v-else>{{ t('notificationSummary.modelNone') }}</template>
          </dd>
        </div>
        <div class="fact fact-scope">
          <dt>{{ t('notificationSummary.scope') }}</dt>
          <dd class="fact-value">
            <code v-if="payload.scope">{{ payload.scope }}</code>
            <template v-else>{{ t('notificationSummary.scopeNone') }}</template>
          </dd>
        </div>
        <div class="fact fact-truncated">
          <dt>{{ t('notificationSummary.truncated') }}</dt>
          <dd class="fact-value" :class="{ cut: hasTruncation }">{{ truncatedLabel }}</dd>
        </div>
      </dl>
    </header>

    <section class="body">
      <template v-if="isAnswer">
        <!--
          The header already states what was cut; the body says what that means for
          the prose below — which is the opposite claim for a trimmed discussion —
          because a reader who scrolls past the facts is exactly the reader who would
          take a cut answer for the whole discussion (§7).
        -->
        <p v-if="truncationNote" class="truncated-note">
          {{ truncationNote }}
        </p>
        <p class="answer">{{ answerText }}</p>
      </template>
      <template v-else>
        <p class="state">{{ stateSentence }}</p>
        <p v-if="failureDetail" class="failure">{{ failureDetail }}</p>
      </template>
    </section>

    <footer class="actions">
      <vscode-button v-if="offersRegenerate" class="regenerate" :disabled="regenerated" @click="regenerate">
        {{ regenerated ? t('notificationSummary.regenerated') : t('notificationSummary.regenerate') }}
      </vscode-button>
      <vscode-button v-if="offersSettings" class="open-settings" secondary @click="openSettings">
        {{ t('settings.header.openNativeSettings') }}
      </vscode-button>
      <p class="read-only">{{ t('notificationSummary.readOnly') }}</p>
    </footer>
  </main>
  <main v-else class="panel loading">{{ t('dashboard.loading') }}</main>
</template>

<style scoped>
/*
 * The panel is the reading surface the sidebar could not be (§4.1): prose gets a
 * normal line length and stays in VS Code's own type and theme tokens, so it
 * looks like every other editor-area page rather than like a branded report.
 */
.panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 20px 24px;
  max-width: 760px;
  box-sizing: border-box;
}

.loading {
  color: var(--vscode-descriptionForeground);
}

.title {
  margin: 0;
  font-size: 1.2em;
  font-weight: 600;
}

.identity {
  margin: 4px 0 0;
  color: var(--vscode-descriptionForeground);
}

.identity-title {
  color: var(--vscode-foreground);
}

.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 4px 16px;
  margin: 8px 0 0;
}

.fact {
  display: flex;
  gap: 6px;
  font-size: 0.92em;
}

.fact dt {
  color: var(--vscode-descriptionForeground);
}

.fact dd {
  margin: 0;
}

.identifiers {
  color: var(--vscode-descriptionForeground);
}

/* "This answer may be incomplete" is not muted metadata: it is the one fact that
   changes how the prose below should be read, so it takes the warning colour. */
.fact dd.cut {
  color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
  font-weight: 600;
}

.body {
  border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  padding-top: 12px;
}

/* Plain selectable text, not an editor: the answer is read-only and the only
   action on it is the one regenerate. `pre-wrap` keeps the model's own line
   breaks without letting a long token widen the page. */
.answer {
  margin: 0;
  max-width: 72ch;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.5;
  user-select: text;
}

.truncated-note {
  margin: 0 0 12px;
  max-width: 72ch;
  color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
  font-size: 0.92em;
}

.state {
  margin: 0;
  max-width: 72ch;
  line-height: 1.5;
}

.failure {
  margin: 8px 0 0;
  max-width: 72ch;
  color: var(--vscode-descriptionForeground);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  padding-top: 12px;
}

.read-only {
  flex-basis: 100%;
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
}
</style>
