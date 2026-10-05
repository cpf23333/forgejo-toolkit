import {
  AI_PROVIDER_SEGMENT_PATTERN,
  inspectAiProviderBaseUrl,
} from '@cpf23333-forgejo-toolkit/shared/ai/providerPolicy';

/**
 * The id and the display name a new AI endpoint gets from its address
 * (`docs/design/settings-page.md` §5.1, §5.2).
 *
 * Generating them is a convenience, not a second source of truth: the generated
 * text is written into the editor's own fields, where the user sees it and can
 * change it, and nothing here is ever applied behind their back — the page
 * refuses to rename anything at save time (§5.2 rule 3).
 *
 * Both rules are pure and live in their own module so the four examples the
 * record prints can be exercised directly, without a component and without a
 * host.
 */

/** The cap on a generated id, in characters (§5.1). */
export const AI_PROVIDER_GENERATED_ID_MAX_LENGTH = 48;

/** What a generated id falls back to when its address yields no usable characters (§5.1). */
export const AI_PROVIDER_GENERATED_ID_FALLBACK = 'endpoint';

/** The address's host, lowercased and without its port, or `undefined` when it is not a URL. */
function hostWithoutPort(baseUrl: string): string | undefined {
  const verdict = inspectAiProviderBaseUrl(baseUrl.trim());
  if (!verdict.ok) {
    return undefined;
  }
  return verdict.url.hostname.toLowerCase();
}

/** The address's host including its port, lowercased, or `undefined` when it is not a URL. */
function hostWithPort(baseUrl: string): string | undefined {
  const verdict = inspectAiProviderBaseUrl(baseUrl.trim());
  if (!verdict.ok) {
    return undefined;
  }
  return verdict.url.host.toLowerCase();
}

/**
 * The id one address suggests: its host, reduced to the characters a
 * `SecretStorage` key segment may hold.
 *
 * The class comes from `AI_PROVIDER_SEGMENT_PATTERN` rather than being spelled
 * again here, so "a character the id may keep" is one rule: an id this function
 * produces is always one `isAiProviderSegment` accepts, which is what makes the
 * generated value storable at all. Everything else becomes `-`, runs of `-`
 * collapse, and the result is trimmed and capped; an address that yields nothing
 * usable falls back to `endpoint` rather than leaving the field empty.
 */
export function generateAiProviderId(baseUrl: string): string {
  const host = hostWithoutPort(baseUrl);
  if (host === undefined) {
    return AI_PROVIDER_GENERATED_ID_FALLBACK;
  }
  const normalized = host.replace(/^www\./, '');
  const replaced = [...normalized]
    .map((character) => (AI_PROVIDER_SEGMENT_PATTERN.test(character) ? character : '-'))
    .join('');
  const collapsed = replaced.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  const capped = collapsed.slice(0, AI_PROVIDER_GENERATED_ID_MAX_LENGTH).replace(/-+$/, '');
  return capped === '' ? AI_PROVIDER_GENERATED_ID_FALLBACK : capped;
}

/**
 * The display name one address suggests: its host **with** the port, lowercased,
 * exactly as it would be read aloud.
 *
 * Deliberately not the id: a name does not have to be a legal key segment, so
 * `localhost:11434` is a better name than `localhost` and `www.example.com` is
 * what the user typed. Empty when the address is not a URL yet — the caller
 * leaves the field alone then.
 */
export function generateAiProviderName(baseUrl: string): string {
  return hostWithPort(baseUrl) ?? '';
}

/**
 * A free id, given the one the address suggested and the ids already configured.
 *
 * Comparison is **case-insensitive** because `SecretStorage`'s keys are not and
 * the user does not think in cases: an endpoint called `API.example.com` and one
 * called `api.example.com` would hold the same key, so the second is given `-2`.
 * The suffix counts against the 48-character cap — the base is shortened to make
 * room — so a long host cannot overflow it by being disambiguated.
 *
 * `taken` may hold anything: the caller passes the configured endpoints' ids and
 * the ids of the entries the reader refused, and blank ones are ignored.
 */
export function uniqueAiProviderId(suggestedId: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((id) => id.trim().toLowerCase()).filter((id) => id !== ''));
  if (!used.has(suggestedId.toLowerCase())) {
    return suggestedId;
  }
  for (let suffixNumber = 2; ; suffixNumber += 1) {
    const suffix = `-${suffixNumber}`;
    const base = suggestedId
      .slice(0, Math.max(0, AI_PROVIDER_GENERATED_ID_MAX_LENGTH - suffix.length))
      .replace(/-+$/, '');
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}
