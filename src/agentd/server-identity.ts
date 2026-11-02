/** Canonical credential issuer: origin AND deployment base path, never origin alone. */
export function normalizeServerIssuer(value: string): string {
  const invalid = () => new Error("invalid server issuer URL (use an absolute HTTP(S) base without userinfo, query or fragment)");
  // WHATWG URL repairs several malformed inputs; credentials must not accept those repairs.
  if (typeof value !== "string" || /[\s\\?#]/.test(value) || !/^https?:\/\/[^/]/i.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  const authority = value.match(/^https?:\/\/([^/]+)/i)?.[1];
  if (!authority || authority.includes("@") || url.username || url.password || !url.hostname) throw invalid();
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid();
  // Plain HTTP is only for explicit loopback development/test servers.
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw invalid();
  const rawPath = value.slice(value.indexOf(authority) + authority.length);
  try {
    const decoded = decodeURIComponent(rawPath);
    if (decoded.includes("\\") || /%(?:2f|5c)/i.test(rawPath) || decoded.split("/").some(segment => segment === "." || segment === "..")) throw invalid();
  } catch { throw invalid(); }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Fail-closed comparison for persisted/untrusted values. Never infers a missing issuer. */
export function sameServerIssuer(issuer: unknown, target: unknown): boolean {
  if (typeof issuer !== "string" || typeof target !== "string") return false;
  try { return normalizeServerIssuer(issuer) === normalizeServerIssuer(target); } catch { return false; }
}
