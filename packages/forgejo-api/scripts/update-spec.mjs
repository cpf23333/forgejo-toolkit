// Refreshes the pinned OpenAPI snapshot the client is generated from.
//
// The generated client must match the Forgejo version this extension supports, not
// whatever the server behind `swagger.v1.json` happens to run — that endpoint served
// a 16.0.0-dev build when this was written, which carries changes newer than the
// 16.0.x releases (it marked `IssueMeta.index/owner/repo` as required, for example).
// The snapshot therefore comes from a release tag in the Forgejo repository:
// `templates/swagger/v1_json.tmpl` at `FORGEJO_SPEC_TAG`.
//
// Bump the tag on purpose, run this script, review the diff against
// `src/generated`, update `spec/README.md`, then regenerate with
// `pnpm --filter @cpf23333-forgejo-toolkit/api generate:safe`.
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const TAG = process.env.FORGEJO_SPEC_TAG ?? 'v16.0.0';
const SOURCE =
  process.env.FORGEJO_SPEC_URL ?? `https://codeberg.org/forgejo/forgejo/raw/tag/${TAG}/templates/swagger/v1_json.tmpl`;
const target = new URL('../spec/swagger.v1.json', import.meta.url);

const response = await fetch(SOURCE);
if (!response.ok) {
  console.error(`spec:update failed: ${SOURCE} answered ${response.status}`);
  process.exit(1);
}
const text = await response.text();
const spec = JSON.parse(text);
await writeFile(target, text);
const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
// `text.length` counts UTF-16 code units, not bytes: the file on disk is larger
// (the snapshot is 853,826 characters vs 853,842 bytes), so name the unit.
console.log(`spec:update wrote ${text.length} characters (${Buffer.byteLength(text)} bytes) for ${TAG}`);
console.log(`  source: ${SOURCE}`);
console.log(`  paths: ${Object.keys(spec.paths ?? {}).length}, sha256: ${digest}`);
console.log('  info.version is a build placeholder in the template; the tag is the version');
