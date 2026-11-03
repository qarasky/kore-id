# Kore ID

Single sign-on for **Kore, KoreMind, KoreCalendar and Flatline (→ KoreMonitor)**.
One account, one login. It is a small OpenID Connect provider: each app is a registered client and uses the
standard authorization-code + PKCE flow. Because the login session lives on the auth domain, signing in to one
app signs you in to all of them.

Stack: Node ≥ 24 (built-in `node:sqlite`), Hono, jose. Passwords: scrypt. Tokens: EdDSA JWTs.

## Run

```sh
npm install
npm run init-clients        # writes clients.json, prints each app's secret ONCE
# edit clients.json: set real redirectUris / postLogoutRedirectUris per app
ISSUER=https://id.kore.example PORT=4000 npm start
npm test
```

| Env | Default | |
|---|---|---|
| `ISSUER` | `http://localhost:$PORT` | Public base URL. `https://` turns on `Secure` cookies |
| `DATA_DIR` | `data` | SQLite DB + `keys.json` (signing keys, 0600). **Back this up** |
| `CLIENTS_FILE` | `clients.json` | Registered apps |
| `ALLOW_REGISTRATION` | `true` | Open sign-up on/off |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for rate limiting (set behind a reverse proxy) |

Run it behind TLS. Ideally serve it on a sibling subdomain (`id.…`).

## Integrating an app

Use any OIDC library pointed at `ISSUER/.well-known/openid-configuration`:

- client id: `kore` | `koremind` | `korecalendar` | `flatline`
- scope: `openid profile email` (+ `offline_access` for refresh tokens)
- PKCE `S256` is **mandatory**; confidential clients also send the secret
- user key: the `sub` claim is the same UUID in every app, so key your user rows on it

Backends verifying bearer tokens: see `sdk/verify.ts`. Access tokens are audience-bound to the app, so a
KoreMind token is rejected by KoreCalendar.

Logout: redirect to `ISSUER/logout?id_token_hint=…&post_logout_redirect_uri=…&state=…`. This ends the SSO
session. Each app clears its own session. The account page's "Sign out everywhere" also revokes all refresh tokens.

## Endpoints

`/.well-known/openid-configuration`, `/.well-known/jwks.json`, `/authorize`, `/token`, `/userinfo`,
`/revoke`, `/logout`, `/login`, `/register`, `/account`, `/healthz`.

## Renaming Flatline → KoreMonitor

Add a `koremonitor` entry to `clients.json` and move the app over; keep `flatline` until it's migrated.
Users and `sub` are unaffected.

## Not built (yet)

Password reset / email verification (needs a mailer), MFA, change password, admin UI, consent screen
(all clients are first-party), key-rotation tooling (`keys.json` supports multiple keys: put the new one first).
