// Drives a running Kore ID like a person would and writes docs/screenshots/*.png.
//
//   KORE_ID_URL=http://localhost:4000 ADMIN_SETUP_URL=http://localhost:4000/setup/… node web/scripts/walkthrough.mjs
//
// Needs a fresh server (empty DATA_DIR) whose clients.json comes from `npm run init-clients` (app URLs on
// localhost:3001-3004; nothing has to listen there: the script reads the redirects instead of following them).
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const BASE = (process.env.KORE_ID_URL ?? "http://localhost:4000").replace(/\/$/, "");
const SETUP = process.env.ADMIN_SETUP_URL;
if (!SETUP) throw new Error("Set ADMIN_SETUP_URL to the link the server printed.");
const OUT = fileURLToPath(new URL("../../docs/screenshots/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const ADMIN_PW = "admin password 1";
const USER_PW = "anna password 1";
const viewport = { width: 1280, height: 800 };
const browser = await chromium.launch();
const step = (m) => console.log(`walkthrough: ${m}`);
const shot = async (page, name) => {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(250); // let dialogs finish animating
  await page.screenshot({ path: `${OUT}${name}.png` });
  step(`screenshot ${name}.png`);
};
const expectText = async (page, text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 5000 });

const newContext = () => browser.newContext({ viewport, colorScheme: "dark" });
/** GET /authorize with the page's cookies, without following the redirect; returns where it points. */
const authorizeRedirect = async (page, url) => {
  const r = await page.context().request.get(url, { maxRedirects: 0 });
  if (r.status() !== 302) throw new Error(`expected a redirect from /authorize, got ${r.status()}`);
  return r.headers().location;
};
const authorizeUrl = (clientId, port) => {
  const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
  return `${BASE}/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: `http://localhost:${port}/auth/callback`, response_type: "code",
    scope: "openid profile email", state: "st", code_challenge: challenge, code_challenge_method: "S256",
  })}`;
};

// 1. The bootstrap admin opens the setup link and sets a password.
const adminCtx = await newContext();
const admin = await adminCtx.newPage();
await admin.goto(SETUP);
await expectText(admin, "sky@qarasky.dev");
await shot(admin, "setup");
await admin.getByLabel("New password").fill("short");
await admin.getByRole("button", { name: "Set password and sign in" }).click();
await expectText(admin, "Use at least 10 characters.");
await admin.getByLabel("New password").fill(ADMIN_PW);
await admin.getByLabel("Confirm password").fill(ADMIN_PW);
await admin.getByRole("button", { name: "Set password and sign in" }).click();
await admin.waitForURL(`${BASE}/account`);
step("admin set a password and is signed in");

// The used link no longer works.
const gone = await (await newContext()).newPage();
await gone.goto(SETUP);
await expectText(gone, "Ask your admin for a new link");
await shot(gone, "setup-expired");

// 2. Sign in with a password in a fresh browser (wrong first).
const loginCtx = await newContext();
const login = await loginCtx.newPage();
await login.goto(`${BASE}/login`);
await shot(login, "login");
await login.getByLabel("Email").fill("sky@qarasky.dev");
await login.getByLabel("Password").fill("wrong password");
await login.getByRole("button", { name: "Sign in" }).click();
await expectText(login, "That email and password don't match");
await shot(login, "login-error");
await login.getByLabel("Password").fill(ADMIN_PW);
await login.getByRole("button", { name: "Sign in" }).click();
await login.waitForURL(`${BASE}/account`);
step("admin signed in with the password");

// 3. Add a user with access to Kore only.
await admin.goto(`${BASE}/admin/users`);
await admin.getByRole("button", { name: "Add user" }).click();
const dialog = admin.getByRole("dialog");
await dialog.getByLabel("Name").fill("Anna Berg");
await dialog.getByLabel("Email").fill("anna@northwind.example");
await dialog.getByLabel("Kore", { exact: true }).check();
await dialog.getByRole("button", { name: "Add user" }).click();
await expectText(admin, "Send this link to Anna Berg. It works once and expires in 24 hours.");
const annaSetup = await admin.getByLabel("Setup link").inputValue();
await shot(admin, "admin-add-user-link");
await admin.getByRole("button", { name: "Done" }).click();
step(`added Anna, setup link ${annaSetup.slice(0, 40)}…`);

// A second user, so the tables have some variety.
await admin.getByRole("button", { name: "Add user" }).click();
await dialog.getByLabel("Name").fill("Tom Okafor");
await dialog.getByLabel("Email").fill("tom@northwind.example");
await dialog.getByLabel("KoreCalendar").check();
await dialog.getByLabel("KoreMonitor").or(dialog.getByLabel(/Flatline/)).check();
await dialog.getByRole("button", { name: "Add user" }).click();
await expectText(admin, "Send this link to Tom Okafor.");
await admin.getByRole("button", { name: "Done" }).click();

// 4. Anna sets her password in her own browser.
const annaCtx = await newContext();
const anna = await annaCtx.newPage();
await anna.goto(annaSetup);
await expectText(anna, "anna@northwind.example");
await anna.getByLabel("New password").fill(USER_PW);
await anna.getByLabel("Confirm password").fill(USER_PW);
await anna.getByRole("button", { name: "Set password and sign in" }).click();
await anna.waitForURL(`${BASE}/account`);
await shot(anna, "account");
await anna.goto(`${BASE}/account/apps`);
await expectText(anna, "Kore");
await shot(anna, "account-apps");
step("Anna set her password");

// 5. Anna may not use KoreMind yet: /authorize answers 403 with the no-access screen, never a code.
const denied = await anna.goto(authorizeUrl("koremind", 3002));
if (denied.status() !== 403) throw new Error(`expected 403 from /authorize, got ${denied.status()}`);
await expectText(anna, "You don't have access to KoreMind");
await shot(anna, "no-access");
// Kore works: a code goes back to the app.
if (!(await authorizeRedirect(anna, authorizeUrl("kore", 3001))).startsWith("http://localhost:3001/auth/callback?code="))
  throw new Error("no code for Kore");
step("Kore: code issued; KoreMind: no access");

// 6. The admin turns KoreMind on in Anna's user detail.
await admin.goto(`${BASE}/admin/users`);
await admin.getByRole("link", { name: "Anna Berg" }).click();
await expectText(admin, "anna@northwind.example");
await shot(admin, "admin-user-profile");
await admin.getByRole("link", { name: "Apps" }).last().click();
await admin.getByRole("switch", { name: "KoreMind" }).click();
await expectText(admin, "Anna Berg can now use KoreMind");
await shot(admin, "admin-user-apps");
if (!(await authorizeRedirect(anna, authorizeUrl("koremind", 3002))).startsWith("http://localhost:3002/auth/callback?code="))
  throw new Error("no code for KoreMind after granting access");
step("after granting KoreMind, /authorize issues a code");
// And off again: back to the no-access screen.
await admin.getByRole("switch", { name: "KoreMind" }).click();
await expectText(admin, "Anna Berg can no longer use KoreMind");
const denied2 = await anna.goto(authorizeUrl("koremind", 3002));
if (denied2.status() !== 403) throw new Error(`expected 403 after removing access, got ${denied2.status()}`);
step("after removing KoreMind, /authorize is 403 again");

// "Sign in as someone else" keeps the request and forces the form.
await anna.getByRole("link", { name: "Sign in as someone else" }).click();
await expectText(anna, "Sign in as someone else");
await expectText(anna, "Sign in with another account to use KoreMind");
await shot(anna, "login-switch-account");
// Anna isn't an admin: the admin console says so.
await anna.goto(`${BASE}/admin`);
await expectText(anna, "You need admin access");
await shot(anna, "admin-forbidden");

await admin.getByRole("link", { name: "Security" }).last().click();
await expectText(admin, "Active sessions");
await shot(admin, "admin-user-security");
await admin.getByRole("button", { name: "Reset password" }).click();
await admin.getByRole("alertdialog").getByRole("button", { name: "Reset password" }).click();
await expectText(admin, "Send this link to Anna Berg.");
await shot(admin, "admin-reset-link");
await admin.getByRole("button", { name: "Done" }).click();

// The last admin can't be demoted.
await admin.goto(`${BASE}/admin/users`);
await admin.getByRole("link", { name: "Admin" }).first().waitFor();
await admin.locator("tbody tr").first().click();
await admin.getByRole("combobox").click();
await admin.getByRole("option", { name: "User" }).click();
await admin.getByRole("button", { name: "Save" }).click();
await expectText(admin, "This is the last active admin");
step("last_admin is refused with a clear message");

// 7. The admin pages.
await admin.goto(`${BASE}/admin/users`);
await expectText(admin, "Tom Okafor");
await shot(admin, "admin-users");
await admin.goto(`${BASE}/admin/apps`);
await expectText(admin, "Edit clients.json");
await shot(admin, "admin-apps");
await admin.goto(`${BASE}/admin/activity`);
await expectText(admin, "Added user");
await shot(admin, "admin-activity");
await admin.goto(`${BASE}/admin`);
await expectText(admin, "Recent activity");
await shot(admin, "admin-overview");
await admin.goto(`${BASE}/account/security`);
await expectText(admin, "This device");
await shot(admin, "account-security");

// 8. RP-initiated logout without a hint asks first; the form posts to the server, which redirects back.
await login.goto(`${BASE}/logout?client_id=kore&post_logout_redirect_uri=${encodeURIComponent("http://localhost:3001/")}`);
await expectText(login, "Sign out of Kore ID?");
await shot(login, "logout-confirm");
const posted = login.waitForResponse((r) => r.url() === `${BASE}/logout` && r.request().method() === "POST");
await login.getByRole("button", { name: "Sign out" }).click();
const res = await posted;
if (res.status() !== 302 || res.headers().location !== "http://localhost:3001/") throw new Error(`logout went to ${res.headers().location}`);
await login.goto(`${BASE}/account`);
await login.waitForURL(/\/login/);
step("logout confirm signed out and returned to the app");

// Tom hasn't set a password yet, so he can't sign in.
const tom = await (await newContext()).newPage();
await tom.goto(`${BASE}/login`);
await tom.getByLabel("Email").fill("tom@northwind.example");
await tom.getByLabel("Password").fill("nope nope nope");
await tom.getByRole("button", { name: "Sign in" }).click();
await expectText(tom, "don't match");

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", storageState: await adminCtx.storageState() });
const m = await mobile.newPage();
await m.goto(`${BASE}/admin/users`);
await expectText(m, "Anna Berg");
await shot(m, "mobile-admin-users");

await browser.close();
step("done");
