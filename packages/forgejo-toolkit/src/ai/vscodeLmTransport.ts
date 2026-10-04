import * as vscode from 'vscode';
import { logger } from '../logger';
import { aiPreReviewAnswerExcerpt, aiPreReviewPromptText } from '../aiPreReviewBrief';
import { queryAiPreReviewChatModels, uniqueAiPreReviewModels } from '../aiPreReviewModels';
import { userFacingErrorMessage } from '../api/errors';
import type { AiCompletionRequest, AiCompletionResult, AiModelInfo, AiModelTransport } from './transport';

/**
 * The `vscode.lm` transport: today's code, moved — not rewritten
 * (`docs/design/ai-model-transport.md` §5.1).
 *
 * Everything in this file used to live in `src/aiPreReview.ts` and the only thing
 * that changed is its entry point. The two facts §5.2 pins are preserved
 * literally:
 *
 * 1. **No system role.** `@types/vscode` 1.102 declares
 *    `LanguageModelChatMessageRole` with only `User` and `Assistant` and
 *    `LanguageModelChatMessage` with no `System` factory, so the instruction
 *    block and the request are joined into **one** `User` message
 *    (`aiPreReviewPromptText`). One message has no half that a provider's role
 *    conversion can drop, and the budget is measured on exactly that string.
 * 2. **No `modelOptions`.** The API documents them as provider-specific ("need to
 *    be looked up in the respective documentation"), so today's code deliberately
 *    sends none, and the seam's `AiCompletionRequest` has no field for them.
 *
 * §5.5's discipline is the other half of this file: nothing here consults a
 * provider setting, an `aiTransport` switch or a binding — `listModels()` lists
 * what the editor offers, `complete()` asks the model it was handed, and there is
 * no retry, no model substitution and no fallback between transports.
 * `src/__tests__/vscodeLmTransport.test.ts` pins that by running the same calls
 * with a provider configuration present.
 *
 * The moved reading of a response is here because it is `vscode.lm`-specific: the
 * RPC `$mid` envelopes, the `LanguageModelThinkingPart` class a newer editor
 * declares, and the documented `text` projection the parts are preferred over are
 * all facts of this API, not of the seam.
 *
 * The three **read** methods (`availability`, `listModels`, `countTokens`) take no
 * cancellation token even though the seam allows one: today's lookups are not
 * cancellable, and making them cancellable would be new behaviour rather than a
 * move. Only `complete()` consumes the request's signal.
 */

/** The one `vscode.lm` transport. Stateless, so one instance is enough. */
export class VscodeLmTransport implements AiModelTransport {
  readonly id = 'vscode.lm';

  /**
   * Whether this editor has a usable language model API at all.
   *
   * `false` carries the sentence to show the user, which is today's own wording:
   * a build with no `vscode.lm` API and a listing that threw are different
   * conditions with different remedies, and both are reported by the run's own
   * dialog. "The editor offers no model" is deliberately **not** answered here:
   * that is what the list says, and the feature reports it from the list it read
   * (see `listModels`), so the "no chat model is available" sentence has one
   * owner.
   */
  async availability(): Promise<{ usable: true } | { usable: false; reason: string }> {
    const query = await queryAiPreReviewChatModels();
    if (query.status === 'no-api') {
      logger.info('This editor provides no language model API; the AI pre-review cannot run.');
      return {
        usable: false,
        reason: vscode.l10n.t(
          'This VS Code build has no language model API, so the AI pre-review cannot run. Everything else keeps working.',
        ),
      };
    }
    if (query.status === 'failed') {
      logger.error(`AI pre-review could not list chat models: ${userFacingErrorMessage(query.error)}`);
      return {
        usable: false,
        reason: vscode.l10n.t('No chat model is available. The AI pre-review was not started; nothing was created.'),
      };
    }
    return { usable: true };
  }

  /**
   * Every chat model the editor offers, deduplicated, in the editor's own order.
   *
   * The call names **no selector**: a chooser has to offer everything the editor
   * has, and a configured value is matched against that full list by the feature.
   * An empty list is a valid answer here ("this editor offers nothing"), and a
   * listing that failed answers the same way — `availability()` is what says
   * which of the two it was.
   *
   * The returned objects **are** the editor's own `LanguageModelChat` instances
   * (`AiModelInfo` is a structural subset of that class), which is what keeps
   * `complete()` and `countTokens()` on the very model this call listed and on the
   * same object a caller can still observe.
   */
  async listModels(): Promise<AiModelInfo[]> {
    const query = await queryAiPreReviewChatModels();
    return query.status === 'ok' ? uniqueAiPreReviewModels(query.models) : [];
  }

