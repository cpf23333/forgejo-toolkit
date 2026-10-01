<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { postMessage } from './composables/vscode';
import { PR_REVIEW_MAX_COMMENT_LENGTH } from '@cpf23333-forgejo-toolkit/shared/limits';
import type { AiPreReviewPanelCandidate, AiPreReviewPanelConfig } from './types/config';

/**
 * The AI pre-review confirmation panel.
 *
 * It replaces the multi-select quick pick that used to be the run's write gate.
 * That control carried each candidate's body inside its label, which VS Code
 * truncates, with no `description` and no `tooltip` for the rest — so a person
 * could not read the comment they were about to accept. Here every candidate
 * gets a card with its **own editor** holding the whole body, and the header can
 * state what the quick pick had no room for: the pull request, the model that
 * answered (with its vendor), the prompt scope that run actually used, and both
 * counts — how many candidates survived validation and how many were dropped,
 * grouped by reason.
 *
 * Three rules the panel holds to:
 *
 * 1. **Nothing is checked by default and the extension offers no accept-all
 *    control** — not a "select all" button, not a pre-ticked box. Checking a
 *    card is the act that creates a comment, so it is the user's act.
 * 2. **The body is the user's to fix before the draft exists.** Each card's
 *    editor is pre-filled with the model's wording, and the answer carries what
 *    the editor holds: the panel's job is to curate the proposal, and the only
 *    other way to fix a wording would be to create the draft first and correct it
 *    afterwards, which writes text the user has not agreed to yet. An edit is
 *    marked on its card and can be undone with "restore the wording the model
 *    proposed", so model text and the user's own text are never confused. The
 *    input is capped at `PR_REVIEW_MAX_COMMENT_LENGTH` — the same constant the
 *    brief cuts with and the host re-validates against — and reaching the cap is
 *    stated rather than cutting text silently.
 * 3. **The answer still names cards, not anchors.** The indexes are the host's
 *    card identities; paths, lines, sides and shas never travel in the message,
 *    and the host re-validates every entry before it writes anything. A modified
 *    message can therefore propose text, but it can never move a comment to
 *    another file, line or side.
 */
const { t } = useI18n();

const payload = ref<AiPreReviewPanelConfig | undefined>(window.__FORGEJO_TOOLKIT_CONFIG__?.aiPreReview);
const checked = ref<number[]>([]);
/** Set once the run has answered, so the actions are replaced by the outcome. */
const result = ref<{ created: number; failure?: string } | undefined>(undefined);
/** The host's refusal of a Create, shown beside the buttons while the question stays open. */
const rejected = ref<string | undefined>(undefined);
/** True between the create click and the run's result message. */
const submitting = ref(false);
/**
 * What each card's editor holds, keyed by card index.
 *
 * Keyed by the payload's own index rather than by array position, because the
 * index is what the answer sends and what the host validates against; a payload
 * whose indexes are not 0..n-1 therefore cannot shift one card's text onto
 * another.
 */
const bodies = ref<Record<number, string>>({});

/** The cap on one body, from the one constant the host also cuts and checks with. */
const maxBodyLength = PR_REVIEW_MAX_COMMENT_LENGTH;

const candidates = computed<AiPreReviewPanelCandidate[]>(() => payload.value?.candidates ?? []);
const checkedCount = computed(() => checked.value.length);
const checkedCandidates = computed(() => candidates.value.filter((candidate) => isChecked(candidate.index)));
/** The first checked card whose text could not be created as it stands, if any. */
const blockingCandidate = computed(() =>
  checkedCandidates.value.find((candidate) => bodyIsBlank(candidate) || bodyIsOverLimit(candidate)),
);
const canCreate = computed(
  () =>
    checkedCount.value > 0 && !submitting.value && result.value === undefined && blockingCandidate.value === undefined,
);
const isAnswered = computed(() => result.value !== undefined);

/** Pre-fills every editor with the model's wording, dropping any edit. */
function resetBodies(): void {
  const next: Record<number, string> = {};
  for (const candidate of candidates.value) {
    next[candidate.index] = candidate.body;
  }
  bodies.value = next;
}

