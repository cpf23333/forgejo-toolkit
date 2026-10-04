/**
 * The AI model transport seam: the one place an AI feature borrows a model
 * through.
 *
 * The shape is reverse-engineered from what the AI pre-review's call site
 * actually needs, and nothing more (`docs/design/ai-model-transport.md`, §4): the
 * request has to be **cancellable**, the input budget has to be measurable
 * **before** anything is sent, and an answer is not one string but a small set of
 * **candidate streams** the caller's own contract arbitrates.
 *
 * Two facts make this file deliberately thin:
 *
 * - `listModels()` and `countTokens()` only look things up. Neither sends
 *   anything, which is what makes "nothing leaves the machine before the consent
 *   question is answered" true by construction (§7.2).
 * - The seam carries no `temperature` / `max_tokens`, no tool surface, no
 *   in-request retry and no usage callback. Each of those was considered and
 *   rejected with a reason (§4.3); a transport that invented its own defaults
 *   would be guessing at an endpoint's semantics, and the retry that exists is
 *   the feature's own (one chosen model, asked again only after a contract
 *   violation).
 *
 * `docs/design/ai-model-transport.md` §4.2 is the decision record for every
 * member below.
 */

/** One model as the seam exposes it, matching today's `aiPreReviewModelIdentity` reading. */
export interface AiModelInfo {
  /** `vscode.lm`'s vendor, or a provider id. */
  vendor: string;
  id: string;
  family?: string;
  /** Display name; the empty string means "no name", and the caller supplies a fallback. */
  name: string;
  /**
   * The input budget in tokens. `vscode.lm` uses the model's `maxInputTokens`; a
   * direct endpoint cannot measure one before it has seen `/models` or a response
   * header, and reports `undefined` there — the caller then has to fall back to a
   * conservative character cap (and say so in the log). `undefined` therefore
   * means "not known", never "zero".
   */
  maxInputTokens?: number;
}

/** One role of a session history. An empty history is legal on the seam. */
export interface AiMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * What one piece of text costs in tokens; `undefined` means this model cannot
 * measure it.
 *
 * A throw and `undefined` are **not** the same thing: a throw means the
 * measurement itself failed (a broken provider, a dead process), while
 * `undefined` means "this model has no tokenizer" — the caller treats the two
 * differently.
 */
export type AiTokenCounter = (text: string, signal?: AbortSignal) => Promise<number | undefined>;

/**
 * What one request produced.
 *
 * `parts` are the **candidate streams**, in preference order: the text candidate
 * first, the reasoning candidate second, and — for `vscode.lm` only — the
 * response's documented `text` projection last, as the fallback the editor API
 * provides when no part of the stream carried text. Two candidates are **never**
 * concatenated, repaired or re-asked of another model: each one is scored on its
 * own bytes by the caller's contract.
 *
 * Tool calls, images and `usage` parts do not appear here at all: today's call
 * site classifies them as "ignore", and using them is a separate design.
 *
 * The third channel is visible on the seam as its own `'text-projection'` kind,
 * one-to-one with today's `readResponseCandidates`: the debug line, the
 * diagnostics dump and the probe's verdict all have to be able to name **which**
 * stream an answer came from (§5.4), and collapsing the projection into `'text'`
 * would make all three report the wrong channel for a response that had no
 * candidate stream at all (pinned by `src/__tests__/aiPreReview.test.ts`, which
 * must pass unchanged). A transport that has no such projection (a direct HTTP
 * endpoint) simply never produces it.
 */
export interface AiCompletionResult {
  /** The model that produced this answer (diagnostics, panel header and logs all name it). */
  model: AiModelInfo;
  /** At least one entry, in preference order. */
  parts: Array<{ kind: 'text' | 'reasoning' | 'text-projection'; text: string }>;
  /** The fragment list of the stream the answer was actually read from, when there was one. */
  fragments?: readonly string[];
  /**
   * Set when the endpoint **said** it stopped at its own output limit
   * (`finish_reason: 'length'`), so the answer is known to be incomplete.
   *
   * `truncated` is not an exception to the record's rule that a transport
   * records the endpoint's `finish_reason` (§6.4 item 5) and reports "the answer
   * was cut off" as a definite failure signal for a feature whose contract is
   * JSON (§9.2): it is that reading carried on the result, because throwing
   * instead would discard the partial answer that `vscode.lm` returns in the same
   * situation (a difference between the two transports that §11.3 forbids).
   * `undefined`/`false` means "the endpoint reported nothing, or reported
   * something else", never a guess about whether the answer looks complete.
   */
  truncated?: boolean;
}

/** One request. */
export interface AiCompletionRequest {
  /**
   * The instruction block. The `vscode.lm` implementation must join it into the
   * **single** `User` message that API supports (§5.2); an OpenAI-compatible
   * implementation puts it in a `system` message. The seam does not decide which,
   * but neither implementation may drop it.
   */
  system: string;
  /** The session history and this call's input. Today's call site sends a single `User` message. */
  messages: readonly AiMessage[];
  signal?: AbortSignal;
  /**
   * The human-readable "why this request is being made", for the transport.
   *
   * For `vscode.lm` this is the text its consent dialog shows, which is why it is
   * a sentence rather than a token; it never participates in the wire protocol.
   */
  purpose: string;
}

/**
 * One model transport.
 *
 * `listModels()` only looks up, and **sends nothing** — that is the premise the
 * "nothing is sent before the consent question is answered" rule rests on.
 * `countTokens()` is the same kind of read.
 */
export interface AiModelTransport {
  /** A stable identifier for logs and diagnostics: `'vscode.lm'` or `'openai-compatible:<providerId>'`. */
  readonly id: string;
  /** Whether this transport can serve **any** request at all; `false` carries a reason to show the user. */
  availability(signal?: AbortSignal): Promise<{ usable: true } | { usable: false; reason: string }>;
  /** The available models, in the editor's own order: no sorting and no preference. */
  listModels(signal?: AbortSignal): Promise<AiModelInfo[]>;
  /** See above: no tokenizer is `undefined`, a failed measurement throws. */
  countTokens(model: AiModelInfo, text: string, signal?: AbortSignal): Promise<number | undefined>;
  complete(model: AiModelInfo, request: AiCompletionRequest): Promise<AiCompletionResult>;
}
