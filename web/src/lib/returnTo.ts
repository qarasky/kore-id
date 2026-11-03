/** Same rule as the server: only a local /authorize URL is a valid return_to. */
export const safeReturnTo = (v: string | null | undefined) => (v && /^\/authorize\?[^\s\\]*$/.test(v) ? v : "");

/** The client_id inside a return_to (/authorize?client_id=…). */
export function clientIdOf(returnTo: string): string | undefined {
  if (!returnTo) return;
  return new URLSearchParams(returnTo.slice(returnTo.indexOf("?") + 1)).get("client_id") ?? undefined;
}

/** "Sign in as someone else" for an /authorize request: the same request, forcing the sign-in form. */
export function switchAccountUrl(authorizeSearch: string): string {
  const params = new URLSearchParams(authorizeSearch);
  params.delete("prompt");
  return `/login?return_to=${encodeURIComponent(`/authorize?${params}`)}&prompt=login`;
}
