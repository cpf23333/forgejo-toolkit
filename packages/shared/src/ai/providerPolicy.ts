/**
 * The two pure rules that decide what an AI endpoint's address, id and
 * custom-header name may be (`docs/design/ai-model-transport.md` §6.2, §8.2).
 *
 * They live in the shared package rather than in the extension host because two
 * runtimes need the **same** answer and neither may have its own copy:
 *
 * 1. The host enforces them where a request is actually built (the transport and
 *    the connection probe) and where a setting is written.
 * 2. The webview's settings page needs them for two things it decides on its own
 *    — the provider id it generates from a typed address
 *    (`docs/design/settings-page.md` §5.1) and the moment the automatic model
 *    probe may be armed (§4.3).
 *
 * A second implementation in the webview would be exactly the "second validation
 * source" the settings-page record forbids (§7.3): the page must reflect the
 * host's verdict, never invent one. `src/ai/modelSettings.ts` in the extension
 * re-exports everything here, so every host-side caller keeps one import site and
 * one implementation.
 *
 * Nothing in this module touches `vscode` or the network: it is text in, verdict
 * out, which is what lets both runtimes use it.
 */

/**
 * The characters a provider id and a header name may use.
 *
 * One pattern for both, and the reason is the same in both cases: the id is part
 * of a `SecretStorage` key (`forgejoToolkit.aiProviderKey.<id>`) and the header
 * name is part of another (`forgejoToolkit.aiProviderHeader.<id>.<name>`), where
 * `.` is the separator. A name containing a `.` — or a space, a colon, a
 * non-ASCII letter — would make the key ambiguous, so it is refused at the point
 * the value is read rather than guessed at (§8.2).
 */
export const AI_PROVIDER_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Whether a value is usable as a provider id / header name (§8.2). */
export function isAiProviderSegment(value: string): boolean {
  return AI_PROVIDER_SEGMENT_PATTERN.test(value);
}

/**
 * What a base URL is: usable or not, and whether it is usable but not encrypted.
 *
 * Three refusals, each with its own reason (§6.2): a value that is not an absolute
 * URL at all, a scheme other than `http:`/`https:` (`file:`, `data:`,
 * `javascript:`, an editor-internal scheme), and a URL that carries credentials as
 * userinfo — a credential belongs in `SecretStorage`, and Node's `fetch` refuses
 * such a URL outright, so accepting one would produce a transport error blaming
 * the endpoint for a credential in the wrong field (the same reasoning as
 * `hasUrlUserinfo` in the host's `src/utils/redactUrlUserinfo.ts`).
 *
 * `http://` is **allowed**: "this machine, no egress" is one of the reasons the
 * direct transport exists, and a loopback endpoint has no certificate to be had.
 * It is not silent, though — `warning` is the sentence a surface shows and the
 * transport logs whenever it is about to send to one (§6.2, §10.2). The reason
 * strings are the endpoint's own diagnoses and are English: every caller
 * interpolates them into a localized sentence rather than showing them alone.
 */
export type AiProviderBaseUrlVerdict =
  | { ok: true; url: URL; insecure: boolean; warning?: string }
  | { ok: false; reason: string };

/** See {@link AiProviderBaseUrlVerdict}. */
export function inspectAiProviderBaseUrl(baseUrl: string): AiProviderBaseUrlVerdict {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, reason: 'it is not an absolute URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `its scheme is "${parsed.protocol}", and only http: and https: can be a model endpoint`,
    };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      ok: false,
      reason:
        "it carries credentials in the URL, and a credential belongs in the extension's secret storage rather than in a setting",
    };
  }
  if (parsed.protocol === 'http:') {
    return {
      ok: true,
      url: parsed,
      insecure: true,
      warning: `This endpoint address is plain http://, so the request and the answer are not encrypted in transit (${redactHostOf(parsed)}).`,
    };
  }
  return { ok: true, url: parsed, insecure: false };
}

/** A URL's origin, without its userinfo (there is none left after the check above). */
function redactHostOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}
