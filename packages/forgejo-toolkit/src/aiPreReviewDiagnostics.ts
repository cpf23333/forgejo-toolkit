import * as path from 'path';
import { appendMcpWriteAuditLine } from './mcpWriteAudit';
import type { AiPreReviewPromptMessage } from './aiPreReviewBrief';

/**
 * The debug-only diagnostic dump of the AI pre-review: what was sent to which
 * model, and the full raw answer it returned.
 *
 * Why this exists at all. The feature promises that the answer never reaches the
 * Output Channel — it is model output that may quote the repository, and the
 * channel is user-visible — so the log only ever carries a bounded shape
 * (`describeAiPreReviewAnswerShape`). That promise leaves a maintainer without
 * the one thing a diagnosis needs when several offered models all answer
 * something degenerate: the exact request and the exact reply. This module is
 * the escape hatch, and it is deliberately narrow:
 *
 * - **Off unless `forgejoToolkit.debug` is on.** The switch is read once per run
 *   through `logger.isDebugEnabled()`, the same gate `Logger.debug` uses, so the
 *   default path is unchanged: with debug off this module has no file path and
 *   every method returns without touching the filesystem.
 * - **Never the Output Channel.** The dump goes to
 *   `ai-pre-review-diagnostics.log` under the extension's log directory
 *   (`context.logUri`, the folder VS Code's "Open Logs Folder" opens), which is
 *   a file the maintainer chooses to read and hand over. The channel gets one
 *   line naming that path — never the text.
 * - **Self-describing and verbatim.** Every section names the model by
 *   `vendor`/`family`/`id`, carries ISO timestamps, and prints the messages and
 *   the answer between markers with their character counts, so a partial file
 *   (the size cap below can roll the oldest section away) can never be mistaken
 *   for a shorter prompt or a complete answer.
 * - **Best-effort.** A dump that cannot be written logs one line and keeps
 *   going: the diagnostic must never change what the feature does. The failure
 *   line names the error, never any part of the text.
 *
 * The module imports no `vscode`, so the formatting and the gating are testable
 * directly; the bounded append itself is the write-tool audit's own primitive
 * (`appendMcpWriteAuditLine`), which rotates the file instead of growing it
 * without limit.
 */

/** The fixed file name under the extension's log directory. */
export const AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME = 'ai-pre-review-diagnostics.log';

/**
 * Size at which the active file is rolled before the next section is appended.
 * Full prompts with the diff body on are large, so a single run can add a few
 * hundred kilobytes; 4 MB holds many runs, and the roll keeps the directory
 * bounded (`AI_PRE_REVIEW_DIAGNOSTICS_ROLLED_FILES` old copies are kept).
 */
export const AI_PRE_REVIEW_DIAGNOSTICS_MAX_BYTES = 4 * 1024 * 1024;

/** How many rolled copies are kept next to the active file. */
export const AI_PRE_REVIEW_DIAGNOSTICS_ROLLED_FILES = 1;

/**
 * The model identity as the dump prints it. Structurally identical to the
 * host's `AiPreReviewModelIdentity`; declared here so this module needs no
 * import from the `vscode`-typed host file.
 */
export interface AiPreReviewDiagnosticsModel {
  name: string;
  vendor: string;
  family: string;
  id: string;
}

/** The header of one run or probe: which kind, when, and the facts behind it. */
export interface AiPreReviewDiagnosticsSection {
  /** `run` is the command's own run; `probe` is the model probe command. */
  kind: 'run' | 'probe';
  startedAt: Date;
  /**
   * Free-form lines describing the section: the target, the settings in effect,
   * the offered models with their input budgets, the attempt bound. Plain text,
   * so a reader (or a bug report) has the context without guessing.
   */
  facts: readonly string[];
}

/**
 * One candidate stream of a response as the dump records it: which channel it
 * belongs to and the text it carried.
 *
 * It exists because the two channels of a response can disagree — measured on a
 * real machine, the `text` projection delivered the model's reasoning trace while
 * the stream's text parts held the exact expected answer — so a dump that kept
 * only the parsed answer could not show which candidate stream was used or what
 * the other one said. Structurally identical to the host's
 * `AiPreReviewResponseCandidate`; declared here so this module needs no import
 * from the `vscode`-typed host file.
 */