function isChecked(index: number): boolean {
  return checked.value.includes(index);
}

function setChecked(index: number, value: boolean): void {
  const next = checked.value.filter((entry) => entry !== index);
  if (value) {
    next.push(index);
  }
  // Kept in the payload's order, which is also the order the drafts are created
  // in — the host re-orders anyway, but the panel's own count and answer should
  // not depend on the order the user happened to click.
  checked.value = candidates.value.map((candidate) => candidate.index).filter((entry) => next.includes(entry));
}

/** The anchor as the card's heading: `path:line` (or a range) and the side. */
function anchorOf(candidate: AiPreReviewPanelCandidate): string {
  const range =
    candidate.extraLines > 0 ? `${candidate.line}-${candidate.line + candidate.extraLines}` : String(candidate.line);
  return `${candidate.path}:${range} (${candidate.side === 'base' ? 'base' : 'head'})`;
}

/** The text one card's editor holds. */
function bodyOf(candidate: AiPreReviewPanelCandidate): string {
  return bodies.value[candidate.index] ?? candidate.body;
}

function setBody(index: number, value: string): void {
  bodies.value[index] = value;
}

/** Whether the editor holds anything other than the model's own wording. */
function isEdited(candidate: AiPreReviewPanelCandidate): boolean {
  return bodyOf(candidate) !== candidate.body;
}

/** Puts the model's wording back, which is the only way to undo an edit. */
function restoreBody(candidate: AiPreReviewPanelCandidate): void {
  setBody(candidate.index, candidate.body);
}

/** Whether the body would be refused by the host for being empty. */
function bodyIsBlank(candidate: AiPreReviewPanelCandidate): boolean {
  return bodyOf(candidate).trim() === '';
}

/** Whether the body would be refused by the host for being over the cap. */
function bodyIsOverLimit(candidate: AiPreReviewPanelCandidate): boolean {
  return bodyOf(candidate).length > maxBodyLength;
}

/** Whether the card can offer to open its anchor in the diff. */
function canOpenDiff(candidate: AiPreReviewPanelCandidate): boolean {
  return typeof candidate.diff?.headSha === 'string' && candidate.diff.headSha !== '';
}

function createDrafts(): void {
  submitting.value = true;
  rejected.value = undefined;
  // The checked cards in the payload's order, each with the text its editor
  // holds. Anchors are not sent at all: the host takes them from its own payload
  // and re-validates every entry before it writes anything.
  postMessage({
    command: 'aiPreReviewPanelCreate',
    entries: checked.value.map((index) => ({ index, body: bodies.value[index] ?? '' })),
  });
}

function cancel(): void {
  postMessage({ command: 'aiPreReviewPanelCancel' });
}

function openDiff(index: number): void {
  postMessage({ command: 'aiPreReviewPanelOpenDiff', index });
}

function openDraft(): void {
  postMessage({ command: 'aiPreReviewPanelOpenDraft' });
}

function handleMessage(event: MessageEvent): void {
  const data = event.data as { command?: string; payload?: AiPreReviewPanelConfig } | undefined;
  if (data?.command === 'aiPreReviewPanelPayload' && data.payload) {
    payload.value = data.payload;
    checked.value = [];
    result.value = undefined;
    rejected.value = undefined;
    submitting.value = false;
    resetBodies();
    return;
  }
  if (data?.command === 'aiPreReviewPanelRejected') {
    const received = event.data as { reason?: unknown };
    // The question stays open on purpose: the host refused the whole Create and
    // named the card it could not accept, so the user fixes that body (or
    // restores the model's wording) and presses Create again.
    if (typeof received.reason === 'string') {
      rejected.value = received.reason;
    }
    submitting.value = false;
    return;
  }
  if (data?.command === 'aiPreReviewPanelResult') {
    const received = event.data as { created?: unknown; failure?: unknown };
    result.value = {
      created: typeof received.created === 'number' ? received.created : 0,
      ...(typeof received.failure === 'string' ? { failure: received.failure } : {}),
    };
    rejected.value = undefined;
    submitting.value = false;
  }
}

