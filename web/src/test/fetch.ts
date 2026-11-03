import { vi } from "vitest";

export type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** Stub fetch with a route table: "METHOD /api/path" → [status, json]. Records every call. */
export function mockFetch(routes: Record<string, [number, unknown] | ((c: Call) => [number, unknown])>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { method, url, headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = `${method} ${url.split("?")[0]}`;
    const route = routes[`${method} ${url}`] ?? routes[key];
    if (!route) return new Response(JSON.stringify({ error: "not_found", message: "Not found." }), { status: 404 });
    const [status, json] = typeof route === "function" ? route(call) : route;
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}