  /**
   * What one model's own tokenizer charges for the text.
   *
   * Pass-through, exactly as before: the measurement runs before any request goes
   * out, and a tokenizer that throws is reported by the feature as "could not
   * measure" rather than as a fit or a miss. `vscode.lm`'s `countTokens` answers a
   * number, so the seam's `undefined` arm means the provider broke its own
   * contract; the feature treats it as "no measurement" and the two stay distinct.
   *
   * No cancellation token is passed, matching the call this replaces: today's
   * measurement is not cancellable, and inventing a cancellation path here would
   * be new behaviour rather than a move.
   */
  async countTokens(model: AiModelInfo, text: string): Promise<number | undefined> {
    return await chatModelFor(model).countTokens(text);
  }

  /**
   * One request and the answer's candidate streams.
   *
   * The request is flattened to the single `User` message this API supports: the
   * instruction block, then the request text (`aiPreReviewPromptText`, the same
   * concatenation the feature measures its budget on). That is §5.2's documented
   * move, and it is why a multi-message history would lose its roles here — the
   * feature sends one message, and the debug probe that needs two keeps its own
   * path. `purpose` is handed to `sendRequest` as its `justification` — the API's
   * own consent-dialog text, and the only free-text field the seam carries for it.
   *
   * Cancellation is the feature's `AbortSignal`: it becomes the token
   * `sendRequest` takes, it is asked before every read step (so a cancelled sweep
   * stops at once), and a cancellation observed after the read throws an
   * `AbortError` — the shape the feature's own `isCancellation` reads by `name`,
   * never by `instanceof`. A stream that broke is **rethrown**: it is a failed
   * call, not an answer, and the feature classifies it exactly as it always did.
   */
  async complete(model: AiModelInfo, request: AiCompletionRequest): Promise<AiCompletionResult> {
    const chatModel = chatModelFor(model);
    const message = vscode.LanguageModelChatMessage.User(
      aiPreReviewPromptText(request.system, request.messages.map((entry) => entry.text).join('\n\n')),
    );
    const response = await chatModel.sendRequest(
      [message],
      { justification: request.purpose },
      cancellationTokenFrom(request.signal),
    );
    if (!response || (!isAsyncIterable(response.stream) && !isAsyncIterable(response.text))) {
      throw new Error('the model returned no response stream');
    }
    // One pass, and the fallback `text` read only if no candidate stream carried
    // text: a second consumer on the same response is the hazard this exists for.
    const { candidates, fragments } = await readResponseCandidates(response, () => request.signal?.aborted === true);
    if (request.signal?.aborted) {
      throw cancellationError();
    }
    return { model, parts: candidates, fragments };
  }
}

/** The transport `vscode.lm` an AI feature reaches the editor's models through. */
export const vscodeLmTransport = new VscodeLmTransport();

/**
 * The editor's own chat model behind one listed model, or `undefined` when the
 * value is not one this transport listed (a hand-built `AiModelInfo`, or one that
 * belongs to another transport).
 *
 * The models `listModels()` returns **are** the editor's `LanguageModelChat`
 * objects, so this is a runtime identity check at the seam's edge rather than a
 * cast: a value without `countTokens`/`sendRequest` is refused loudly instead of
 * failing later with a confusing `undefined`. The one surface that needs the
 * editor's own object is the debug-only model probe, which speaks to
 * `sendRequest` directly because its four shapes include a **two-message** request
 * the seam's one-message flattening would destroy.
 */
export function vscodeLmChatModelOf(model: AiModelInfo): vscode.LanguageModelChat | undefined {
  const candidate = model as Partial<vscode.LanguageModelChat>;
  return typeof candidate.countTokens === 'function' && typeof candidate.sendRequest === 'function'
    ? (model as vscode.LanguageModelChat)
    : undefined;
}

function chatModelFor(model: AiModelInfo): vscode.LanguageModelChat {
  const chatModel = vscodeLmChatModelOf(model);
  if (!chatModel) {
    throw new Error(
      `the vscode.lm transport cannot use the model "${model.vendor}/${model.id}", which it did not list`,
    );
  }
  return chatModel;
}

/**
 * An `AbortError`, the one shape a cancellation takes across this seam.
 *
 * `name` rather than a class, for the reason the feature's `isCancellation` gives:
 * the extension host can hand over an object from another realm, and the code
 * names are the documented contract.
 */
function cancellationError(): Error {
  const error = new Error('the request was cancelled');
  error.name = 'AbortError';
  return error;
}

/**
 * The seam's `AbortSignal` as the `CancellationToken` `sendRequest` takes.
 *
 * The editor's own token cannot be handed over: the seam carries a signal (§4.2),
 * so this adapts it — `isCancellationRequested` reads the signal, and
 * `onCancellationRequested` forwards the signal's `abort` event, answering
 * immediately when the signal is already aborted and returning a disposable that
 * detaches the listener. `undefined` stays `undefined`, so a request with no
 * signal is exactly the call it was before.
 */
