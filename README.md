# Kore ID

Single sign-on for **Kore, KoreMind, KoreCalendar and Flatline (→ KoreMonitor)**.
One account, one login. It is a small OpenID Connect provider: each app is a registered client and uses the
standard authorization-code + PKCE flow. Because the login session lives on the auth domain, signing in to one
app signs you in to all of them.

Accounts are **admin-managed**: there is no sign-up and nothing depends on email. An admin creates a user and hands
them a one-time setup link. Contract: [`docs/specs/2026-11-03-kore-platform-design.md`](docs/specs/2026-11-03-kore-platform-design.md).

Stack: Node ≥ 24 (built-in `node:sqlite`), Hono, jose. Passwords: scrypt (min 10 chars). Tokens: EdDSA JWTs.

## Run

```sh
npm install
npm run install:web && npm run build:web   # the web UI: web/dist (npm start serves it; build it first)
npm run init-clients        # writes clients.json, prints each app's secret ONCE
# edit clients.json: set real redirectUris / postLogoutRedirectUris / backchannelLogoutUri / homeUrl per app
ISSUER=https://id.kore.example PORT=4000 npm start
npm test && npm run typecheck              # server
npm run test:web && npm run typecheck:web  # web UI
```

Developing the web UI: run the server with the Vite origin as issuer, and Vite next to it (it proxies `/api`,
`/authorize`, `/logout`, `/token`, `/userinfo` and `/.well-known` to the server on :4000):

```sh
ISSUER=http://localhost:5173 npm run dev   # server on :4000
npm run dev:web                            # http://localhost:5173
```

| Env | Default | |
|---|---|---|
| `ISSUER` | `http://localhost:$PORT` | Public base URL. `https://` turns on `Secure` cookies |
| `DATA_DIR` | `data` | SQLite DB + `keys.json` (signing keys, 0600). **Back this up** |
| `CLIENTS_FILE` | `clients.json` | Registered apps |
| `KORE_ID_ADMIN_EMAIL` | `sky@qarasky.dev` | Bootstrap admin (see below) |
| `WEB_DIR` | `web/dist` | Built web UI (SPA). Without it, `/login`, `/account`… show "web UI not built" |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for rate limiting and the audit log (set behind a reverse proxy) |

Run it behind TLS. Ideally serve it on a sibling subdomain (`id.…`).

## Deploy (Docker)

Images: `ghcr.io/qarasky/kore-id` for linux/amd64 and arm64. `:edge` and `:sha-<short>` follow main; release tags
`vX.Y.Z` publish `:X.Y.Z`, `:X.Y` and `:latest`. The image runs `node src/server.ts` as the non-root `node` user,
keeps everything in the `/data` volume (`DATA_DIR=/data`, `CLIENTS_FILE=/data/clients.json`) and has a
`HEALTHCHECK` on `/healthz`. `compose.yaml` runs it behind your reverse proxy:

```sh
mkdir -p data
docker compose run --rm kore-id node scripts/init-clients.ts   # writes data/clients.json, prints secrets ONCE
# edit data/clients.json for your apps
echo ISSUER=https://id.kore.example >> .env
docker compose up -d
docker compose logs kore-id | grep -A1 'setup link'             # the first admin's one-time setup link
```

Open the link, set the admin password, then add users under `/admin`. Back up `data/` (DB, signing keys,
clients). `scripts/smoke.sh` checks an image the way CI does (`KORE_ID_IMAGE=kore-id:local SMOKE_PULL=0`).

## First start: the admin setup link

On first start with an empty DB, Kore ID creates the admin `KORE_ID_ADMIN_EMAIL` **without a password** and prints
a one-time setup link to the log:

```
Admin sky@qarasky.dev has no password yet. One-time setup link (valid 24h):
  https://id.kore.example/setup/…
```

Open it, choose a password, and you're signed in. If the link expired or got lost, just restart: as long as the
admin still has no password, every start prints a fresh link (the old one stops working). No password lives in
config. (Upgrading an existing DB: if it has no admin yet, that email is promoted, or created.)

## Users and app access

Everything is done in the web UI under `/admin` (or the JSON API below):

- **Add user**: email, name, role (`admin` | `user`), apps. You get a setup link **once**; copy it to the person.
  They open it, set a password and are signed in. Emails are trusted (an admin typed them), so tokens carry
  `email_verified: true`. Only admins change emails.
- **Reset password**: clears the password, signs the user out everywhere (sessions + refresh tokens, back-channel
  logout) and returns a new setup link.
- **Disable**: same sign-out, and the account can't sign in. **Sign out everywhere**: sign-out only.
- The **last active admin** can't be demoted, disabled or deleted.
- **App access** is per app key (`kore`, `koremind`, `korecalendar`, `flatline`). Admins can use every app. A user
  without access who reaches `/authorize` gets a "You don't have access to <App>" page, never a code
  (`prompt=none` → `error=access_denied`). Several clients can share an app key (`korecalendar` +
  `korecalendar-android`).

Sign-ins, failed sign-ins and admin actions go to the audit log (`/admin` → Activity).

## clients.json

```jsonc
{
  "id": "korecalendar",                 // OIDC client_id
  "name": "KoreCalendar",
  "app": "korecalendar",                // access-control key (default: id)
  "secretHash": "<sha256 hex>",         // omit for public clients (native apps: PKCE only)
  "redirectUris": ["https://cal.kore.example/auth/callback"],
  "postLogoutRedirectUris": ["https://cal.kore.example/"],
  "backchannelLogoutUri": "https://cal.kore.example/auth/backchannel-logout",
  "homeUrl": "https://cal.kore.example/" // app launcher on /account
}
```

