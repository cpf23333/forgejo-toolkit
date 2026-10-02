#!/usr/bin/env node
/**
 * Reports how much of the API surface the extension actually calls is covered by
 * `docs/api-verification-checklist.md`.
 *
 *   node tools/api-audit/check.mjs [--verbose]
 *
 * The endpoints come from the **pinned OpenAPI snapshot**, not from the generated
 * output. The snapshot
 * (`packages/forgejo-api/spec/swagger.v1.json`) maps each `operationId` to the
 * method and path it documents, and Kubb names every generated operation after
 * its `operationId`, so the snapshot is a stable source that a change of
 * generator, template layout, or output directory cannot invalidate.
 *
 * This replaced a scan of `src/generated/client/<operation>.ts` for the literal
 * `method: '...'` / `url: \`...\`` pair. Kubb 5 moved those literals into the
 * bundled client core (`.kubb/client.ts`) and reduced each operation file to a
 * call to it, so the scan silently matched nothing and reported "0 endpoints
 * called" while still exiting 0 — a gate that guarded nothing. Hence the
 * self-checks below: a run that resolves no operation, or calls no endpoint, is a
 * broken audit and exits 2 rather than passing.
 *
 * Which operations the client calls is still read from the *import specifiers* in
 * `src/api/client.ts`, not from call-site text: the local name each operation is
 * imported under is looked up in the source, so an aliased import
 * (`renderMarkdown as apiRenderMarkdown`) is counted as the endpoint it really
 * is. Matching `name(` against the snapshot instead would miss an alias.
 *
 * Coverage is judged on *whole* path shapes collected from the document — every
 * `### \`METHOD path\`` heading plus every inline-code path (topical sections name
 * endpoints in their bullets) — because a substring test would treat
 * `/issues/{index}` as covered by `/issues/comments/{id}`. Placeholder names
 * differ between the client (`:run_id` / `${run_id}` / `{run_id}`) and the
 * document (`{runId}`), so comparison is on the shape with placeholders collapsed
 * to `*`.
 *
 * Exits 1 when an endpoint the client calls is absent from the document, so a new
 * call cannot silently ship unverified, and exits 2 when the audit cannot resolve
 * what it is auditing (a false pass is worse than a failed run).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const clientFile = join(repoRoot, 'packages', 'forgejo-toolkit', 'src', 'api', 'client.ts');
const specFile = join(repoRoot, 'packages', 'forgejo-api', 'spec', 'swagger.v1.json');
const docFile = join(repoRoot, 'docs', 'api-verification-checklist.md');
const verbose = process.argv.includes('--verbose');

const shape = (path) =>
  path
    .replace(/\$\{[^}]+\}/g, '*')
    .replace(/\{[^}]+\}/g, '*')
    .replace(/:[A-Za-z0-9_]+/g, '*')
    .replace(/\.\{[^}]+\}$/, '.*')
    .trim();

if (!existsSync(specFile)) {
  console.error(`the pinned OpenAPI snapshot is missing: ${specFile}`);
  console.error('every endpoint name resolves through it, so the audit cannot run; restore the snapshot.');
  process.exit(2);
}

/**
 * `operationId` -> `METHOD path`, straight from the snapshot.
 *
 * Both are the document's own; the generated operation of the same name carries
 * the same method and path template (`{param}` placeholders included).
 *
 * The *name* the generated operation is exported under is not always the
 * `operationId` verbatim: Kubb lower-cases a leading acronym run, so the
 * snapshot's `ListActionRuns`, `GetTree`, `CancelActionRun` become
 * `listActionRuns`, `getTree`, `cancelActionRun`. The snapshot's own operations
 * and those two derived spellings are all indexed here, so an import specifier
 * resolves whichever form the generator emitted (verified: all 506 generated
 * client files resolve, and the client's 82 imports resolve to 82 endpoints).
 */
const OPERATION_NAME_VARIANTS = (operationId) => {
  const titleCase = operationId
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return new Set([operationId, operationId.charAt(0).toLowerCase() + operationId.slice(1), titleCase]);
};

