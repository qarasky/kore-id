// Minimal server-rendered pages for routes that must work without JS (/authorize, /logout).
// The SPA in web/ owns every other screen.
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Kore ID</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;font-size:14px}
body{display:grid;place-items:center;min-height:100vh;margin:0;background:#16181d;color:#e6e8ee}
main{width:min(380px,90vw);background:#1d2026;border:1px solid #2c3038;border-radius:6px;padding:24px}
h1{font-size:18px;font-weight:600;margin:0 0 12px}
p{color:#8a8f9a;line-height:1.5;margin:0 0 16px}
.row{display:flex;gap:8px;flex-wrap:wrap}
button,.btn{display:inline-block;padding:8px 14px;font:inherit;border:1px solid #3a3f49;border-radius:6px;background:#23262d;color:#e6e8ee;cursor:pointer;text-decoration:none}
button.primary,.btn.primary{background:#5b8def;border-color:#5b8def;color:#fff}
button.primary:hover,.btn.primary:hover{background:#7aa3f2}
a{color:#5b8def}
</style></head><body><main>${body}</main></body></html>`;

export const messagePage = (title: string, msg: string) => page(title, `<h1>${esc(title)}</h1><p>${esc(msg)}</p>`);

export const noAccessPage = (appName: string, switchUrl: string) =>
  page('No access', `<h1>You don't have access to ${esc(appName)}</h1>
<p>Your Kore ID account isn't allowed to use ${esc(appName)}. Ask an administrator for access, or sign in with a different account.</p>
<div class="row"><a class="btn primary" href="${esc(switchUrl)}">Sign in as someone else</a><a class="btn" href="/account">Your account</a></div>`);

export const logoutConfirmPage = (o: { csrf: string; redirect?: string; clientId?: string; state?: string }) =>
  page('Sign out', `<h1>Sign out of Kore ID?</h1>
<p>You will be signed out of every Kore app in this browser.</p>
<form method="post" action="/logout">
<input type="hidden" name="csrf" value="${esc(o.csrf)}">
${o.redirect ? `<input type="hidden" name="post_logout_redirect_uri" value="${esc(o.redirect)}">` : ''}
${o.clientId ? `<input type="hidden" name="client_id" value="${esc(o.clientId)}">` : ''}
${o.state ? `<input type="hidden" name="state" value="${esc(o.state)}">` : ''}
<div class="row"><button class="primary">Sign out</button><a class="btn" href="/account">Cancel</a></div></form>`);

export const signedOutPage = () => messagePage('Signed out', 'You have been signed out of Kore ID.');

export const webNotBuiltPage = () =>
  messagePage('Web UI not built', 'The Kore ID web UI is not built. Run `npm run build` in web/ (it is served from web/dist).');
