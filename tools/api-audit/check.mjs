#!/usr/bin/env node
/**
 * Reports how much of the API surface the extension actually calls is covered by
 * `docs/api-verification-checklist.md`.
 *
 *   node tools/api-audit/check.mjs [--verbose]
 *
 * The endpoints come from the client itself: every generated operation imported by
 * `packages/forgejo-toolkit/src/api/client.ts` is resolved through its own file in
 * `packages/forgejo-api/src/generated/client`, which yields the real method and
 * URL template.
 *
 * Resolution is driven by the *import specifiers*, not by call-site text: the local
 * name each operation is imported under is looked up in the source, so an aliased
 * import (`renderMarkdown as apiRenderMarkdown`) is counted as the endpoint it
 * really is. Matching `name(` against the generated directory instead would miss an
 * alias (`generated/client/apiRenderMarkdown.ts` does not exist) and would only
 * count such an operation by luck, e.g. when a class method happens to share the
 * original operation name.
 *
 * Coverage is judged on *whole* path shapes collected from the document — every
 * `### \`METHOD path\`` heading plus every inline-code path (topical sections name
 * endpoints in their bullets) — because a substring test would treat
 * `/issues/{index}` as covered by `/issues/comments/{id}`. Placeholder names
 * differ between the client (`:run_id` / `${run_id}`) and the document
 * (`{runId}`), so comparison is on the shape with placeholders collapsed to `*`.
 *
 * Exits 1 when an endpoint the client calls is absent from the document, so a new
 * call cannot silently ship unverified, and exits 2 when the operation imports
 * cannot be resolved at all (a false pass is worse than a failed run).
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

/**
 * Local names the generated operations are called under:
 * `renderMarkdown as apiRenderMarkdown` -> `apiRenderMarkdown -> renderMarkdown`.
 * Only specifiers with a file in the generated client are kept, so a shared helper
 * imported from the same entry point cannot be mistaken for an endpoint.
 *
 * The specifier list is `[^}]*`, not `[\s\S]*?`: a lazy any-character match could
 * start at an *earlier* `import {` and span every import in between, which glues
 * the first real specifier onto the preceding statement's text. `import type { … }`
 * cannot match either way, because `{` must follow `import` directly.
 */
const importedOperations = new Map();
for (const block of clientSource.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@cpf23333-forgejo-toolkit\/api['"]/g)) {
  for (const rawSpecifier of block[1].split(',')) {
    const specifier = rawSpecifier.replace(/\/\/.*$/gm, '').trim();
    if (!specifier) continue;
    const [operation, local = operation] = specifier.split(/\s+as\s+/).map((part) => part.trim());
    if (operation && local && existsSync(join(generatedDir, `${operation}.ts`))) {
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
  const source = readFileSync(join(generatedDir, `${operation}.ts`), 'utf8');
  const method = source.match(/method: '([A-Z]+)'/)?.[1];
  const url = source.match(/url: `([^`]+)`/)?.[1];
  if (method && url) {
    const alias = localName === operation ? '' : ` as ${localName}`;
    called.set(`${method} ${shape(url)}`, `${method} ${url}  [${operation}${alias}]`);
  }
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
