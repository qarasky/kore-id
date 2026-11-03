# Kore platform: identity + shared UI (design)

Date: 2026-11-03. Owner: sky@qarasky.dev. This is the contract every Kore repo builds against.

Repos:
- `qarasky/kore-id`: identity provider (this repo). Local: `~/.t3/projects/kore-id`.
- `qarasky/kore-ui`: shared design system + React components. Local: `~/.t3/projects/kore-ui`.
- Apps: Kore (`qarasky/kore`), KoreMind (`qarasky/koremind`), KoreCalendar (`qarasky/korecalendar`), Flatline → KoreMonitor (`qarasky/flatline`).

## Why
One account for every Kore app, and every Kore web UI looks and behaves the same. The owner has no SMTP server, so
nothing may depend on sending email.

## 1. Kore ID: accounts are admin-managed

- **No self-registration.** `/register` and open sign-up are removed.
- **Bootstrap admin.** On first start with an empty DB, Kore ID creates the admin `sky@qarasky.dev` (overridable by
  `KORE_ID_ADMIN_EMAIL`), with no password, and logs a one-time **setup link** (`/setup/<token>`, valid 24h). If the
  admin never used it, a restart with the admin still password-less logs a fresh link. No password lives in config.
- **Users are created by an admin** (email, name, role, app access). Creation returns a one-time setup link the admin
  copies to the person (shown once). The person opens it, sets a password, and is signed in.
- **Password reset** = admin clicks "Reset password" → new setup link, existing password and all sessions/refresh
  tokens for that user are revoked. A signed-in user can change their own password (needs the current one).
- **Roles:** `admin`, `user`. At least one active admin must always exist (refuse demote/disable/delete of the last).
- **Status:** active / disabled. Disabling revokes sessions + refresh tokens and fires back-channel logout.
- **Email is verified by definition** (an admin typed it). Tokens carry `email_verified: true`. Email changes are
  admin-only.
- **Per-user app access.** Each user has a set of allowed client ids. `/authorize` for a client the user may not use
  shows an "You don't have access to <App>" page (with "Sign in as someone else"), never a code. Admins always have
  access to every app. A client entry may group several client ids under one app (e.g. `korecalendar` and
  `korecalendar-android` both belong to app `korecalendar`): access is granted per **app**, see 1.1.
- Setup links: random 32-byte token, only the sha256 is stored, single use, 24h expiry.

### 1.1 Clients (apps)
`clients.json` stays the source of truth for OIDC clients (secrets as sha256, redirect URIs), with new optional fields:
- `app`: app key for access control (default: the client id). Apps: `kore`, `koremind`, `korecalendar`, `flatline`.
- `backchannelLogoutUri`: absolute URL Kore ID POSTs logout tokens to.
- `homeUrl`: shown in the account page's app launcher.

The admin UI shows clients read-only (name, id, app, redirect URIs, home URL, public/confidential). Editing clients
stays a file change (it holds secrets); the UI says so.

## 2. Kore ID: token rules

- **Access token:** JWT, header `typ: "at+jwt"` (RFC 9068), claims `iss, sub, aud (= client id), client_id, scope,
  iat, exp, jti, sid`, plus `email`, `email_verified` when scope `email`. 10 min.
- **ID token:** header `typ: "JWT"`, claims `iss, sub, aud, azp, iat, exp, auth_time, sid, nonce?, email?,
  email_verified?, name?`. **No `scope` claim.**
- **Apps MUST check `typ == at+jwt` for bearer access tokens** and reject anything else. `/userinfo` does the same.
- `sid` = the Kore ID browser session id (opaque, not the cookie value). It ties tokens to a sign-in for logout.
- **Introspection** `POST /introspect` (RFC 7662, client-authenticated): `{active, sub, client_id, scope, exp, sid}`;
  `active:false` if the token is expired, the user is disabled, or the session was ended.
- `/revoke` accepts refresh tokens (existing) and access tokens (jti denylist until exp).
- Basic client auth: malformed header → `401 invalid_client`, never 500.

## 3. Kore ID: logout

- `GET /logout` with a valid `id_token_hint` (signature + issuer valid, expiry ignored up to 24h) → ends the session,
  redirects to a registered `post_logout_redirect_uri`. Without a valid hint → confirm page ("Sign out of Kore ID?")
  that POSTs with CSRF. No cross-site silent logout.
- **Back-channel logout (OIDC Back-Channel Logout 1.0).** When a Kore ID session ends (logout, admin disable, admin
  "sign out everywhere", password reset), Kore ID POSTs `logout_token=<JWT>` (form-encoded) to the
  `backchannelLogoutUri` of every client that got tokens in that session (track session ↔ client). Logout token: header
  `typ: "logout+jwt"`, claims `iss, aud, iat, exp (+2 min), jti, sid, sub, events: {"http://schemas.openid.net/event/backchannel-logout": {}}`, no `nonce`.
  Delivery: fire-and-forget with 2 retries, 5s timeout each; failures logged, never block the user.
- Discovery adds `backchannel_logout_supported: true`, `backchannel_logout_session_supported: true`,
  `introspection_endpoint`.

### App obligations (every Kore app)
1. Store `sid` on the local session created from a Kore ID login.
2. Expose `POST <app>/…/backchannel-logout`: verify the logout token (JWKS, iss, aud = own client id, `typ`
   logout+jwt, `events` claim present, no `nonce`, jti not seen within exp), then delete every local session with that
   `sid` (or all sessions of that `sub` if no `sid`). Respond 200; 400 on invalid token.
3. Reject bearer tokens whose `typ` isn't `at+jwt`.
4. Link existing local accounts by email **when `email_verified` is true** (now the default). Keep the manual link
   tools the earlier work added.