function cancellationTokenFrom(signal: AbortSignal | undefined): vscode.CancellationToken | undefined {
  if (!signal) {
    return undefined;
  }
  return {
    get isCancellationRequested(): boolean {
      return signal.aborted;
    },
    onCancellationRequested(listener: (e: unknown) => unknown): { dispose(): void } {
      if (signal.aborted) {
        listener(undefined);
        return { dispose() {} };
      }
      const handler = (): void => {
        listener(undefined);
      };
      signal.addEventListener('abort', handler, { once: true });
      return { dispose: () => signal.removeEventListener('abort', handler) };
    },
  };
}

/**
 * The runtime class name of a part, or `undefined` when the value has no
 * constructor name to report (a plain object literal with a null prototype, a
 * cross-realm object whose constructor is hidden, a primitive).
 *
 * The **runtime** name is the point, and it is read from `constructor.name`
 * rather than with `instanceof`: `@types/vscode` declares the part classes
 * (`LanguageModelTextPart`, `LanguageModelToolCallPart`, …) and a real provider
 * hands over instances of exactly those classes, but a part that came from
 * another realm — or from a newer editor version the extension's typings do not
 * name yet — fails an `instanceof` against the local binding while still naming
 * its class. Naming the class is what the reader needs in order to answer "which
 * channel is this?"; a false `instanceof` would hide it behind `unknown`.
 *
 * Nothing here may throw: reading a property off a **revoked proxy** throws a
 * `TypeError`, and a diagnostic that took the whole sweep down over one
 * unreadable part would be worse than no diagnostic at all. Every read is
 * therefore guarded and the answer degrades to `undefined`.
 */
function runtimeClassName(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' && typeof value !== 'function') {
    return undefined;
  }
  try {
    const constructor = (value as { constructor?: unknown }).constructor;
    if (typeof constructor !== 'function') {
      return undefined;
    }
    const name = (constructor as { name?: unknown }).name;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/** How a part class is constructed; used only to type an optional `instanceof`. */
type AiPreReviewPartConstructor = new (...args: never[]) => unknown;

/** The `value` of a part-like object as a string, or `''` when it carries none. */
function partValueText(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const raw = (value as { value?: unknown }).value;
  return typeof raw === 'string' ? raw : '';
}

/**
 * Whether a value is something `for await` can read: an async iterable.
 *
 * Used instead of a truthiness test on a response property, because an editor
 * version without the `stream` projection still hands over a `text` one (that was
 * the only channel this feature used before the parts fix), so "the response
 * carries nothing to read" has to be asked of **both** projections rather than of
 * one of them.
 */
export function isAsyncIterable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  );
}

/**
 * The reasoning part class a **newer** editor declares and the `@types/vscode`
 * version this extension compiles against does not name yet.
 *
 * It is read as an **optional** constructor, lazily and behind a `typeof` check —
 * `instanceof` against `undefined` is simply `false` — because the class check is
 * the primary rule and a class this build of the typings cannot name must not
 * break it. The cast is the whole point: the runtime class may exist while the
 * compile-time declaration does not, and a `vscode.LanguageModelThinkingPart`
 * written directly would be a type error against `@types/vscode` 1.102.0. The
 * read is a function rather than a module-level constant because a property
 * access on the `vscode` module is not free at module load: the suite mocks the
 * module, and a mock that does not export this name would throw there rather than
 * at the one call site that needs it.
 */