export interface AiPreReviewDiagnosticsCandidate {
  kind: 'text' | 'reasoning' | 'text-projection';
  text: string;
}

/** One model call: the exact messages sent and the full raw answer. */
export interface AiPreReviewDiagnosticsAttempt {
  /** Where this call sits in the section, e.g. `attempt 1/3`. */
  label: string;
  model: AiPreReviewDiagnosticsModel;
  /** The messages, in the order they were handed to `sendRequest`. */
  messages: readonly AiPreReviewPromptMessage[];
  startedAt: Date;
  finishedAt: Date;
  /**
   * The full accumulated text of the answer, verbatim. `''` when the call
   * failed before any text arrived (or was cancelled) — `outcome` then says so.
   */
  answer: string;
  /** One line: what the run made of the answer, or how the call failed. */
  outcome: string;
  /** Extra lines, e.g. the bounded shape the Output Channel also got. */
  notes?: readonly string[];
  /**
   * Every candidate stream the response offered, in preference order, each
   * **labelled** with the channel it came from. `undefined` (or empty) when the
   * call failed before a response arrived; an entry with `text: ''` says the
   * channel existed and carried nothing.
   */
  candidates?: readonly AiPreReviewDiagnosticsCandidate[];
}

/** How the dump names one candidate stream on its own line. */
function candidateKindLabel(kind: AiPreReviewDiagnosticsCandidate['kind']): string {
  switch (kind) {
    case 'text':
      return 'text parts';
    case 'reasoning':
      return 'reasoning parts';
    case 'text-projection':
      return 'the `text` projection (fallback)';
  }
}

/** What the host writes through. Every method is a no-op while debug is off. */
export interface AiPreReviewDiagnostics {
  /**
   * The absolute path of the dump, or `undefined` when debug is off (or the
   * host offers no log directory). The caller announces it on the channel.
   */
  readonly filePath: string | undefined;
  /** Appends one section header. */
  section(section: AiPreReviewDiagnosticsSection): Promise<void>;
  /** Appends one model call: the messages and the answer. */
  attempt(attempt: AiPreReviewDiagnosticsAttempt): Promise<void>;
}

/** The path of the dump inside a log directory, or `undefined` without one. */
export function aiPreReviewDiagnosticsFilePath(directory: string | undefined): string | undefined {
  if (!directory) {
    return undefined;
  }
  return path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME);
}

/**
 * The line that says what this file is. Repeated in every section on purpose:
 * the size cap can roll the oldest section away, and a reader who receives only
 * part of the file still has to know that it holds prompt and model text.
 */
const FILE_NOTICE =
  'AI pre-review diagnostics: this file contains the prompt text sent to chat models and their raw answers. ' +
  'It is written only while the setting "forgejoToolkit.debug" is on.';

/** `[2026-10-01T09:00:00.000Z]` as a section line names a moment. */
function timestamp(at: Date): string {
  return at.toISOString();
}

