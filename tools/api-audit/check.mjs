#!/usr/bin/env node
/**
 * Reports how much of the API surface the extension actually calls is covered by
 * `docs/api-verification-checklist.md`.
 *
 *   node tools/api-audit/check.mjs [--verbose]
 *
 * The endpoints come from the client itself: every generated operation invoked by
 * `packages/forgejo-toolkit/src/api/client.ts` is resolved through its own file in
 * `packages/forgejo-api/src/generated/client`, which yields the real method and
 * URL template.
 *
 * Coverage is judged on *whole* path shapes collected from the document — every
 * `### \`METHOD path\`` heading plus every inline-code path (topical sections name
 * endpoints in their bullets) — because a substring test would treat
 * `/issues/{index}` as covered by `/issues/comments/{id}`. Placeholder names
 * differ between the client (`:run_id` / `${run_id}`) and the document
 * (`{runId}`), so comparison is on the shape with placeholders collapsed to `*`.
 *
 * Exits 1 when an endpoint the client calls is absent from the document, so a new
 * call cannot silently ship unverified.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const clientFile = join(repoRoot, 'packages', 'forgejo-toolkit', 'src', 'api', 'client.ts');
const generatedDir = join(repoRoot, 'packages', 'forgejo-api', 'src', 'generated', 'client');
const docFile = join(repoRoot, 'docs', 'api-verification-checklist.md');
const verbose = process.argv.includes('--verbose');

const shape = (path) =>
  path
    .replace(/\$\{[^}]+\}/g, '*')
    .replace(/\{[^}]+\}/g, '*')
    .replace(/:[A-Za-z0-9_]+/g, '*')
    .replace(/\.\{[^}]+\}$/, '.*')
    .trim();

const clientSource = readFileSync(clientFile, 'utf8');
const doc = readFileSync(docFile, 'utf8');

const called = new Map();
for (const match of clientSource.matchAll(/\b([a-z][A-Za-z0-9]*)\(/g)) {
  const name = match[1];
  const operationFile = join(generatedDir, `${name}.ts`);
  if (!existsSync(operationFile)) continue;
  const source = readFileSync(operationFile, 'utf8');
  const method = source.match(/method: '([A-Z]+)'/)?.[1];
  const url = source.match(/url: `([^`]+)`/)?.[1];
  if (method && url) called.set(`${method} ${shape(url)}`, `${method} ${url}  [${name}]`);
}

/** Whole paths the document records: headings and inline-code paths. */
const documented = new Set();
for (const match of doc.matchAll(/^### `([A-Z]+) ([^`]+)`/gm)) {
  documented.add(`${match[1]} ${shape(match[2].replace(/\s*（.*$/, ''))}`);
}
for (const match of doc.matchAll(/`([A-Z]+) ([^`\n]+)`/g)) {
  documented.add(`${match[1]} ${shape(match[2].replace(/\s*（.*$/, ''))}`);
}
for (const match of doc.matchAll(/`(\/[^`\n\s]+)`/g)) {
  // Path-only mentions inherit their method from the surrounding prose, so record
  // the shape method-agnostically as well.
  documented.add(`* ${shape(match[1])}`);
}

const absent = [];
for (const [key, label] of called) {
  const path = key.slice(key.indexOf(' ') + 1);
  if (documented.has(key) || documented.has(`* ${path}`)) continue;
  absent.push(label);
}

console.log(`endpoints called by the client: ${called.size}`);
console.log(`whole paths recorded in the document: ${documented.size}`);
console.log(`absent from the document: ${absent.length}`);
if (verbose) {
  for (const entry of called.values()) console.log(`  covered  ${entry}`);
}
for (const entry of absent.sort()) console.log(`  MISSING  ${entry}`);

process.exit(absent.length === 0 ? 0 : 1);
