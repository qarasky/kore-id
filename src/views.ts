const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Kore ID</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{display:grid;place-items:center;min-height:100vh;margin:0;background:Canvas}
main{width:min(360px,90vw)}
h1{font-size:1.4rem;margin:0 0 1.2rem}
label{display:block;margin:.8rem 0 .25rem;font-size:.85rem}
input{width:100%;box-sizing:border-box;padding:.6rem;font:inherit;border:1px solid #8886;border-radius:6px;background:Field;color:FieldText}
button{margin-top:1.2rem;width:100%;padding:.65rem;font:inherit;border:0;border-radius:6px;background:#3b5bdb;color:#fff;cursor:pointer}
.err{background:#e0313122;border:1px solid #e03131;padding:.5rem .7rem;border-radius:6px;margin-bottom:1rem;font-size:.9rem}
p.alt{margin-top:1rem;font-size:.9rem;text-align:center}
</style></head><body><main>${body}</main></body></html>`;

interface FormOpts { csrf: string; error?: string; returnTo?: string; email?: string; name?: string; app?: string }

const err = (e?: string) => (e ? `<div class="err">${esc(e)}</div>` : '');
const hidden = (o: FormOpts) =>
  `<input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="return_to" value="${esc(o.returnTo ?? '')}">`;
const qs = (o: FormOpts) => (o.returnTo ? `?return_to=${encodeURIComponent(o.returnTo)}` : '');

export const loginPage = (o: FormOpts & { allowRegistration: boolean }) =>
  page('Sign in', `<h1>Sign in${o.app ? ` to ${esc(o.app)}` : ''}</h1>${err(o.error)}
<form method="post" action="/login">${hidden(o)}
<label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username" required autofocus value="${esc(o.email ?? '')}">
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button>Sign in</button></form>
${o.allowRegistration ? `<p class="alt"><a href="/register${esc(qs(o))}">Create a Kore account</a></p>` : ''}`);

export const registerPage = (o: FormOpts) =>
  page('Create account', `<h1>Create your Kore account</h1>${err(o.error)}
<form method="post" action="/register">${hidden(o)}
<label for="n">Name</label><input id="n" name="name" required autocomplete="name" value="${esc(o.name ?? '')}">
<label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username" required value="${esc(o.email ?? '')}">
<label for="p">Password (min 10 characters)</label><input id="p" name="password" type="password" minlength="10" autocomplete="new-password" required>
<button>Create account</button></form>
<p class="alt"><a href="/login${esc(qs(o))}">I already have an account</a></p>`);

export const messagePage = (title: string, msg: string) => page(title, `<h1>${esc(title)}</h1><p>${esc(msg)}</p>`);

export const accountPage = (user: { name: string; email: string }, csrf: string) =>
  page('Account', `<h1>${esc(user.name)}</h1><p>${esc(user.email)}</p>
<p>One account for Kore, KoreMind, KoreCalendar and KoreMonitor.</p>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Sign out everywhere</button></form>`);