resetBodies();

onMounted(() => {
  window.addEventListener('message', handleMessage);
});

onUnmounted(() => {
  window.removeEventListener('message', handleMessage);
});
</script>

<template>
  <main v-if="payload" class="panel">
    <header class="header">
      <h1 class="title">{{ t('aiPreReview.title') }}</h1>
      <p class="identity">
        {{ payload.owner }}/{{ payload.repo }}#{{ payload.index }}
        <span v-if="payload.pullRequestTitle" class="identity-title">— {{ payload.pullRequestTitle }}</span>
      </p>
      <!--
        What this run read, stated as one line rather than inferred from the
        cards: the run covers the **whole pull request**, and this is how many
        changed files that was. The "of M" form appears only when the brief's own
        table was cut short, so the header never claims the whole change was read
        when it was not.
      -->
      <p class="coverage">
        {{
          payload.changedFileCount < payload.changedFilesTotal
            ? t('aiPreReview.coveragePartial', {
                count: payload.changedFileCount,
                total: payload.changedFilesTotal,
              })
            : t('aiPreReview.coverage', { count: payload.changedFileCount })
        }}
      </p>
      <dl class="facts">
        <div class="fact">
          <dt>{{ t('aiPreReview.model') }}</dt>
          <dd>{{ payload.model.name }} ({{ payload.model.vendor }}/{{ payload.model.family }})</dd>
        </div>
        <div class="fact">
          <dt>{{ t('aiPreReview.scope') }}</dt>
          <dd>
            <code>{{ payload.scope }}</code>
          </dd>
        </div>
        <div class="fact">
          <dt>{{ t('aiPreReview.candidates') }}</dt>
          <dd>{{ t('aiPreReview.candidateCount', { count: payload.candidateCount }) }}</dd>
        </div>
        <div class="fact">
          <dt>{{ t('aiPreReview.dropped') }}</dt>
          <dd class="dropped">
            <template v-if="payload.drops.length === 0">{{ t('aiPreReview.droppedNone') }}</template>
            <template v-else>
              <span v-for="(drop, position) in payload.drops" :key="drop.label"
                >{{ position > 0 ? ', ' : '' }}{{ drop.label }} ×{{ drop.count }}</span
              >
            </template>
          </dd>
        </div>
      </dl>
      <p v-if="!isAnswered" class="hint">{{ t('aiPreReview.selectHint') }}</p>
    </header>

    <section v-if="candidates.length > 0" class="cards">
      <article v-for="candidate in candidates" :key="candidate.index" class="card">
        <div class="card-head">
          <vscode-checkbox
            :checked="isChecked(candidate.index)"
            :label="anchorOf(candidate)"
            @change="setChecked(candidate.index, ($event.target as HTMLInputElement).checked)"
          ></vscode-checkbox>
          <button
            v-if="canOpenDiff(candidate)"
            type="button"
            class="link-button open-diff"
            @click="openDiff(candidate.index)"
          >
            {{ t('aiPreReview.openDiff') }}
          </button>
        </div>
        <!--
          The body is an editor, not a read-only block: the panel's job is to
          curate the proposal, and a wording that can only be fixed after the
          draft exists would write text the user has not agreed to yet. The
          marker and the restore action appear only on an edited card, so "this
          is the model's text" and "this is mine" are never confused.
        -->
        <div v-if="isEdited(candidate)" class="edited-row">
          <span class="edited-marker">{{ t('aiPreReview.bodyEdited') }}</span>
          <button type="button" class="link-button restore" @click="restoreBody(candidate)">
            {{ t('aiPreReview.restoreBody') }}
          </button>
        </div>
        <textarea
          class="body-input"
          spellcheck="false"
          rows="4"
          :value="bodyOf(candidate)"
          :maxlength="maxBodyLength"
          :aria-label="t('aiPreReview.bodyLabel', { anchor: anchorOf(candidate) })"
          @input="setBody(candidate.index, ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
        <p v-if="bodyIsBlank(candidate)" class="warning">{{ t('aiPreReview.bodyEmpty') }}</p>
        <p v-else-if="bodyIsOverLimit(candidate)" class="warning">
          {{ t('aiPreReview.bodyOverLimit', { count: bodyOf(candidate).length, limit: maxBodyLength }) }}
        </p>
        <p v-else-if="bodyOf(candidate).length === maxBodyLength" class="truncated">
          {{ t('aiPreReview.bodyLimitReached', { limit: maxBodyLength }) }}
        </p>
        <p v-if="candidate.bodyTruncated" class="truncated">{{ t('aiPreReview.bodyTruncated') }}</p>
      </article>
    </section>
    <p v-else class="empty">{{ t('aiPreReview.empty') }}</p>

    <footer class="actions">
      <template v-if="!isAnswered">
        <vscode-button class="create" :disabled="!canCreate" @click="createDrafts">
          {{ t('aiPreReview.create', { count: checkedCount }) }}
        </vscode-button>
        <vscode-button class="cancel" secondary @click="cancel">{{ t('aiPreReview.cancel') }}</vscode-button>
        <span v-if="submitting" class="status">{{ t('aiPreReview.creating') }}</span>
        <span v-else-if="blockingCandidate" class="status">{{ t('aiPreReview.blockedHint') }}</span>
        <span v-else class="status">{{ t('aiPreReview.nothingSelected') }}</span>
        <p v-if="rejected" class="status rejected" role="alert">{{ rejected }}</p>
      </template>
      <template v-else>
        <p class="status result">
          <template v-if="result && result.failure">
            {{
              result.created > 0
                ? t('aiPreReview.resultPartial', { count: result.created, failure: result.failure })
                : t('aiPreReview.resultFailed', { failure: result.failure })
            }}
          </template>
          <template v-else>{{ t('aiPreReview.resultCreated', { count: result?.created ?? 0 }) }}</template>
        </p>
        <vscode-button v-if="payload.canOpenPullRequest" class="open-draft" @click="openDraft">
          {{ t('aiPreReview.openDraft') }}
        </vscode-button>
      </template>
    </footer>
  </main>
  <main v-else class="panel loading">{{ t('dashboard.loading') }}</main>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 20px 24px;
  max-width: 900px;
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

