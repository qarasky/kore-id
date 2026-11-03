import { KoreProvider } from "@qarasky/kore-ui";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { setCsrf } from "../lib/api";
import { mockFetch } from "../test/fetch";
import { LoginScreen } from "./Login";

const returnTo = "/authorize?client_id=koremind&redirect_uri=x&response_type=code";

function renderAt(path: string) {
  const { hook, searchHook } = memoryLocation({ path });
  return render(
    <KoreProvider>
      <Router hook={hook} searchHook={searchHook}>
        <LoginScreen />
      </Router>
    </KoreProvider>,
  );
}

beforeEach(() => setCsrf(null));
afterEach(() => vi.unstubAllGlobals());

it("names the app being signed in to and maps invalid_credentials to a sentence", async () => {
  const calls = mockFetch({
    "GET /api/session?client_id=koremind": [200, { user: null, csrf: "tok", app: { app: "koremind", name: "KoreMind" } }],
    "POST /api/login": [401, { error: "invalid_credentials", message: "Invalid email or password." }],
  });
  renderAt(`/login?return_to=${encodeURIComponent(returnTo)}`);
  expect(await screen.findByText("Sign in to continue to KoreMind.")).toBeInTheDocument();

  await userEvent.type(screen.getByLabelText("Email"), "anna@example.com");
  await userEvent.type(screen.getByLabelText("Password"), "wrong password");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(await screen.findByText("That email and password don't match. Try again, or ask your admin for a reset link.")).toBeInTheDocument();
  expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
  const login = calls.find((c) => c.method === "POST")!;
  expect(login.headers["x-csrf-token"]).toBe("tok");
  expect(login.body).toEqual({ email: "anna@example.com", password: "wrong password", returnTo });
});

it("says why when rate limited, without marking the fields invalid", async () => {
  mockFetch({
    "GET /api/session": [200, { user: null, csrf: "tok" }],
    "POST /api/login": [429, { error: "rate_limited", message: "Too many attempts." }],
  });
  renderAt("/login");
  await userEvent.type(await screen.findByLabelText("Email"), "anna@example.com");
  await userEvent.type(screen.getByLabelText("Password"), "whatever123");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Too many attempts. Wait 15 minutes and try again.")).toBeInTheDocument();
  expect(screen.getByLabelText("Password")).not.toHaveAttribute("aria-invalid");
});

it("drops a return_to that isn't a local /authorize URL", async () => {
  const calls = mockFetch({
    "GET /api/session": [200, { user: null, csrf: "tok" }],
    "POST /api/login": [401, { error: "invalid_credentials", message: "" }],
  });
  renderAt(`/login?return_to=${encodeURIComponent("https://evil.example/")}`);
  await userEvent.type(await screen.findByLabelText("Email"), "a@b.co");
  await userEvent.type(screen.getByLabelText("Password"), "whatever123");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText(/don't match/);
  expect(calls.find((c) => c.method === "POST")?.body).toEqual({ email: "a@b.co", password: "whatever123" });
});

it("with prompt=login shows the form even when signed in", async () => {
  mockFetch({
    "GET /api/session?client_id=koremind": [
      200,
      { user: { id: "1", email: "anna@example.com", name: "Anna", role: "user", disabled: false, hasPassword: true, apps: [] }, csrf: "t", app: { app: "koremind", name: "KoreMind" } },
    ],
  });
  renderAt(`/login?return_to=${encodeURIComponent(returnTo)}&prompt=login`);
  expect(await screen.findByRole("heading", { name: "Sign in as someone else" })).toBeInTheDocument();
  expect(screen.getByText(/You're signed in as anna@example.com/)).toBeInTheDocument();
});
