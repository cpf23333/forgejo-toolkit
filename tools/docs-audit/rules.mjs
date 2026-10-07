// Pure rule helpers for the documentation audit (`check.mjs`).
//
// Everything here takes file *contents* (an array of lines), never a path, so
// each rule can be exercised directly by `rules.test.mjs`. `check.mjs` keeps
// the file-walking, path resolution and reporting; it delegates the two rules
// this module owns:
//
//   * whether a 「name」 citation resolves against a document's headings and
//     list-entry titles (`namesTitleIn` / `titlesOfLines`);
//   * whether the two files of a language pair agree on their structure *in
//     order* (`comparePairStructure`).

const FENCE = /^(```|~~~)/;
const HEADING = /^(#{1,6}) /;
const LIST_ITEM = /^([-*+]|\d+\.)\s/;
const TABLE_ROW = /^\|/;

/** Headings in document order, ignoring `#` comments inside fenced code. */
export function headingsOfLines(lines) {
  const found = [];
  let fenced = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (FENCE.test(trimmed)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    if (HEADING.test(trimmed)) found.push({ line: index + 1, text: trimmed });
  });
  return found;
}

/**
 * Every name a document may cite: its headings, and the title of each list
 * entry, so that a tracking entry (`- **Title**`) can be cited by name too.
 */
export function titlesOfLines(lines) {
  const found = new Set();
  for (const { text } of headingsOfLines(lines)) {
    found.add(text.replace(/^#{1,6}\s*/, '').trim());
  }
  let fenced = false;
  for (const row of lines) {
    const trimmed = row.trim();
    if (FENCE.test(trimmed)) {
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
 * Whether a 「name」 citation resolves. There is deliberately **no length
 * limit**: a long citation is as likely to rot as a short one, and the cap that
 * used to sit at 40 characters is what let a dangling reference to a removed
 * tracking entry survive unnoticed. The only abbreviation the rule accepts is
 * an explicit ellipsis (`「Some heading…」`), which must still match a real
 * heading or entry title by prefix.
 *
 * Whitespace is collapsed before comparing: the paragraph-scoped rule joins the
 * wrapped source lines of a citation, so a title quoted across two lines
 * (`「2.1 选项\n    … 」一节`) arrives with the line break and the indentation of
 * the continuation line inside the quotes. Collapsing them to single spaces is
 * what makes that citation match the single-line heading it names — without it,
 * removing the length cap would report every wrapped citation as dangling.
 */
export function namesTitleIn(titles, rawName) {
  const collapsed = rawName.replace(/\s+/g, ' ').trim();
  const ellipsis = /[…]+$/.test(collapsed);
  const name = collapsed
    .replace(/[…]+$/, '')
    .replace(/[.。:：]+$/, '')
    .trim();
  return ellipsis ? [...titles].some((title) => title.startsWith(name)) : titles.has(name);
}

/**
 * Per-section shape, in document order: the heading itself plus how many list
 * items, fence lines and table rows sit inside its section. Used to compare a
 * language pair *in order* rather than only by total counts — a pair whose two
 * sections were swapped keeps every total and every heading level intact.
 *
 * Content before the first heading belongs to no section and is covered by the
 * totals in `pairCounts`.
 */
export function sectionShapes(lines) {
  const shapes = [];
  let current = null;
  let fenced = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (FENCE.test(trimmed)) {
      if (current) current.fences += 1;
      fenced = !fenced;
      return;
    }
    if (!fenced && HEADING.test(trimmed)) {
      current = {
        line: index + 1,
        text: trimmed,
        level: trimmed.match(/^#+/)[0].length,
        lists: 0,
        fences: 0,
        tables: 0,
      };
      shapes.push(current);
      return;
    }
    if (!current || fenced) return;
    if (LIST_ITEM.test(trimmed)) current.lists += 1;
    if (TABLE_ROW.test(trimmed)) current.tables += 1;
  });
  return shapes;
}

/** The four coarse counts the pair rule has always compared. */
export function pairCounts(lines) {
  const count = (pattern) => lines.filter((row) => pattern.test(row.trim())).length;
  return {
    headings: count(HEADING),
    lists: count(LIST_ITEM),
    fences: count(/^```/),
    tables: count(TABLE_ROW),
  };
}

const shapeOf = (section) => `${section.lists}/${section.fences}/${section.tables}`;

/**
 * Compare the English and Chinese file of a pair.
 *
 * Two layers, both locatable:
 *
 *   1. the four totals, exactly as before — a drift here means content was
 *      added to or removed from one side;
 *   2. with equal heading counts, a positional comparison of the heading level
 *      sequence and of each section's shape (`lists/fences/tables` inside it).
 *      This is what catches two sections that were reordered: totals and levels
 *      stay identical, so only the per-section shape reveals it.
 *
 * Boundaries: sections that are structurally identical (same level, same list,
 * fence and table counts) can still be swapped without a signal, because the
 * two files are written in different languages and the rule has no way to know
 * that two headings mean the same thing. Prose, wrapping and section length are
 * deliberately not compared — CJK text is denser, so line counts differ on
 * purpose.
 */
export function comparePairStructure(enLabel, zhLabel, enLines, zhLines) {
  const findings = [];
  const enCounts = pairCounts(enLines);
  const zhCounts = pairCounts(zhLines);
  for (const key of Object.keys(enCounts)) {
    if (enCounts[key] !== zhCounts[key]) {
      findings.push(`${zhLabel} and ${enLabel} differ in ${key}: ${enCounts[key]} vs ${zhCounts[key]}`);
    }
  }
  const enSections = sectionShapes(enLines);
  const zhSections = sectionShapes(zhLines);
  // A heading that exists on one side only is already reported above; comparing
  // the remaining sections positionally would only add noise.
  if (enSections.length !== zhSections.length) return findings;
  for (let index = 0; index < enSections.length; index += 1) {
    const en = enSections[index];
    const zh = zhSections[index];
    const position = `heading #${index + 1}`;
    if (en.level !== zh.level) {
      findings.push(
        `${zhLabel}:${zh.line} ${position} is 「${zh.text}」 (h${zh.level}) but ` +
          `${enLabel}:${en.line} ${position} is 「${en.text}」 (h${en.level})`,
      );
      continue;
    }
    if (shapeOf(en) !== shapeOf(zh)) {
      findings.push(
        `${zhLabel}:${zh.line} ${position} 「${zh.text}」 holds ${shapeOf(zh)} list/fence/table rows but ` +
          `${enLabel}:${en.line} ${position} 「${en.text}」 holds ${shapeOf(en)}: the sections at this ` +
          'position differ in shape, which is how two swapped sections look when the totals match',
      );
    }
  }
  return findings;
}
