import { createHash } from 'node:crypto';

/**
 * Build the id a Forgejo instance is stored under.
 *
 * The id keys both the saved configuration and the secret holding the access
 * token (see config.ts), so two instances that compute the same id silently
 * overwrite each other: https://host/a and https://host/b are different
 * instances but used to collapse into `host-login`. A root-path URL keeps that
 * plain id - re-keying existing installations would orphan the token stored
 * under the old id - while a sub-path appends a stable slug, so both coexist.
 */
export function instanceIdFor(normalizedUrl: string, login: string): string {
  const parsed = new URL(normalizedUrl);
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path === '') {
    return `${parsed.host}-${login}`;
  }
  const slug = path
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (slug === '') {
    // A path made only of separator characters (`/_`, `/--`) slugs to nothing,
    // so every such path on one host shared a single `host--login` id and the
    // instances overwrote each other. Hash the path instead: only instances
    // that already collided change id, so no distinguishable instance (and no
    // stored secret key) is re-keyed.
    return `${parsed.host}-${shortHash(path)}-${login}`;
  }
  return `${parsed.host}-${slug}-${login}`;
}

/**
 * The id an incoming instance is stored under when `existing` already holds an
 * entry with the same id but a different URL.
 *
 * `instanceIdFor` folds path punctuation (`/a-b` and `/a/b` slug identically),
 * and an import file can name a known id with an arbitrary URL, so an id match
 * is not proof that two entries are the same instance. Overwriting the stored
 * entry would lose the first instance and — because tokens are rehydrated by
 * id — rebind its stored secret to the new URL. The newcomer gets a fresh id
 * derived from its full URL instead, leaving the existing entry and its
 * credential untouched; a re-add of the unchanged instance keeps its id, so
 * re-import still updates in place.
 */
export function resolveInstanceIdCollision(
  id: string,
  url: string,
  existing: ReadonlyArray<{ id: string; url: string }>,
): string {
  // Trailing slashes carry no meaning for an instance URL: `https://host` and
  // `https://host/` are the same server, and a character-exact compare would
  // treat a re-add spelled with the slash as a different instance — forking a
  // fresh id and orphaning nothing but the "update in place" the user asked
  // for. Compare both sides with the slashes stripped.
  const normalizedUrl = url.replace(/\/+$/, '');
  let candidate = id;
  for (
    let attempt = 0;
    existing.some((entry) => entry.id === candidate && entry.url.replace(/\/+$/, '') !== normalizedUrl);
    attempt += 1
  ) {
    // A derived id could itself collide (an entry genuinely stored under
    // `id-<hash>`); salt the hash with the attempt count so the loop still
    // terminates on a distinct id.
    candidate = `${id}-${shortHash(attempt === 0 ? url : `${url}#${attempt}`)}`;
  }
  return candidate;
}

/** Eight hex digits of sha256 — enough to keep derived ids apart, short enough to stay readable. */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * The display name an instance is stored under: `<login>@<host><sub-path>`.
 *
 * Must be derived the same way by every entry point that saves an instance.
 * `name` is part of the webview's instance cache identity
 * (`webview/src/composables/useAppState.ts`), so a form that drops the
 * sub-path rewrites the identity of an extra-path instance on a plain edit and
 * makes the view discard every payload cached for it.
 */
export function instanceNameFor(normalizedUrl: string, login: string): string {
  const parsed = new URL(normalizedUrl);
  return `${login}@${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}
