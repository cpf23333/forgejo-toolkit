<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AiProviderTestReport } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * One endpoint test's report (`docs/design/ai-model-transport.md` §8.7), as the
 * settings page renders it beside the endpoint it is about.
 *
 * The component is presentational and does nothing but lay the facts out, in the
 * order the record names them: **where the request went** first, then what came
 * back, then how long it took. The address leads because naming the destination is
 * the whole reason the probe exists; the status and the elapsed time are the two
 * numbers that tell "it works" from "it works slowly" from "that was a proxy"; and
 * the summary or the reason is the transport's own sentence, passed through rather
 * than restated here so the report and a real run cannot disagree.
 *
 * A credential is not a field of this shape and cannot be rendered by it: the report
 * carries the address without its query string (the one place a stored value could
 * reach a URL), the header names the `auth` style suppressed, and the transport's
 * own sentence, which never prints a key.
 *
 * `role="status"` with `aria-live="polite"` because the report appears after an
 * asynchronous round trip: it is empty until the answer arrives, and a region that
 * appears at the same moment as its first text is one assistive technology is
 * allowed to miss. The caller renders it only when there is a report.
 *
 * The `source` is not decoration. Since the settings page probes a draft by itself
 * (`docs/design/settings-page.md` §4), one editor can hold **two** reports at once
 * — the one an automatic probe produced and the one the pressed "Test connection"
 * produced — and their titles are built from the same outcome and the same display
 * name. Without this line the two cards are indistinguishable, which is what a live
 * walkthrough found: an automatic "was not tested" card stacked under an explicit
 * "answered" card, looking like the same card twice.
 */
const props = defineProps<{ report: AiProviderTestReport; source: 'automatic' | 'explicit' }>();

const { t } = useI18n();

/**
 * The title states the outcome in the report's own terms: answered, failed, or not
 * run at all. "Was not tested" is deliberately distinct from "failed" — a local
 * validation refusal costs nothing and has nothing to report about the endpoint.
 */
const title = computed(() =>
  props.report.ok
    ? t('settings.aiProviders.testReport.okTitle', { name: props.report.providerName })
    : props.report.ran
      ? t('settings.aiProviders.testReport.failTitle', { name: props.report.providerName })
      : t('settings.aiProviders.testReport.notRunTitle', { name: props.report.providerName }),
);

/** Which of the two places this card came from, so two cards cannot be read as one. */
const source = computed(() =>
  props.source === 'automatic'
    ? t('settings.aiProviders.testReport.sourceAutomatic')
    : t('settings.aiProviders.testReport.sourceExplicit'),
);

/** The transport's own sentence: the answer summary, or the reason there is none. */
const outcome = computed(() => (props.report.ok ? (props.report.summary ?? '') : (props.report.reason ?? '')));
</script>

<template>
  <div class="test-report" role="status" aria-live="polite">
    <p class="test-report-title">{{ title }}</p>
    <p class="test-report-source">{{ source }}</p>
    <dl class="test-report-facts">
      <div class="test-report-fact">
        <dt>{{ t('settings.aiProviders.testReport.address') }}</dt>
        <dd class="test-report-address">{{ report.address }}</dd>
      </div>
      <div v-if="report.status !== undefined" class="test-report-fact">
        <dt>{{ t('settings.aiProviders.testReport.status') }}</dt>
        <dd>{{ report.status }}</dd>
      </div>
      <div v-if="report.elapsedMs !== undefined" class="test-report-fact">
        <dt>{{ t('settings.aiProviders.testReport.elapsed') }}</dt>
        <dd>{{ t('settings.aiProviders.testReport.milliseconds', { value: report.elapsedMs }) }}</dd>
      </div>
    </dl>
    <p v-if="outcome" class="report-note">{{ outcome }}</p>
    <p v-if="report.shadowed.length > 0" class="report-note">
      {{ t('settings.aiProviders.testReport.shadowed', { names: report.shadowed.join(', ') }) }}
    </p>
  </div>
</template>

<style scoped>
/*
 * A report is a small block of facts, not a control: a panel-bordered card would
 * read as something to interact with and as a second endpoint row. The facts are a
 * definition list so the labels and the values are associated for assistive
 * technology rather than being two loose runs of text, and they wrap rather than
 * widening the panel — an address is the longest value on the page and has nowhere
 * to break.
 */
.test-report {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 8px;
  border-left: 2px solid var(--vscode-panel-border);
}

.test-report-title {
  margin: 0;
  font-size: 0.9em;
  font-weight: 600;
}

/*
 * Which of the two sources produced this card. Description-coloured rather than
 * emphasised: it is the label that tells two similar cards apart, not a second
 * outcome.
 */
.test-report-source {
  margin: 0;
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
}

.test-report-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 0;
  min-width: 0;
}

.test-report-fact {
  display: flex;
  gap: 4px;
  min-width: 0;
  font-size: 0.85em;
}

.test-report-fact dt {
  color: var(--vscode-descriptionForeground);
}

.test-report-fact dd {
  margin: 0;
  min-width: 0;
}

.test-report-address {
  font-family: var(--vscode-editor-font-family), monospace;
  overflow-wrap: anywhere;
}

.report-note {
  margin: 0;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
  overflow-wrap: anywhere;
}
</style>
