// Unit tests for the dual-window CLI's argument parsing.
//
// This mode launches an app and kills processes, so the parser is strict on
// purpose: an unknown flag or a missing value must fail before anything is
// started, and booleans never silently accept a value.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flagBool, flagNumber, flagString, parseArgs, type FlagSpec } from './cliArgs';

const SPEC: FlagSpec = {
  value: ['--timeout', '--grep', '--preset'],
  boolean: ['--system-keystroke', '--follow'],
};

test('positionals and flags are separated, in any order', () => {
  const parsed = parseArgs(['2', '--grep', 'broker', '--follow'], SPEC);
  assert.deepEqual(parsed.positional, ['2']);
  assert.equal(flagString(parsed, '--grep'), 'broker');
  assert.equal(flagBool(parsed, '--follow'), true);
  assert.equal(flagBool(parsed, '--system-keystroke'), false);
});

test('--flag=value and --flag value are both accepted', () => {
  assert.equal(flagString(parseArgs(['--timeout=5000'], SPEC), '--timeout'), '5000');
  assert.equal(flagString(parseArgs(['--timeout', '5000'], SPEC), '--timeout'), '5000');
  assert.equal(flagNumber(parseArgs(['--timeout=5000'], SPEC), '--timeout', 60_000), 5000);
  assert.equal(flagNumber(parseArgs([], SPEC), '--timeout', 60_000), 60_000, 'the default is used when absent');
});

test('a typo fails instead of falling back to a default', () => {
  assert.throws(() => parseArgs(['--windows', '2'], SPEC), /unknown flag '--windows'/);
  assert.throws(() => parseArgs(['--timeout'], SPEC), /needs a value/);
  assert.throws(() => parseArgs(['--timeout', '--follow'], SPEC), /needs a value/);
  assert.throws(() => parseArgs(['--follow=yes'], SPEC), /does not take a value/);
  assert.throws(() => flagNumber(parseArgs(['--timeout=soon'], SPEC), '--timeout', 1), /needs a number/);
  assert.throws(() => flagString(parseArgs(['--follow'], SPEC), '--follow'), /needs a value/);
});

test('an empty flag value is a value, not a missing one', () => {
  const parsed = parseArgs(['--grep='], SPEC);
  assert.equal(flagString(parsed, '--grep'), '');
});