Clients are read-only in the admin UI; edit the file (it holds secrets) and restart.

## Integrating an app

Use any OIDC library pointed at `ISSUER/.well-known/openid-configuration`:

- client id: `kore` | `koremind` | `korecalendar` (`korecalendar-android` for the native app) | `flatline`
- scope: `openid profile email` (+ `offline_access` for refresh tokens)
- PKCE `S256` is **mandatory**; confidential clients also send the secret (Basic or POST body)
- user key: the `sub` claim is the same UUID in every app, so key your user rows on it

Tokens:
- **Access token** (10 min): header `typ: at+jwt`, claims `iss sub aud(=client id) client_id scope iat exp jti sid`
  (+ `email email_verified` with scope `email`). **Reject any bearer token whose `typ` isn't `at+jwt`.**
- **ID token**: header `typ: JWT`, claims `iss sub aud azp iat exp auth_time sid nonce? email? email_verified? name?`.
  No `scope`.

Backends verifying bearer tokens: `sdk/verify.ts` (`createVerifier`, enforces `typ`, audience, issuer).

**Introspection** (RFC 7662): `POST /introspect` with client auth and `token=…` →
`{active, sub, client_id, scope, exp, sid, …}`. `active:false` when the token is expired/revoked, the user is
disabled or lost access to the app, or its session ended. A client can only introspect its own tokens.

**Revocation** (RFC 7009): `POST /revoke` accepts refresh tokens and access tokens (the access token's `jti` is
denylisted until it expires).

## Logout

- **RP-initiated**: redirect to `ISSUER/logout?id_token_hint=…&post_logout_redirect_uri=…&state=…`. With a valid
  hint (signature + issuer; expiry ignored up to 24 h) the Kore ID session ends and the browser goes back to the
  registered `post_logout_redirect_uri`. Without a valid hint, Kore ID shows a "Sign out of Kore ID?" confirm page
  (pass `client_id` to keep the redirect). No cross-site silent logout.
- **Back-channel** (OIDC Back-Channel Logout 1.0): whenever a Kore ID session ends (logout, admin disable, sign out
  everywhere, password reset/change), Kore ID POSTs `logout_token=<JWT>` to the `backchannelLogoutUri` of every
  client that got tokens in that session. Header `typ: logout+jwt`; claims `iss aud iat exp(+2 min) jti sid sub
  events`. Fire-and-forget, 2 retries, 5 s timeout each; failures are logged.
  Apps: store `sid` on the local session, verify the token with `createLogoutVerifier` from `sdk/verify.ts`,
  delete every local session with that `sid` (or of that `sub` if no `sid`), answer 200 (400 if invalid).
- Ending a session also revokes the refresh tokens issued in it.

## Web UI and JSON API

The web UI is a React SPA in `web/` built to `web/dist` and served by this process: `/login`, `/setup/:token`,
`/account`, `/admin/*` return `web/dist/index.html`; `/assets/*` are served with a 1-year immutable cache.
`/authorize` and `/logout` stay server routes: they decide, the SPA only renders. A user without access to an app
gets the SPA's "You don't have access to <App>" screen from `/authorize` itself (status 403, never a code), and
`GET /logout` without a valid hint serves the SPA's confirm screen, whose form posts to `POST /logout` (CSRF and
the redirect are checked there). Without a built UI both fall back to minimal server HTML.

The UI is built only from [kore-ui](https://github.com/qarasky/kore-ui). Screenshots: `docs/screenshots/`
(regenerate with `web/scripts/walkthrough.mjs` against a fresh server; see its header).

The SPA talks to `/api/*` (same-origin, `kore_sid` cookie). Every non-GET needs header `X-CSRF-Token` equal to the
`csrf` value from `GET /api/session`. Errors: `{error, message}`.

`GET /api/session` (`?client_id=` adds `app: {app, name}`), `POST /api/login`, `POST /api/logout`, `GET|POST /api/setup/:token`, `GET|PATCH /api/me`,
`POST /api/me/password`, `GET /api/me/apps`, `GET /api/me/sessions`, `DELETE /api/me/sessions/:id`,
`POST /api/me/sessions/revoke-all`, and for admins `GET|POST /api/admin/users`, `GET|PATCH|DELETE
/api/admin/users/:id`, `POST /api/admin/users/:id/reset`, `POST /api/admin/users/:id/signout`,
`GET /api/admin/apps`, `GET /api/admin/audit?cursor=&limit=&user=&action=`. Shapes: `src/api.ts`.

## Endpoints

`/.well-known/openid-configuration`, `/.well-known/jwks.json`, `/authorize`, `/token`, `/userinfo`,
`/introspect`, `/revoke`, `/logout`, `/healthz`, `/api/*`, SPA routes.

## Renaming Flatline → KoreMonitor

Add a `koremonitor` entry to `clients.json` (with `"app": "flatline"` to keep everyone's access) and move the app
over; keep `flatline` until it's migrated. Users and `sub` are unaffected.

## Not built (yet)

Email delivery, MFA, consent screen (all clients are first-party), editing clients from the UI, key-rotation
tooling (`keys.json` supports multiple keys: put the new one first).