/* How much of the pull request this run read. Rendered in the foreground colour
   rather than as muted metadata: it is the line that says the run's scope out
   loud, and the entry point it came from is a pull-request-level one. */
.coverage {
  margin: 4px 0 0;
  color: var(--vscode-foreground);
  font-size: 0.92em;
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

.hint,
.status,
.truncated,
.empty {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 0.92em;
}

/* A body that cannot be created as it stands (empty, or over the cap). Not muted:
   it is the reason the Create button is disabled, so it has to read as a problem. */
.warning {
  margin: 4px 0 0;
  color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
  font-size: 0.92em;
}

.cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card {
  border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  border-radius: 4px;
  padding: 8px 12px 12px;
  background-color: var(--vscode-editorWidget-background, transparent);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* The edited state sits with the action that undoes it: one row, above the
   editor, so a card never looks like model text when it is the user's. */
.edited-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.edited-marker {
  color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
  font-size: 0.85em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* The body is what the quick pick could not show — and now the thing that can be
   corrected before it is written. Theme tokens only, so it looks like every other
   input in the window and takes focus the way the editor's own fields do. */
.body-input {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 6px 8px;
  background-color: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  font-family: var(--vscode-font-family), system-ui, sans-serif;
  font-size: var(--vscode-font-size);
  line-height: 1.4;
  resize: vertical;
  box-sizing: border-box;
}

.body-input:focus {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

/* Markdown is written here, so monospace would misrepresent it; the input keeps
   the editor's own font, and `resize: vertical` lets a long body be read whole. */

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding-top: 4px;
  border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
}

.status {
  color: var(--vscode-descriptionForeground);
}

/* The host's refusal of a Create: its own line, because it names the card and
   says what to do about it while the question is still open. */
.rejected {
  flex-basis: 100%;
  color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
}
</style>