function languageModelThinkingPart(): AiPreReviewPartConstructor | undefined {
  try {
    const ctor = (vscode as unknown as { LanguageModelThinkingPart?: unknown }).LanguageModelThinkingPart;
    return typeof ctor === 'function' ? (ctor as AiPreReviewPartConstructor) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A part as this module classifies it for the **answer**: which channel it
 * belongs to and, when it carries text, the text itself.
 *
 * `data` is the deliberate catch-all for everything that is not one of the
 * candidate streams — a data part (`usage`, `stateful_marker`, image bytes), a
 * tool-call part, a bare primitive, an object no rule recognises. Those are
 * named in the debug log and then ignored: no data part and no tool-call part
 * ever contributes text to an answer.
 */
type AiPreReviewPartClassification =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'data' };

/**
 * The one place that decides which channel a streamed part belongs to. Two
 * rules, tried in this order, and **neither is a `$mid` number on its own**:
 *
 * 1. The **classes the API declares** — `LanguageModelTextPart` is the text
 *    channel and `LanguageModelThinkingPart` (when the editor declares it) the
 *    reasoning channel. This is the primary rule and it is an `instanceof`, so a
 *    real provider's instances are classified correctly whatever the RPC layer
 *    does on the wire.
 * 2. The **RPC-serialised flavour** of a part that is not an instance of either
 *    class. Measured on the maintainer's machine (2026-10-01, "ninth
 *    investigation", recorded in `docs/design/ai-prereview.md`): the response's
 *    parts arrive as plain objects `{"$mid":<n>,"value":…}` — three of them are
 *    the model's reasoning token stream (`$mid=22`), the real text parts
 *    (`$mid=21`), and data parts such as `usage` / `stateful_marker`
 *    (`$mid=24`, no `value`). Those numbers are VS Code RPC envelope type ids —
 *    editor internals — so they are read as a **shape** first: an object whose
 *    own `$mid` is a number and whose `value`, when it has one, is a string.
 *    Only then does the number decide the channel, through the two static sets
 *    below, and the data set is an **exclusion list**: an unrecognised number
 *    with a string `value` falls through to `data` rather than being guessed
 *    into one of the two candidate streams.
 *
 * Why the fall-through matters. A `$mid` mapping this build does not know is
 * exactly the case where a wrong guess would put a reasoning trace into the
 * answer, or an answer fragment into the reasoning candidate — so an unknown
 * flavour stays a data part, the log still names its number, and the answer
 * degrades to the `text` projection rather than to a guess.
 *
 * Nothing here may throw: a part can be a revoked proxy or a primitive, and a
 * diagnostic beside a request may not turn one unreadable part into a failure.
 */
function classifyResponsePart(value: unknown): AiPreReviewPartClassification {
  try {
    if (typeof vscode.LanguageModelTextPart === 'function' && value instanceof vscode.LanguageModelTextPart) {
      return { kind: 'text', text: partValueText(value) };
    }
    const thinkingPart = languageModelThinkingPart();
    if (thinkingPart !== undefined && value instanceof thinkingPart) {
      return { kind: 'reasoning', text: partValueText(value) };
    }
    if (typeof vscode.LanguageModelToolCallPart === 'function' && value instanceof vscode.LanguageModelToolCallPart) {
      return { kind: 'data' };
    }
    if (typeof value !== 'object' || value === null) {
      return { kind: 'data' };
    }
    const envelope = value as { $mid?: unknown; value?: unknown };
    if (typeof envelope.$mid !== 'number') {
      return { kind: 'data' };
    }
    if (RPC_DATA_PART_MIDS.has(envelope.$mid)) {
      return { kind: 'data' };
    }
    if (typeof envelope.value !== 'string') {
      return { kind: 'data' };
    }
    if (RPC_TEXT_PART_MIDS.has(envelope.$mid)) {
      return { kind: 'text', text: envelope.value };
    }
    if (RPC_REASONING_PART_MIDS.has(envelope.$mid)) {
      return { kind: 'reasoning', text: envelope.value };
    }
    return { kind: 'data' };
  } catch {
    // A property read on a revoked proxy throws: the part is described as a
    // data part the sweep cannot read rather than allowed to break the answer.
    return { kind: 'data' };
  }
}

/**
 * The RPC flavours measured on the maintainer's machine. `$mid=21` is the real
 * text part stream and `$mid=22` the model's reasoning token stream — see
 * `classifyResponsePart` for the measurement and for why the numbers are used
 * only **after** an `instanceof` check has failed and the envelope shape has
 * been recognised.
 */
const RPC_TEXT_PART_MIDS: ReadonlySet<number> = new Set([21]);
const RPC_REASONING_PART_MIDS: ReadonlySet<number> = new Set([22]);
/**
 * `$mid=24` is the **only** data flavour measured so far, so it is also the seed
 * of the exclusion list: an envelope with a string `value` and a number this
 * build does not know stays a data part, and a future `$mid` can therefore only
 * start carrying the answer after someone has measured what it is.
 */
const RPC_DATA_PART_MIDS: ReadonlySet<number> = new Set([24]);

/**
 * The **kind** of one streamed part as the debug log names it: which channel it
 * belongs to for the answer (`text`, `reasoning`), `tool-call` for the one
 * structured part the API declares, and `unknown (<class>, typeof)` — with the
 * RPC envelope's own `$mid` spelled out — for everything else.
 *
 * The class names are string literals because they are the runtime contract:
 * the classes are identified by the name the provider's instances carry, so a
 * renamed class shows up as `unknown` beside its real name instead of being
 * silently mislabelled. The kind must never throw: the sweep exists to describe
 * what arrived, not to reject it.
 */
function responsePartKind(value: unknown): string {
  const className = runtimeClassName(value);
  if (className === 'LanguageModelTextPart') {
    return 'text';
  }
  if (className === 'LanguageModelToolCallPart') {
    return 'tool-call';
  }
  const classification = classifyResponsePart(value);
  if (classification.kind === 'text') {
    return 'text';
  }
  if (classification.kind === 'reasoning') {
    return 'reasoning';
  }
  const type = typeof value;
  const mid = rpcEnvelopeMid(value);
  const envelope = mid === undefined ? '' : `$mid=${mid}, `;
  return className ? `unknown (${envelope}${className}, typeof=${type})` : `unknown (${envelope}typeof=${type})`;
}

/** The `$mid` of an RPC-serialised envelope, or `undefined` for anything else. */
function rpcEnvelopeMid(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  try {
    const mid = (value as { $mid?: unknown }).$mid;
    return typeof mid === 'number' ? mid : undefined;
  } catch {
    return undefined;
  }
}

/** `JSON.stringify` of a part's input, or `undefined` when it cannot be stringified. */
function stringifyPartValue(value: unknown): string | undefined {
  try {
    const serialised = JSON.stringify(value);
    return typeof serialised === 'string' ? serialised : undefined;
  } catch {
    // A circular input or a bigint: the object exists, it just has no JSON form.
    return undefined;
  }
}

/**
 * The bounded shape of a part this diagnostic has no specific rendering for: the
 * JSON form when the part has one, and otherwise its **own keys** — the shape
 * rather than the value.
 *
 * Two bounds, both deliberate. The inspection is **escaped onto one line** with
 * the same `JSON.stringify` the fragment and failure excerpts use, so a newline,
 * a quote or an unterminated surrogate inside a part cannot break the log line
 * apart. And it is capped at `AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH` characters by
 * `aiPreReviewAnswerExcerpt` — the one cap the answer excerpts already obey —
 * because a data part may carry base64 or a whole document, and a debug line is
 * not a place to dump megabytes.
 *
 * Nothing here may throw. `JSON.stringify` throws on a circular object and on a
 * bigint; `Object.keys` throws on a primitive and on a revoked proxy; a
 * null-prototype object has no readable string form at all. Each of those is a
 * describeable shape, so each falls one step further down (JSON → own keys →
 * `unreadable`), because a part this sweep cannot read is still an answer while a
 * thrown diagnostic is not.
 */
function inspectPartShape(value: unknown): { text: string; raw: string; truncated: boolean } {
  const serialised = stringifyPartValue(value);
  const raw = serialised ?? ownKeysInspection(value);
  const excerpt = aiPreReviewAnswerExcerpt(raw);
  return { text: excerpt, raw, truncated: excerpt.length < raw.length };
}

/** The own keys of a value as a bounded, escaped one-liner; `unreadable` when even that throws. */
function ownKeysInspection(value: unknown): string {
  try {
    return JSON.stringify(Object.keys(value as object));
  } catch {
    // `Object.keys` throws on a primitive and on a revoked proxy: both are
    // described rather than allowed to break the sweep.
    return `unreadable(${typeof value})`;
  }
}

/**
 * One streamed part as one debug line: which part it was, its **runtime kind**,
 * its length, and its content — the text for a text part, the tool name and the
 * JSON-stringified input for a tool-call part, a bounded inspection of the shape
 * for everything else.
 *
 * The index is written `part #3 (3 so far)` rather than `#3 of 4`: a stream only
 * knows its length once it ended, and the parts are logged as they arrive (so a
 * stream that dies mid-way still shows what reached us). The honest running count
 * is therefore "so far", and the closing summary line is where the totals live.
 *
 * Why the parts beside the fragments. `LanguageModelChatResponse.text` is
 * documented as "everything except for text parts filtered out of `stream`"
 * (`@types/vscode` 1.102.0), so the fragment list describes the **projection**
 * the run parses while the parts describe the **transport** that projection came
 * from. A mangled text path beside an intact tool-call part is exactly the
 * difference this line makes visible, and it is the question the maintainer's
 * machine is stuck on: a `LanguageModelToolCallPart` carries its input as a
 * structured object, which no text-level corruption can explain away.
 *
 * `length` is the length of the payload this diagnostic renders — the text for a
 * text part, `name + " " + input` for a tool-call part, the raw inspection for
 * anything else — not the length of the capped line, so a reader can always tell
 * a short part from a capped one; the `cut` clause appears only when the
 * inspection hit the cap.
 */
function responsePartLogLine(index: number, value: unknown): string {
  const kind = responsePartKind(value);
  const where = `part #${index} (${index} so far)`;
  if (kind === 'text') {
    // The published class and the measured RPC text flavour both land here, and
    // both carry their text in `value`, so one branch renders either of them.
    const text = partValueText(value);
    const excerpt = aiPreReviewAnswerExcerpt(text);
    const cut = text.length > excerpt.length ? `, cut from ${text.length} characters` : '';
    return `AI pre-review: ${where} in the stream: kind=text, length=${text.length}, text=${JSON.stringify(
      excerpt,
    )}${cut}`;
  }
  if (kind === 'reasoning') {
    const text = partValueText(value);
    const excerpt = aiPreReviewAnswerExcerpt(text);
    const cut = text.length > excerpt.length ? `, cut from ${text.length} characters` : '';
    return `AI pre-review: ${where} in the stream: kind=reasoning, length=${text.length}, text=${JSON.stringify(
      excerpt,
    )}${cut}`;
  }
  if (kind === 'tool-call') {
    const part = value as { name?: unknown; input?: unknown };
    const name = typeof part.name === 'string' ? part.name : String(part.name);
    const input = stringifyPartValue(part.input);
    // The input is logged **whole**, escaped but uncapped, unlike the unknown
    // kinds: a tool call's input is the structured payload this diagnostic exists
    // to test for JSON validity, so an excerpt of it could hide exactly the
    // corruption being looked for. It is a tool argument rather than a document,
    // and the cap still guards the one kind that may carry one.
    const inputLog = input === undefined ? '(the input has no JSON form)' : `input=${JSON.stringify(input)}`;
    return `AI pre-review: ${where} in the stream: kind=tool-call, length=${
      (name + (input ?? '')).length
    }, tool=${JSON.stringify(name)}, ${inputLog}`;
  }
  const inspection = inspectPartShape(value);
  const cut = inspection.truncated ? `, inspection cut from ${inspection.raw.length} characters` : '';
  return `AI pre-review: ${where} in the stream: kind=${kind}, length=${
    inspection.raw.length
  }, inspection=${JSON.stringify(inspection.text)}${cut}`;
}

/**
 * The closing line of a debug part list: how many parts of each kind arrived, how
 * many text parts there were, and how many characters those text parts added up
 * to — so the transport the answer came from is one line rather than an
 * inference from the list above it.
 *
 * The kind counts are listed in the order the kinds first appeared, so the line
 * reads as a summary of the list above it and a reader can match it up by eye.
 */
function responseStreamSummaryLogLine(
  kinds: readonly string[],
  textPartCount: number,
  textPartCharacters: number,
): string {
  const counts = new Map<string, number>();
  for (const kind of kinds) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const tally = counts.size === 0 ? 'no parts' : [...counts].map(([kind, count]) => `${count} ${kind}`).join(', ');
  return `AI pre-review: part stream summary: ${kinds.length} part(s) (${tally}), ${textPartCount} text part(s) carrying ${textPartCharacters} character(s)`;
}

/**
 * Logs the parts of one response, then the tally and the **only** fact about the
 * `text` projection this pass still needs — the **debug-only** second half of the
 * transport dump.
 *
 * The parts arrive already collected and already classified. That is the change
 * the ninth investigation forced: `stream` is consumed **once**, by
 * `readResponseStreamParts`, because `stream` and `text` may be two projections of
 * one cursor and a second reader on the same response is the hazard this whole
 * change exists to remove. A request whose two projections share one cursor
 * therefore can no longer be misread as "the stream offered no parts": what the
 * collector saw is what this line reports.
 *
 * What may never appear. Only what came back: the prompt, the brief and the diff
 * are not arguments of this function. Every line goes through `logger.debug`
 * behind `logger.isDebugEnabled()`, the one gate `forgejoToolkit.debug` owns, so
 * nothing here is user-visible — no message, toast or notification — and with
 * debug off `readResponseStreamParts` skips this function entirely.
 */
function logResponseStreamParts(
  debug: ResponseStreamDebug,
  textFragments: readonly string[],
  textProjectionRead: boolean,
  textProjectionLength: number,
): void {
  if (!logger.isDebugEnabled()) {
    return;
  }
  debug.parts.forEach((part, index) => {
    logger.debug(responsePartLogLine(index + 1, part));
  });
  const textPartCharacters = textFragments.reduce((total, fragment) => total + fragment.length, 0);
  logger.debug(responseStreamSummaryLogLine(debug.kinds, textFragments.length, textPartCharacters));
  if (debug.dataPartCount > 0) {
    // A data part carrying `usage` is the one thing in that channel worth naming:
    // it is where the call's own accounting lives, and a reader comparing a run's
    // token budget with what the provider charged looks here.
    logger.debug(
      `AI pre-review: part stream summary: ${debug.dataPartCount} data part(s) carried no answer text (${debug.dataPartShapes.join('; ')})`,
    );
  }
  if (debug.stopped) {
    logger.debug('AI pre-review: part stream summary: the sweep stopped early, so the totals above are partial');
  }
  if (!textProjectionRead) {
    // The single-consumer rule, stated rather than left to be inferred: no
    // candidate stream carried text, so the `text` projection was never read and
    // there is nothing to compare the parts against.
    logger.debug(
      'AI pre-review: part stream summary: no candidate stream carried text, so the `text` projection was not read',
    );
    return;
  }
  logger.debug(
    `AI pre-review: part stream summary: the \`text\` projection carries ${textProjectionLength} character(s)`,
  );
}

/**
 * The **debug** record of one response's parts: every part that arrived, the
 * kind of each, the text parts' texts, and whether the sweep stopped early.
 *
 * It exists so the parts are consumed **once**: the collector fills it while it
 * classifies, and the log renders it afterwards. Nothing in it is a candidate —
 * the candidates are built from the same pass.
 */
interface ResponseStreamDebug {
  /** Every part, in arrival order, for the per-part log line. */
  parts: unknown[];
  /** The kind of each part, in arrival order, for the tally. */
  kinds: string[];
  /** Data parts that arrived, for the one line about them. */
  dataPartCount: number;
  /** A bounded inspection of each data part's shape (`usage` is the interesting one). */
  dataPartShapes: string[];
  /** True when the sweep stopped before the stream did (the caller's cancellation). */
  stopped: boolean;
}

/** The two candidate streams of one response, plus the debug record of its parts. */
interface AiPreReviewResponseStreamCollector {
  /** `LanguageModelTextPart` instances and the measured RPC text flavour, in arrival order. */
  textParts: string[];
  /** `LanguageModelThinkingPart` instances and the measured RPC reasoning flavour. */
  reasoningParts: string[];
  debug: ResponseStreamDebug;
}

/**
 * One candidate stream of a response: a channel the provider may have put the
 * **answer** on, with the text it carried.
 *
 * `kind` is named after the channel rather than after a class, because a channel
 * has more than one runtime shape (the published class and the RPC flavour the
 * maintainer's machine shows) and the arbitration and the log must talk about the
 * channel, not about one of its encodings.
 */
export type AiPreReviewResponseCandidate = {
  /**
   * - `text`: the response's text parts — `LanguageModelTextPart` instances and
   *   the measured RPC text flavour.
   * - `reasoning`: the response's reasoning parts — `LanguageModelThinkingPart`
   *   instances and the measured RPC reasoning flavour.
   * - `text-projection`: the documented `response.text` projection, used **only**
   *   when no part of the stream carried text at all.
   */
  kind: 'text' | 'reasoning' | 'text-projection';
  text: string;
};

/**
 * Consumes the **`stream` projection of a response exactly once** and collects
 * its parts into the separate candidate channels, plus the debug record of what
 * arrived.
 *
 * Why one pass and no second reader. `stream` and `text` are two projections of
 * one response, and the editor may hand over two independent iterators (each
 * property read re-reads the proxy) or one cursor the first reader drains. Two
 * readers on one response is therefore a race whose outcome depends on the
 * editor's internals — which is exactly the hazard this change removes: the
 * `text` projection is read **only** when this pass found no candidate stream
 * carrying text (see `readResponseStreamParts`).
 *
 * Why the parts are kept rather than logged on the way past. The candidate they
 * belong to is only known once the **caller's contract** has scored them, and the
 * log has to say which one was used; so this pass records every part (when debug
 * is on) and the caller renders the list afterwards, in
 * `logResponseStreamParts`. The list is still complete for a stream that ended
 * early, because everything that arrived before the break is in it.
 *
 * An error from `next()` is **rethrown**: a stream that broke is a failed model
 * call, not an answer, and the feature's own `classifyModelError` is what turns an
 * `AbortError` into a cancellation. `checkCancelled` is asked before every step
 * for the same reason the fragment list is only written on a completed stream — a
 * half-read stream has no honest totals, and the caller's own cancellation check
 * has already run.
 */
async function collectResponseStreamParts(
  response: { stream?: AsyncIterable<unknown> },
  checkCancelled: () => boolean,
): Promise<AiPreReviewResponseStreamCollector> {
  const collector: AiPreReviewResponseStreamCollector = {
    textParts: [],
    reasoningParts: [],
    debug: { parts: [], kinds: [], dataPartCount: 0, dataPartShapes: [], stopped: false },
  };
  const debugEnabled = logger.isDebugEnabled();
  const stream = response.stream;
  if (!stream || typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
    if (debugEnabled) {
      logger.debug(
        'AI pre-review: part stream summary: the response carries no stream iterable, so no part could be inspected',
      );
    }
    return collector;
  }
  try {
    const iterator = stream[Symbol.asyncIterator]();
    for (;;) {
      if (checkCancelled()) {
        collector.debug.stopped = true;
        break;
      }
      const step = await iterator.next();
      if (step.done) {
        break;
      }
      const classification = classifyResponsePart(step.value);
      if (classification.kind === 'text') {
        collector.textParts.push(classification.text);
      } else if (classification.kind === 'reasoning') {
        collector.reasoningParts.push(classification.text);
      }
      if (debugEnabled) {
        const kind = responsePartKind(step.value);
        collector.debug.parts.push(step.value);
        collector.debug.kinds.push(kind);
        if (classification.kind === 'data') {
          collector.debug.dataPartCount += 1;
          collector.debug.dataPartShapes.push(inspectPartShape(step.value).text);
        }
      }
    }
  } catch (error) {
    // The provider's own abort, or a `next()` that threw: what arrived is already
    // in the debug record, and the error is **rethrown** because a stream that
    // broke is a failed model call, not an answer — the feature's own
    // `classifyModelError` is what turns an `AbortError` into a cancellation and
    // anything else into the failure it reports, exactly as it did when this loop
    // was the `text` projection's.
    collector.debug.stopped = true;
    throw error;
  }
  return collector;
}

/**
 * Reads the documented `text` projection of a response, **once**, into a local —
 * the fallback the arbitration uses only when no candidate stream carried text.
 *
 * `undefined` covers every way there is nothing to read: no `text` property at
 * all (the older editor shape this code used to reject outright), a value that is
 * not an async iterable, and a `text` getter or iteration that throws. The last
 * one is the reason the read is wrapped: with the parts already in hand, a
 * failing projection is not a failed call — it is simply no fallback, and the
 * caller reports that in its own terms.
 */
async function readTextProjection(response: { text?: AsyncIterable<string> }): Promise<string | undefined> {
  const projected = response.text;
  if (!projected || typeof (projected as AsyncIterable<string>)[Symbol.asyncIterator] !== 'function') {
    return undefined;
  }
  try {
    let text = '';
    for await (const chunk of projected) {
      text += chunk;
    }
    return text;
  } catch {
    return undefined;
  }
}

/**
 * The candidate streams of one response, in preference order, consuming the
 * response **once**.
 *
 * The rule the ninth investigation bought: read `stream` first, and read `text`
 * **only when no candidate stream carried any text at all**. Measured on the
 * maintainer's machine, the two are not the same thing — `text` projected the
 * model's reasoning token stream while the text parts held the exact expected
 * answer, so preferring the parts is the fix, and the single-consumer rule is
 * what makes it safe on an editor whose two projections share one cursor.
 *
 * `fragments` is the debug transport record of the parts that were used (each
 * text part in order, or the `text` projection's own chunk when the fallback was
 * read), or `undefined` when there is no answer text at all; the feature logs it
 * through `logAnswerFragments`, which is how the log keeps showing where the
 * provider's boundaries fell.
 *
 * What this function does **not** do is decide the answer. It returns the
 * candidates; the caller's contract arbitrates them.
 */
async function readResponseStreamParts(
  response: { stream?: AsyncIterable<unknown>; text?: AsyncIterable<string> },
  checkCancelled: () => boolean,
): Promise<{
  collector: AiPreReviewResponseStreamCollector;
  textProjection?: string;
  fragments?: string[];
}> {
  const collector = await collectResponseStreamParts(response, checkCancelled);
  if (collector.textParts.length > 0 || collector.reasoningParts.length > 0) {
    // A candidate stream carried text, so the `text` projection is **not** read:
    // a second consumer on the same response is the hazard this pass exists for.
    // The text parts double as the fragment list whether or not debug is on,
    // because the chosen stream has to be logged on the same terms either way —
    // except on an aborted sweep, which has no honest totals.
    if (logger.isDebugEnabled()) {
      logResponseStreamParts(collector.debug, collector.textParts, false, 0);
    }
    return collector.debug.stopped ? { collector } : { collector, fragments: collector.textParts };
  }
  const textProjection = await readTextProjection(response);
  if (logger.isDebugEnabled()) {
    logResponseStreamParts(
      collector.debug,
      collector.textParts,
      textProjection !== undefined,
      textProjection?.length ?? 0,
    );
  }
  if (textProjection === undefined || collector.debug.stopped) {
    // An aborted sweep has no honest totals (the same rule the fragment list has
    // always followed), and a projection that threw is not a candidate: either
    // way there is no text to report as read.
    return { collector };
  }
  return { collector, textProjection, fragments: [textProjection] };
}

/**
 * The candidate streams of one response in preference order: the **text** parts
 * first, then the **reasoning** parts, then — only when neither carried text —
 * the `text` projection.
 *
 * The order is the arbitration rule in one place, and every candidate is scored
 * on its **own** bytes. Two candidate streams are never concatenated, and no
 * candidate is repaired, trimmed or re-asked of another model: a candidate either
 * satisfies the contract or it does not.
 */
export async function readResponseCandidates(
  response: { stream?: AsyncIterable<unknown>; text?: AsyncIterable<string> },
  checkCancelled: () => boolean,
): Promise<{ candidates: AiPreReviewResponseCandidate[]; fragments?: string[] }> {
  const { collector, textProjection, fragments } = await readResponseStreamParts(response, checkCancelled);
  const candidates: AiPreReviewResponseCandidate[] = [];
  if (collector.textParts.length > 0) {
    candidates.push({ kind: 'text', text: collector.textParts.join('') });
  }
  if (collector.reasoningParts.length > 0) {
    candidates.push({ kind: 'reasoning', text: collector.reasoningParts.join('') });
  }
  if (candidates.length === 0 && textProjection !== undefined) {
    candidates.push({ kind: 'text-projection', text: textProjection });
  }
  return { candidates, fragments };
}
