// Documentation audit.
//
// The FEATURES/TODO drift showed one class of documentation error (content of
// one kind living in a document whose stated role is another). This audit looks
// for the classes a script can decide, across every markdown file:
//
//   1. a cited file must exist and a cited line number must be in range, so a
//      reference cannot silently rot when the target is renamed or shortened;
//   2. a markdown link to a repository file must resolve, and its `#anchor`
//      must match a heading in the target;
//   3. a backticked `X.md` + 「heading」 reference — and its paragraph-scoped
//      variant, a 「heading」一节/条目/小节 whose file is named earlier in the
//      same paragraph — must name a heading that actually exists in X (the
//      mistake that survived two renames unnoticed);
//   4. paired language files (foo.md / foo.zh.md) must keep the same structure;
//   5. no duplicate headings, and no heading-level jumps inside a file.
//
// Usage: node tools/docs-audit/check.mjs
// Exit code 1 when a rule is violated, like the api and tracking audits.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
// Vendored content, build output, and scratch data are not ours to police.
const skipDirs = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'shots',
  'profile',
  '.impeccable',
  'extensions',
  'coverage',
]);
const failures = [];
const notes = [];

const rel = (path) => relative(root, path).split(sep).join('/');

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.forgejo' && entry.name !== '.changeset') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walk(full, found);
      continue;
    }
    if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

const files = walk(root);

// Every source file a document may cite, so a citation like `client.ts` or
// `mcp/server.ts` can be resolved against the package it belongs to rather than
// reported as missing.
const sourceExtensions = /\.(ts|tsx|js|mjs|cjs|json|vue|ya?ml|md)$/;
const sources = [];
(function walkSources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (
        skipDirs.has(entry.name) ||
        (entry.name.startsWith('.') && entry.name !== '.forgejo' && entry.name !== '.changeset')
      ) {
        continue;
      }
      walkSources(join(dir, entry.name));
      continue;
    }
    if (sourceExtensions.test(entry.name)) sources.push(join(dir, entry.name));
  }
})(root);

const lineCache = new Map();
const lines = (path) => {
  if (!lineCache.has(path)) lineCache.set(path, readFileSync(path, 'utf8').split(/\r?\n/));
  return lineCache.get(path);
};

/** Resolve a cited repository path, optionally using a line number to disambiguate. */
function resolvePath(cited, from, lineNumber) {
  const normalized = cited.split(sep).join('/');
  const candidates = new Set();
  for (const candidate of [join(root, cited), join(dirname(from), cited)]) {
    try {
      if (statSync(candidate).isFile() || statSync(candidate).isDirectory()) candidates.add(candidate);
    } catch {
      /* keep looking */
    }
  }
  for (const source of sources) {
    const relativePath = rel(source);
    if (relativePath === normalized || relativePath.endsWith(`/${normalized}`)) candidates.add(source);
  }
  const list = [...candidates];
  if (list.length <= 1) return list[0];
  // Several files end with the same suffix (`client.ts`, `package.json`): the
  // one whose length covers the cited line is the intended target.
  if (lineNumber !== undefined) {
    const fitting = list.filter((candidate) => {
      try {
        return lines(candidate).length >= lineNumber;
      } catch {
        return false;
      }
    });
    if (fitting.length === 1) return fitting[0];
    if (fitting.length > 1) return fitting.sort((a, b) => rel(a).length - rel(b).length)[0];
  }
  return list.sort((a, b) => rel(a).length - rel(b).length)[0];
}

/** GitHub-style heading anchor. */
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