const endpoints = new Map();
const spec = JSON.parse(readFileSync(specFile, 'utf8'));
let specOperationCount = 0;
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const [method, operation] of Object.entries(item ?? {})) {
    if (typeof operation !== 'object' || operation === null) continue;
    const operationId = operation.operationId;
    if (typeof operationId !== 'string' || !operationId) continue;
    specOperationCount += 1;
    const endpoint = `${method.toUpperCase()} ${path}`;
    for (const name of OPERATION_NAME_VARIANTS(operationId)) {
      if (!endpoints.has(name)) endpoints.set(name, [operationId, endpoint]);
    }
  }
}

// Self-check: a snapshot that yields no endpoints means the shape this audit
// reads has moved, and every downstream count would be a confident zero.
if (specOperationCount === 0) {
  console.error(`no operationId/method/path found in ${specFile}`);
  console.error('the snapshot shape this audit reads has changed; fix the reader before trusting any count.');
  process.exit(2);
}

/**
 * Local names the generated operations are called under:
 * `renderMarkdown as apiRenderMarkdown` -> `apiRenderMarkdown -> renderMarkdown`.
 * Only specifiers the snapshot knows as an operation are kept, so a shared helper
 * imported from the same entry point cannot be mistaken for an endpoint.
 *
 * The specifier list is `[^}]*`, not `[\s\S]*?`: a lazy any-character match could
 * start at an *earlier* `import {` and span every import in between, which glues
 * the first real specifier onto the preceding statement's text. `import type { … }`
 * cannot match either way, because `{` must follow `import` directly.
 */
const clientSource = readFileSync(clientFile, 'utf8');
const importedOperations = new Map();
for (const block of clientSource.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@cpf23333-forgejo-toolkit\/api['"]/g)) {
  for (const rawSpecifier of block[1].split(',')) {
    const specifier = rawSpecifier.replace(/\/\/.*$/gm, '').trim();
    if (!specifier) continue;
    const [operation, local = operation] = specifier.split(/\s+as\s+/).map((part) => part.trim());
    if (operation && local && endpoints.has(operation)) {
      importedOperations.set(local, operation);
    }
  }
}

if (importedOperations.size === 0) {
  console.error(`could not resolve any generated operation imports from ${clientFile}`);
  console.error('the audit cannot judge coverage from call sites alone; fix the import scan first.');
  process.exit(2);
}

const called = new Map();
for (const [localName, operation] of importedOperations) {
  // Called under the local name; the import statement itself has no `(`.
  if (!new RegExp(`\\b${localName}\\s*\\(`).test(clientSource)) continue;
  const [operationId, endpoint] = endpoints.get(operation);
  const [method, ...pathParts] = endpoint.split(' ');
  const path = pathParts.join(' ');
  const alias = localName === operation ? '' : ` as ${localName}`;
  called.set(`${method} ${shape(path)}`, `${method} ${path}  [${operationId}${alias}]`);
}

// Self-check: the scan resolved imports but matched no call site, which is what
// the previous per-file literal scan degraded into. Reporting 0 covered endpoints
// with exit 0 is the failure mode this guard exists for.
if (called.size === 0) {
  console.error(`${importedOperations.size} operations are imported by ${clientFile}, but none matched a call site.`);
  console.error('a zero-endpoint result guards nothing; fix the call-site scan before trusting this run.');
  process.exit(2);
}

const doc = readFileSync(docFile, 'utf8');

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

console.log(`generated operations in the pinned snapshot: ${specOperationCount}`);
console.log(`operations imported by the client: ${importedOperations.size}`);
console.log(`endpoints called by the client: ${called.size}`);
console.log(`whole paths recorded in the document: ${documented.size}`);
console.log(`absent from the document: ${absent.length}`);
if (verbose) {
  for (const entry of called.values()) console.log(`  covered  ${entry}`);
}
for (const entry of absent.sort()) console.log(`  MISSING  ${entry}`);

process.exit(absent.length === 0 ? 0 : 1);
