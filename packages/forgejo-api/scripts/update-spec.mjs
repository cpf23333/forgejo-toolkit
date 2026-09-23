// Refreshes the pinned OpenAPI snapshot the client is generated from.
//
// The upstream endpoint tracks whatever version the server runs, so the generated
// client could change without a commit that explains why. Run this on purpose,
// record the reported version in spec/README.md, then regenerate.
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const SOURCE = process.env.FORGEJO_SPEC_URL ?? 'https://codeberg.org/swagger.v1.json';
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
console.log(`spec:update wrote ${text.length} bytes from ${SOURCE}`);
console.log(`  info.version: ${spec.info?.version ?? 'unknown'}`);
console.log(`  paths: ${Object.keys(spec.paths ?? {}).length}, sha256: ${digest}`);