5. Drop app-level SSO allowlists as a requirement: Kore ID enforces app access. Keep them as an optional extra filter.

## 4. Kore ID: JSON API for the web UI

All under `/api`, same-origin, cookie session (`kore_sid`, HttpOnly, SameSite=Lax), CSRF: double-submit header
`X-CSRF-Token` matching the `kore_csrf` cookie on every non-GET. JSON errors: `{error: code, message}`.

- `GET /api/session` → `{user|null, csrf}`
- `POST /api/login {email, password, returnTo?}` → `{redirect}` (returnTo validated: local `/authorize?…` only)
- `POST /api/logout`
- `GET /api/setup/:token` → `{email, name}` | 404 · `POST /api/setup/:token {password}` → signs in
- `GET /api/me` · `PATCH /api/me {name}` · `POST /api/me/password {current, next}`
- `GET /api/me/apps` → apps the user can open (name, homeUrl)
- `GET /api/me/sessions` · `DELETE /api/me/sessions/:id` · `POST /api/me/sessions/revoke-all`
- Admin (role admin): `GET/POST /api/admin/users`, `GET/PATCH/DELETE /api/admin/users/:id`
  (`name, email, role, disabled, apps[]`), `POST /api/admin/users/:id/reset` → `{setupUrl}`,
  `POST /api/admin/users/:id/signout`, `GET /api/admin/apps`, `GET /api/admin/audit?cursor=` (sign-ins, failed
  sign-ins, admin actions: actor, action, target, ip, user agent, time).

Rate limiting stays on login + setup + token. Passwords: min 10 chars, scrypt.

## 5. Kore ID web UI

A React 19 + Vite + Tailwind v4 single-page app in `web/`, built into `web/dist` and served by the Hono server (one
process, one image). Uses `kore-ui` only (no local copies of primitives). Routes:
- `/login`, `/setup/:token`, "no access to <App>" and logout-confirm screens, all using kore-ui's `AuthScreen`.
- `/account`: profile, password, active sessions (sign out one / all), "Your apps" launcher.
- `/admin` (Google Workspace Admin–style): left nav **Overview** (counts, recent activity), **Users** (searchable
  table: name, email, role, status, apps, last sign-in; row → user detail with tabs Profile / Apps / Security; "Add
  user" dialog → shows the setup link once with a copy button), **Apps** (client list, read-only, per-app user count),
  **Activity** (audit log, filter by user/action).
`/authorize` stays a server route; when it needs a login it redirects to the SPA's `/login?return_to=…`.

## 6. kore-ui: one design system for every Kore web UI

- **Source of truth:** `kore-ui/DESIGN.md` (principles, tokens, type, spacing, layout, components, voice). Every app's
  own design doc defers to it; KoreMind's `DESIGN.md` keeps only chat-specific parts.
- **Look:** the existing Kore palette and density (dark only), already shared by all four apps:
  bg `#16181d`, surface `#1d2026`, raised `#23262d`, border `#2c3038`, border-strong `#3a3f49`, text `#e6e8ee`,
  muted `#8a8f9a`, accent `#5b8def`, accent-hover `#7aa3f2`, danger `#f2777a`, warning `#e5a54b`, plus status colours
  (up/warn/down/maint) from Flatline. Inter, 6px radius, hairline borders, no gradients.
- **Package:** `@qarasky/kore-ui`, React 19 + Tailwind v4, built on Radix primitives (`radix-ui`), lucide icons.
  **Ships TypeScript source + CSS, no build step.** Consumers:
  - `package.json`: `"@qarasky/kore-ui": "https://codeload.github.com/qarasky/kore-ui/tar.gz/refs/tags/vX.Y.Z"`
  - CSS: `@import "@qarasky/kore-ui/theme.css";` and `@source "../node_modules/@qarasky/kore-ui/src";`
    (path relative to the CSS file)
  - Next.js: `transpilePackages: ["@qarasky/kore-ui"]`.
  - Peer deps: react, react-dom ^19, tailwindcss ^4. Radix and lucide are regular deps of kore-ui.
- **Contents:** tokens/theme; Button, IconButton, Input, Textarea, Field (label/hint/error), Select, Checkbox,
  Switch, RadioGroup, Dialog, ConfirmDialog, Menu (dropdown + context), Popover, Tooltip, Tabs, Toast, Table,
  Badge, StatusDot, Avatar, EmptyState, Spinner, Skeleton, Kbd, CopyButton; layout: AppShell (sidebar, drawer on
  narrow), Sidebar + nav items, TopBar, PageHeader, SettingsLayout (section nav + content column); identity:
  AccountMenu (user, "Kore ID account", app switcher, sign out), AppSwitcher (the four apps), AuthScreen
  (sign-in card with "Continue with Kore ID" + optional password form), KoreLogo/app marks.
- **Showcase:** a `pnpm dev`/`npm run dev` Vite page rendering every component (also used for screenshots).
- **Versioning:** semver tags; apps pin a tag. Breaking changes bump the minor while < 1.0.

## 7. Rollout order
1. kore-id backend (§1–4) and kore-ui v0.1.0 (§6), in parallel.
2. kore-id web UI (§5) on kore-ui.
3. The four apps, in parallel, on their existing `feat/kore-id-sso` branches: app obligations (§3), adopt kore-ui
   (replace local primitives, shell, account menu, sign-in screen; restyle app-specific views on kore-ui parts).

## Non-goals
Email delivery, MFA, social login, consent screens (all clients are first-party), light theme, editing OIDC clients
from the UI, the Flatline → KoreMonitor rename itself.
