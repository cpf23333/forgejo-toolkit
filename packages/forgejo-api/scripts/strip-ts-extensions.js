import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile() && path.endsWith('.ts')) {
      yield path;
    }
  }
}

async function stripTsExtensions(root) {
  const relativeImportRegex = /(from\s+['"])(\.\.?\/[^'"]+)\.ts(['"])/g;

  for await (const path of walk(root)) {
    const content = await readFile(path, 'utf-8');
    const cleaned = content.replace(relativeImportRegex, '$1$2$3');
    if (cleaned !== content) {
      await writeFile(path, cleaned, 'utf-8');
      console.log(`Stripped .ts extensions in ${path}`);
    }
  }
}

const root = fileURLToPath(new URL('../src/generated', import.meta.url));
stripTsExtensions(root).catch((error) => {
  console.error(error);
  process.exit(1);
});