/** How long a call took, in whole milliseconds; negative readings are reported as 0. */
function durationMs(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

/**
 * One message as the dump prints it: the role, the exact text between markers
 * whose character count makes a truncation visible to the reader. The text is
 * deliberately printed verbatim rather than escaped — the point of the dump is
 * to be the bytes that went out — but it can never be mistaken for the file's
 * own structure, because the markers carry the count.
 */
function formatMessage(message: AiPreReviewPromptMessage, index: number, total: number): string[] {
  return [
    `--- message ${index + 1}/${total} role=${message.role} chars=${message.text.length} ---`,
    message.text,
    `--- end message ${index + 1}/${total} ---`,
  ];
}

/** The header of one section, as one text block. */
export function formatAiPreReviewDiagnosticsSection(section: AiPreReviewDiagnosticsSection): string {
  return [
    '='.repeat(78),
    FILE_NOTICE,
    `[${section.kind}] started=${timestamp(section.startedAt)}`,
    ...section.facts.map((fact) => `  ${fact}`),
  ].join('\n');
}

/** One model call, as one text block: messages first, then the raw answer. */
export function formatAiPreReviewDiagnosticsAttempt(attempt: AiPreReviewDiagnosticsAttempt): string {
  const lines = [
    `--- ${attempt.label} ---`,
    `model: ${attempt.model.name || 'unknown'} (vendor=${attempt.model.vendor || 'unknown'}, family=${
      attempt.model.family || 'unknown'
    }, id=${attempt.model.id || 'unknown'})`,
    `messages sent: ${attempt.messages.length}`,
  ];
  attempt.messages.forEach((message, index) => {
    lines.push(...formatMessage(message, index, attempt.messages.length));
  });
  lines.push(
    `requested: ${timestamp(attempt.startedAt)}`,
    `answered: ${timestamp(attempt.finishedAt)} (${durationMs(attempt.startedAt, attempt.finishedAt)} ms)`,
    `answer chars: ${attempt.answer.length}`,
    `outcome: ${attempt.outcome}`,
  );
  // Every candidate stream beside the answer the run used, each labelled and
  // printed verbatim between markers with its own character count: on a machine
  // where the two channels disagree, the one that lost has to be in the file, or
  // the dump cannot answer "which stream was that?".
  (attempt.candidates ?? []).forEach((candidate, index) => {
    lines.push(
      `candidate ${index + 1} of ${attempt.candidates?.length ?? 0} (${candidateKindLabel(candidate.kind)}): ${
        candidate.text.length
      } chars`,
      `--- candidate ${index + 1} text begin (${candidate.text.length} chars) ---`,
      candidate.text,
      `--- candidate ${index + 1} text end ---`,
    );
  });
  lines.push(`--- raw answer begin (${attempt.answer.length} chars) ---`, attempt.answer, '--- raw answer end ---');
  for (const note of attempt.notes ?? []) {
    lines.push(`note: ${note}`);
  }
  return lines.join('\n');
}

export interface AiPreReviewDiagnosticsOptions {
  /**
   * The extension's log directory (`context.logUri?.fsPath`); `undefined` on a
   * host that offers none, which leaves the dump disabled rather than somewhere
   * else.
   */
  directory: string | undefined;
  /** Whether `forgejoToolkit.debug` is on. Off means every method is a no-op. */
  enabled: boolean;
  /**
   * Called once with a plain-text line when the dump cannot be written. The
   * caller routes it to the Output Channel; it never carries prompt or answer
   * text.
   */
  onError?: (message: string) => void;
}

/**
 * Builds the sink one run (or one probe) writes through. The file path is
 * resolved once, so a run cannot start writing halfway through, and a disabled
 * sink has no path at all — the strongest form of "off".
 */
export function createAiPreReviewDiagnostics(options: AiPreReviewDiagnosticsOptions): AiPreReviewDiagnostics {
  const filePath = options.enabled ? aiPreReviewDiagnosticsFilePath(options.directory) : undefined;
  let failureLogged = false;

  const append = async (text: string): Promise<void> => {
    if (!filePath) {
      return;
    }
    try {
      await appendMcpWriteAuditLine({
        filePath,
        line: text,
        maxBytes: AI_PRE_REVIEW_DIAGNOSTICS_MAX_BYTES,
        rolledFiles: AI_PRE_REVIEW_DIAGNOSTICS_ROLLED_FILES,
      });
    } catch (error) {
      // Best-effort by contract: the diagnostic describes a request that has
      // already happened, and an unwritable file must never change the outcome.
      if (!failureLogged) {
        failureLogged = true;
        options.onError?.(
          `AI pre-review diagnostics could not be written to ${filePath} (${
            error instanceof Error ? error.message : String(error)
          }); the prompts and answers were not written anywhere else.`,
        );
      }
    }
  };

  return {
    filePath,
    async section(section) {
      await append(formatAiPreReviewDiagnosticsSection(section));
    },
    async attempt(attempt) {
      await append(formatAiPreReviewDiagnosticsAttempt(attempt));
    },
  };
}
