// Tests for `ui eval`'s script handling (src/evalScript.ts).
//
// The defect these pin is a silent one: a script file holding the documented
// arrow-function form answered `undefined` and exited 0 — the same output as a
// script that never ran — because a function is not a serializable value and the
// call's result was lost at the CDP boundary. The repair runs the script inside the
// page, so the expression wrapper is the part that matters most here; the result
// guard is the second half (never print a function, never answer a silent
// `undefined`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isFunctionValue,
  SCRIPT_REFUSAL_MARKER,
  scriptResultValue,
  ScriptResultError,
  wrapScriptForEvaluation,
} from './evalScript';

/**
 * Runs one wrapped script the way `ui eval` does: the expression is evaluated, then
 * its answer goes through the guard.
 *
 * The wrapper is the exact text `page.evaluate` receives, so evaluating it here
 * exercises the same expression the dev host's page evaluates — including the IIFE,
 * which is what makes the script's call happen in the page, and the refusal marker,
 * which is what the guard reads.
 */
async function runInPage(script: string): Promise<unknown> {
  const expression = wrapScriptForEvaluation(script);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const evaluate = new Function(`return (${expression});`) as () => Promise<unknown>;
  return await scriptResultValue(await evaluate());
}

test('the wrapper runs the script in the page and answers its result', async () => {
  assert.equal(await runInPage('() => 7'), 7);
  assert.equal(await runInPage('() => { const n = 5; return n * 2; }'), 10);
  assert.deepEqual(await runInPage('() => ({ frames: 2 })'), { frames: 2 });
  assert.equal(await runInPage('() => ""'), '');
  assert.equal(await runInPage('() => false'), false);
});

test('the wrapper keeps a bare expression working, evaluated only once', async () => {
  assert.equal(await runInPage('41 + 1'), 42);
  assert.equal(await runInPage('"text"'), 'text');

  // An IIFE is a value, not a function, so it is answered as its own result rather
  // than called a second time: the counter must stay at 1.
  const scope = globalThis as unknown as { __uiEvalCalls?: number };
  scope.__uiEvalCalls = 0;
  assert.equal(
    await runInPage('(() => { globalThis.__uiEvalCalls = (globalThis.__uiEvalCalls ?? 0) + 1; return 5; })()'),
    5,
  );
  const calls = scope.__uiEvalCalls;
  delete scope.__uiEvalCalls;
  assert.equal(calls, 1);
});

test('the wrapper awaits an async script', async () => {
  assert.equal(await runInPage('async () => "awaited"'), 'awaited');
});

test('a script that is not a function is not called, so its own error survives', async () => {
  // `typeof` is the test precisely so this case does not become the wrapper's own
  // "script is not a function": the undefined name has to be the message.
  await assert.rejects(() => runInPage('notDefinedAnywhere'), /notDefinedAnywhere/);
});

test('a throwing function script propagates its own error untouched', async () => {
  await assert.rejects(
    () =>
      runInPage(`() => {
        throw new Error('evaluation blew up');
      }`),
    /evaluation blew up/,
  );
});

test('a value that is not a function is the value itself, unchanged', async () => {
  assert.equal(await scriptResultValue(41), 41);
  assert.equal(await scriptResultValue('text'), 'text');
  assert.equal(await scriptResultValue(undefined), undefined);
  assert.deepEqual(await scriptResultValue([1, 2]), [1, 2]);
  assert.equal(
    isFunctionValue(async () => 1),
    true,
  );
  assert.equal(isFunctionValue({}), false);
  assert.equal(isFunctionValue(null), false);
});

test("a function's own answer being a function is refused in the page, not turned into undefined", async () => {
  // The silent case the defect was about, one level down: a function result cannot
  // cross the CDP boundary either, so without the marker this would print `undefined`
  // and exit 0 exactly like the original defect.
  await assert.rejects(
    () => runInPage('() => () => 1'),
    (error: unknown) => {
      assert.ok(error instanceof ScriptResultError);
      assert.match(error.message, /returned another function/);
      return true;
    },
  );
  // The marker is what the page answered, so the refusal is decidable from this side.
  const markerOnly = await runInPage(`() => ({ ${SCRIPT_REFUSAL_MARKER}: true })`);
  assert.deepEqual(
    markerOnly,
    { [SCRIPT_REFUSAL_MARKER]: true },
    'one marker key is an ordinary answer, so a script that prints it is not refused',
  );
});

test('a value that is not a function comes back unchanged', async () => {
  assert.equal(await scriptResultValue(41), 41);
  assert.equal(await scriptResultValue('text'), 'text');
  assert.equal(await scriptResultValue(undefined), undefined);
  assert.deepEqual(await scriptResultValue([1, 2]), [1, 2]);
  assert.deepEqual(await scriptResultValue({ openAiEndpoint: true }), { openAiEndpoint: true });
  assert.equal(
    isFunctionValue(async () => 1),
    true,
  );
  assert.equal(isFunctionValue({}), false);
  assert.equal(isFunctionValue(null), false);
});

test("a directly passed function's own answer being a function is refused too", async () => {
  // Not a shape the CDP boundary can produce (functions do not cross it), but the
  // guard is what makes "the value is a function" mean "run it" rather than "print
  // undefined" if it ever is.
  await assert.rejects(
    () => scriptResultValue(() => () => 1),
    (error: unknown) => {
      assert.ok(error instanceof ScriptResultError);
      assert.match(error.message, /returned another function/);
      return true;
    },
  );
});

test('a leftover function answer is still called, so it is not silently dropped', async () => {
  assert.equal(await scriptResultValue(() => 7), 7);
  assert.equal(await scriptResultValue(async () => 'awaited'), 'awaited');
});
