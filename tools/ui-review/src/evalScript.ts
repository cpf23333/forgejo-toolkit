// How `ui eval` runs the script a caller gives it (src/ui.ts).
//
// `page.evaluate` takes either a function to call or a string to *evaluate as an
// expression*, and the documented form of a script file is the arrow-function form:
//
//   () => document.querySelectorAll('.monaco-workbench').length
//
// Passed to `page.evaluate` as that string, the command printed `undefined` and
// exited 0 — and so did a script that never ran at all. Measured 2026-10-05 in the
// isolated dev host, which is what fixes the shape of the repair below:
//
//   page.evaluate('() => 7')                          -> undefined
//   page.evaluate('typeof (() => 7)')                 -> "function"
//   page.evaluate('(() => 7)()')                      -> 7
//   page.evaluate('async () => { … }')                -> undefined
//
// The last three lines are the mechanism, and it is the reason the repair has to
// happen **inside the page**: an expression whose value is a function answers
// `undefined`, whatever its shape, because a function does not cross the CDP
// boundary. Only a *call* of it answers a value. So nothing on this side can recover
// the script's result — the function object is already gone by the time the caller
// sees `undefined`, which is exactly why the defect was silent: `() => 7`,
// `() => undefined` and a script that never ran all arrived as the same thing.
//
// Two halves, both in this module:
//
// 1. {@link wrapScriptForEvaluation} hands `page.evaluate` an **IIFE** rather than
//    the script's own arrow-function text, because a wrapper that leaves an arrow
//    function as the expression's value answers `undefined` (the `async () => { … }`
//    line above). Its job is to call the script once, in the page, with no arguments.
// 2. {@link scriptResultValue} reads the answer. A result that is itself a function
//    cannot be printed *and* cannot be detected from this side — it is already
//    `undefined` by then — so the page answers with the {@link SCRIPT_REFUSAL_MARKER}
//    instead, and this side turns that marker into a loud, non-zero refusal. A bare
//    expression (`document.title`, an IIFE, a literal) is answered as its own value
//    and still works unchanged.

/** Raised when a script's answer cannot be printed, so the command fails loudly. */
export class ScriptResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptResultError';
  }
}

/**
 * The property the page adds to its answer to say "this is a function that cannot be
 * printed", and its companion version.
 *
 * A property rather than a bare `undefined`, because `undefined` is also what a
 * perfectly good script answers; a property rather than a wrapper object around
 * every answer, so an ordinary result (an object, an array, a string) arrives here
 * exactly as the script produced it.
 *
 * Two keys rather than one because this side cannot tell the page's marker from a
 * script that happened to return the same object: `{ __uiEvalRefusedFunction: true }`
 * is a perfectly ordinary thing for a script to print, and refusing it would be a
 * false failure on a real answer. A script has to return both keys, with these
 * values, to be mistaken for the marker — which is a shape no real answer has.
 */
export const SCRIPT_REFUSAL_MARKER = '__uiEvalRefusedFunction';
export const SCRIPT_REFUSAL_MARKER_VERSION = '__uiEvalRefusedFunctionVersion';

/** True for the one value that must never be printed, and can never leave the page. */
export function isFunctionValue(value: unknown): boolean {
  return typeof value === 'function';
}

function isRefusalMarker(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record[SCRIPT_REFUSAL_MARKER] === true && record[SCRIPT_REFUSAL_MARKER_VERSION] === 1;
}

/**
 * An expression for `page.evaluate` that **runs** `script` once, in the page, and
 * answers its result.
 *
 * The expression is an IIFE, and that detail is the whole repair: an expression
 * whose value is a function answers `undefined` (measured, see the header), so
 * leaving the script's arrow-function text as the expression would drop it. The IIFE
 * is called by the page's own evaluator, so only its plain return value crosses.
 *
 * The script is evaluated inside the IIFE and then:
 *
 * - if it **is a function**, it is called once with no arguments — the documented
 *   "run this" form — and its answer is awaited (so an `async () => …` script
 *   works); an answer that is *also* a function is reported with the refusal marker
 *   rather than allowed to become `undefined` at the boundary;
 * - if it is **not a function**, it is answered as its own value: a bare expression,
 *   an IIFE it contains, or a literal.
 *
 * `await` applies only when the script is a function, so an ordinary result is
 * returned untouched by the wrapper — no `thenable` guessing and no re-entry into a
 * script's own data. The script is evaluated exactly once.
 */
export function wrapScriptForEvaluation(script: string): string {
  return (
    '(async () => {\n' +
    `  const script = (${script}\n);\n` +
    "  const value = typeof script === 'function' ? await script() : script;\n" +
    `  return typeof value === 'function' ? { ${SCRIPT_REFUSAL_MARKER}: true, ${SCRIPT_REFUSAL_MARKER_VERSION}: 1 } : value;\n` +
    '})()'
  );
}

/** The one refusal sentence, shared by the two paths that can reach it. */
const REFUSED_FUNCTION_RESULT =
  'the script is a function and calling it returned another function, so there is no value to print.\n' +
  '  `ui eval` runs a function script for you (that is the form the README documents), so write the script\n' +
  '  to return what you want to see — e.g. `() => document.title` — rather than a function factory.';

/**
 * The value a script's answer stands for, once it is back on this side.
 *
 * The page has already run the script, so the only two things to do here are: turn
 * the refusal marker into the loud failure it stands for, and hand back anything
 * else unchanged. A function cannot arrive any more (the boundary drops it), but a
 * caller that passes one in directly — a test, or a future non-CDP path — still gets
 * the documented "run it" reading rather than a printed function.
 */
export async function scriptResultValue(value: unknown): Promise<unknown> {
  if (isRefusalMarker(value)) {
    throw new ScriptResultError(REFUSED_FUNCTION_RESULT);
  }
  if (!isFunctionValue(value)) {
    return value;
  }
  const result: unknown = await (value as () => unknown)();
  if (isFunctionValue(result)) {
    throw new ScriptResultError(REFUSED_FUNCTION_RESULT);
  }
  return result;
}