/** Every name a document may cite: headings, and the title of a list entry. */
function titlesOf(path) {
  const found = new Set();
  for (const { text: trimmed } of headingsOf(path).map((heading) => ({ text: heading.text }))) {
    found.add(trimmed.replace(/^#{1,6}\s*/, '').trim());
  }
  let fenced = false;
  for (const row of lines(path)) {
    const trimmed = row.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    // `- **Title**`, `- [ ] **Title**`, `- [ ] **P4** Title：…` and
    // `- [ ] **P4 Title**：…` (the number may sit inside or outside the bold).
    const entry = /^[-*]\s+(?:\[[ x]\]\s+)?(?:\*\*(.+?)\*\*\s*)?(.*)$/.exec(trimmed);
    if (!entry) continue;
    const [, bold, rest] = entry;
    const add = (name) => {
      const clean = (name ?? '').trim();
      if (!clean) return;
      found.add(clean);
      const withoutLabel = clean.replace(/^P\d+\s+/, '').trim();
      if (withoutLabel !== clean) found.add(withoutLabel);
    };
    add(rest.split(/[：:（(]/)[0]);
    add(bold);
    // `**P2** PR 描述生成` may be cited with the label glued on.
    if (/^P\d+$/.test((bold ?? '').trim())) {
      add(`${bold.trim()} ${rest.split(/[：:（(]/)[0].trim()}`);
    }
  }
  // A heading whose title carries a parenthetical may be cited without it.
  for (const title of [...found]) {
    const short = title
      .replace(/（[^）]*）$/, '')
      .replace(/\s*\([^)]*\)$/, '')
      .trim();
    if (short !== title) found.add(short);
  }
  return found;
}

/**
 * Whether a 「name」 citation resolves against a document's headings and list
 * entry titles. A trailing ellipsis means the citation is an abbreviated prefix.
 */
function namesTitle(path, rawName) {
  const ellipsis = /[…]+$/.test(rawName);
  const name = rawName
    .replace(/[…]+$/, '')
    .replace(/[.。:：]+$/, '')
    .trim();
  const titles = titlesOf(path);
  return ellipsis ? [...titles].some((title) => title.startsWith(name)) : titles.has(name);
}

/**
 * Path prefixes that belong to another repository. Several documents cite the
 * Forgejo server source (`routers/`, `services/`, …) as evidence for API
 * semantics; those are not files in this working tree and are not resolved.
 */
const externalPrefixes = [
  'release-notes-published/',
  'routers/',
  'models/',
  'services/',
  'modules/',
  'options/',
  'templates/',
];

function headingsOf(path) {
  const found = [];
  let fenced = false;
  lines(path).forEach((line, index) => {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      fenced = !fenced;
      return;
    }
    // `# Install dependencies` inside a shell block is a comment, not a heading.
    if (fenced) return;
    if (/^#{1,6} /.test(trimmed)) found.push({ line: index + 1, text: trimmed });
  });
  return found;
}

console.log(`auditing ${files.length} markdown files\n`);

for (const file of files) {
  const text = lines(file);
  const self = rel(file);

  // 1. Cited files and line ranges.
  const citation = /([\w@][\w./@-]*\.(?:ts|tsx|js|mjs|cjs|json|vue|ya?ml|md)):(\d+)(?:-(\d+))?/g;
  text.forEach((line, index) => {
    for (const match of line.matchAll(citation)) {
      const [, cited, startText, endText] = match;
      const start = Number(startText);
      // A markdown target is cited by its heading, never by a line number: the
      // line numbers of documents move whenever a paragraph is added, and a
      // citation that still resolves while pointing at the wrong paragraph is
      // exactly the failure this repository has already hit twice.
      if (cited.endsWith('.md') && !externalPrefixes.some((prefix) => cited.startsWith(prefix))) {
        failures.push(`${self}:${index + 1} cites a markdown line number (use the heading): ${cited}:${startText}`);
        continue;
      }
      const target = resolvePath(cited, file, start);
      if (!target) {
        // A path from another repository is expected in these documents; a path
        // that should be ours but is not is worth seeing, so it is reported as
        // a note rather than silence (the hard failure is reserved for a
        // citation whose line range no longer fits the file it names).
        if (!externalPrefixes.some((prefix) => cited.startsWith(prefix))) {
          notes.push(`${self}:${index + 1} cites an unresolved path: ${cited}`);
        }
        continue;
      }
      if (statSync(target).isDirectory()) continue;
      const count = lines(target).length;
      const end = endText ? Number(endText) : start;
      if (start < 1 || end < start || end > count) {
        failures.push(
          `${self}:${index + 1} cites ${cited}:${startText}${endText ? `-${endText}` : ''} but ${rel(target)} has ${count} lines`,
        );
      }
    }
  });

  // 2. Markdown links to repository files (and their anchors).
  const link = /\]\(([^)\s]+)\)/g;
  text.forEach((line, index) => {
    for (const match of line.matchAll(link)) {
      const target = match[1];
      // URLs, in-page anchors, editor `command:` URIs, API path examples and
      // placeholder paths are not repository files.
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) continue;
      if (target.includes('{')) continue;
      const [pathPart, anchor] = target.split('#');
      const resolved = resolvePath(decodeURI(pathPart.replace(/\/+$/, '')), file);
      if (!resolved) {
        failures.push(`${self}:${index + 1} links to a missing file: ${target}`);
        continue;
      }
      if (anchor && resolved.endsWith('.md')) {
        const slugs = new Set(headingsOf(resolved).map((heading) => slug(heading.text.replace(/^#+\s*/, ''))));
        if (!slugs.has(anchor.toLowerCase())) {
          failures.push(`${self}:${index + 1} links to a missing anchor: ${target}`);
        }
      }
    }
  });

  // 3. `X.md` 的「heading」/「entry title」 references.
  const named = /`([\w./@-]+\.md)`\s*的「([^」]+)」/g;
  text.forEach((line, index) => {
    for (const match of line.matchAll(named)) {
      const [, cited, rawName] = match;
      const target = resolvePath(cited, file);
      if (!target || statSync(target).isDirectory()) continue; // rule 1 reports a missing file
      if (!namesTitle(target, rawName)) {
        failures.push(`${self}:${index + 1} names a heading that ${cited} does not have: 「${rawName}」`);
      }
    }
  });

  // 3b. `「Y」一节 / 「Y」条目 / 「Y」小节`: Y belongs to the most recent backticked
  // `*.md` named in the same paragraph. A blank line ends a prose paragraph and a
  // table row is its own context, so a heading quoted far from any file name is
  // not checked. Only title-shaped names are checked: an arrow, an equation or a
  // list inside the quotes is prose, not a heading.
  const sectionRef = /「([^」]+)」\s*(?:一节|条目|小节)|`([\w./@-]+\.md)`/g;
  const notATitle = /[→≤=、;]/;
  // The citation and its suffix may wrap over several lines, so the search runs
  // over the paragraph's text and maps a hit back to the line it starts on.
  const paragraphs = [];
  {
    let current;
    let fenced = false;
    text.forEach((line, index) => {
      const trimmed = line.trim();
      if (/^(```|~~~)/.test(trimmed) || fenced) {
        if (/^(```|~~~)/.test(trimmed)) fenced = !fenced;
        current = undefined;
        return;
      }
      if (!trimmed) {
        current = undefined;
        return;
      }
      // A table row is its own context: a reference in one row must not borrow a
      // file name from another row of the same table.
      if (trimmed.startsWith('|')) {
        paragraphs.push([{ line: index + 1, text: line }]);
        current = undefined;
        return;
      }
      if (!current) {
        current = [];
        paragraphs.push(current);
      }
      current.push({ line: index + 1, text: line });
    });
  }
  for (const paragraph of paragraphs) {
    const starts = [];
    let joined = '';
    for (const row of paragraph) {
      starts.push(joined.length);
      joined += `${row.text}\n`;
    }
    const lineAt = (offset) => {
      let found = paragraph[0].line;
      for (let index = 0; index < starts.length && starts[index] <= offset; index += 1) {
        found = paragraph[index].line;
      }
      return found;
    };
    let contextFile;
    for (const match of joined.matchAll(sectionRef)) {
      const [, rawName, cited] = match;
      if (cited) {
        contextFile = cited;
        continue;
      }
      if (!contextFile || notATitle.test(rawName) || rawName.length > 40) continue;
      const target = resolvePath(contextFile, file);
      // The name may belong to another repository, or to no file at all: rule 1
      // already reports a citation that does not resolve.
      if (!target || !target.endsWith('.md') || statSync(target).isDirectory()) continue;
      // A name the citing document itself has is a self-reference — the
      // paragraph merely named another file before it — not a citation of it.
      if (!namesTitle(target, rawName) && !namesTitle(file, rawName)) {
        failures.push(
          `${self}:${lineAt(match.index)} names a heading that ${contextFile} does not have: 「${rawName}」`,
        );
      }
    }
  }

  // 4. Paired language file structure (foo.md <-> foo.zh.md).
  const zhMatch = /^(.*)\.zh\.md$/.exec(self);
  if (zhMatch) {
    const counterpart = join(root, `${zhMatch[1]}.md`);
    try {
      const [en, zh] = [lines(counterpart), text];
      const count = (rows, pattern) => rows.filter((row) => pattern.test(row.trim())).length;
      const shape = (rows) => ({
        headings: count(rows, /^#{1,6} /),
        lists: count(rows, /^([-*+]|\d+\.)\s/),
        fences: count(rows, /^```/),
        tables: count(rows, /^\|/),
      });
      const enShape = shape(en);
      const zhShape = shape(zh);
      for (const key of Object.keys(enShape)) {
        if (enShape[key] !== zhShape[key]) {
          failures.push(`${self} and ${rel(counterpart)} differ in ${key}: ${enShape[key]} vs ${zhShape[key]}`);
        }
      }
      notes.push(`paired: ${rel(counterpart)} <-> ${self}`);
    } catch {
      failures.push(`${self} has no English counterpart (${rel(counterpart)} is missing)`);
    }
  }

  // 5. Duplicate headings among siblings and heading-level jumps. A changelog
  // repeats `### Added` under every release on purpose, so it is exempt, and
  // two different parents may each group their content under the same subtitle.
  const own = headingsOf(file);
  const seen = new Map();
  const repeatsAllowed = /CHANGELOG\.md$/.test(file);
  const parents = [];
  for (const heading of own) {
    const level = heading.text.match(/^#+/)[0].length;
    const title = heading.text.replace(/^#+\s*/, '').trim();
    parents.length = level;
    const parentKey = parents.slice(0, level - 1).join(' / ');
    const key = `${parentKey} :: ${title}`;
    if (seen.has(key) && !repeatsAllowed) {
      failures.push(`${self}:${heading.line} repeats the heading from line ${seen.get(key)}: ${heading.text}`);
    } else if (!seen.has(key)) {
      seen.set(key, heading.line);
    }
    parents[level - 1] = title;
  }
  let previous = 0;
  for (const heading of own) {
    const level = heading.text.match(/^#+/)[0].length;
    if (previous !== 0 && level > previous + 1) {
      failures.push(`${self}:${heading.line} jumps from h${previous} to h${level}: ${heading.text}`);
    }
    previous = level;
  }
}

for (const note of notes) console.log(`note ${note}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(
  failures.length === 0 ? '\ndocumentation: 0 violations' : `\ndocumentation: ${failures.length} violation(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);
