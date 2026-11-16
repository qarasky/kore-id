import { KoreProvider } from "@qarasky/kore-ui";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { setCsrf } from "../lib/api";
import { mockFetch } from "../test/fetch";
import { SetupScreen } from "./Setup";

function renderSetup() {
  const { hook, searchHook } = memoryLocation({ path: "/setup/tok1" });
  return render(
    <KoreProvider>
      <Router hook={hook} searchHook={searchHook}>
        <Route path="/setup/:token" component={SetupScreen} />
      </Router>
    </KoreProvider>,
  );
}

beforeEach(() => setCsrf("tok"));
afterEach(() => vi.unstubAllGlobals());

it("shows a read-only email, a show/hide toggle and the length rule, and blocks a short password", async () => {
  const calls = mockFetch({ "GET /api/setup/tok1": [200, { email: "anna@example.com", name: "Anna" }] });
  renderSetup();
  expect(await screen.findByRole("heading", { name: "Set your password" })).toBeInTheDocument();
  expect(screen.getByLabelText("Email")).toHaveAttribute("readonly");
  expect(screen.getByLabelText("New password")).toHaveAttribute("autocomplete", "new-password");
  expect(screen.getByRole("button", { name: "Show password" })).toBeInTheDocument();
  expect(screen.getByText("At least 10 characters")).toBeInTheDocument();

  await userEvent.type(screen.getByLabelText("New password"), "short");
  await userEvent.click(screen.getByRole("button", { name: "Set password and sign in" }));
  expect(await screen.findByText("Use at least 10 characters.")).toBeInTheDocument();
  expect(calls.some((c) => c.method === "POST")).toBe(false);
});
