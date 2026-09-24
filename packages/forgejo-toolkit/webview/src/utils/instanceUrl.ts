import type { ForgejoInstance } from '../types/instance';

/**
 * The instance URL a link or a copy action must use: the credential-free one.
 *
 * `instance.url` is the *display* value, and the host masks credentials in it
 * (`https://***@forgejo.example.com/`), so a clone URL or an "open in browser"
 * link built from it is dead — git cannot clone `https://***@host/owner/repo.git`
 * and a browser cannot open `https://***@host/user/settings/applications`. The
 * host sends the unmasked twin as `functionalUrl` beside it (see
 * `toPublicInstance`), and every functional path reads that field.
 *
 * The fallback covers an instance payload from a host build that predates the
 * field (and test fixtures): there the display URL is all there is, and it is
 * the better answer only when it carries no mask. A URL that does carry the
 * mask is not returned — a broken link is worse than no link — so the caller
 * gets `''` and its `v-if`/empty-URL guard suppresses the action.
 */
export function functionalInstanceUrl(instance: ForgejoInstance | undefined): string {
  if (!instance) {
    return '';
  }
  if (instance.functionalUrl) {
    return instance.functionalUrl;
  }
  return instance.url.includes('***') ? '' : instance.url;
}

/** `functionalInstanceUrl` with a trailing slash removed, for building paths. */
export function functionalInstanceBase(instance: ForgejoInstance | undefined): string {
  return functionalInstanceUrl(instance).replace(/\/+$/, '');
}
