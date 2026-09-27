/**
 * Strips likely Google API-key material out of arbitrary strings before they
 * reach a dialog, a log, or the renderer. Defense-in-depth: SDK/network error
 * text can embed the key in a request URL's `?key=` query parameter.
 */
export function redact(input: string): string {
  return input
    .replace(/AIza[0-9A-Za-z\-_]{10,}/g, '[redacted]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]')
}
