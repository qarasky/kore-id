import { KoreProvider } from "@qarasky/kore-ui";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setCsrf } from "../lib/api";
import type { AdminApp } from "../lib/types";
import { mockFetch } from "../test/fetch";
import { AddUserDialog } from "./AddUserDialog";

const app = (key: string, name: string): AdminApp => ({ app: key, name, homeUrl: null, userCount: 0, clients: [] });
const APPS = [app("kore", "Kore"), app("koremind", "KoreMind"), app("korecalendar", "KoreCalendar")];
const SETUP = "http://id.test/setup/abc123";

beforeEach(() => setCsrf("csrf-1"));
afterEach(() => vi.unstubAllGlobals());

function renderDialog(onCreated = vi.fn()) {
  render(
    <KoreProvider>
      <AddUserDialog open onOpenChange={() => {}} apps={APPS} onCreated={onCreated} />
    </KoreProvider>,
  );
  return onCreated;
}

it("adds a user with the chosen apps and shows the setup link once", async () => {
  const calls = mockFetch({
    "POST /api/admin/users": (c) => [201, { user: { id: "u1", apps: (c.body as { apps: string[] }).apps, ...(c.body as object), disabled: false, hasPassword: false }, setupUrl: SETUP }],
  });
  const onCreated = renderDialog();
  const dialog = screen.getByRole("dialog", { name: "Add user" });
  await userEvent.type(within(dialog).getByLabelText(/Name/), "Anna Berg");
  await userEvent.type(within(dialog).getByLabelText(/Email/), "anna@example.com");
  await userEvent.click(within(dialog).getByLabelText("KoreMind"));
  await userEvent.click(within(dialog).getByRole("button", { name: "Add user" }));

  expect(await screen.findByText("Send this link to Anna Berg. It works once and expires in 24 hours.")).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Anna Berg was added" })).toBeInTheDocument();
  expect(screen.getByLabelText("Setup link")).toHaveValue(SETUP);
  expect(screen.getByRole("button", { name: /Copy/ })).toBeInTheDocument();

  expect(calls).toHaveLength(1);
  expect(calls[0]!.headers["x-csrf-token"]).toBe("csrf-1");
  expect(calls[0]!.body).toEqual({ name: "Anna Berg", email: "anna@example.com", role: "user", apps: ["koremind"] });
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "u1", name: "Anna Berg" }));
});

it("shows email_taken next to the email field and stays on the form", async () => {
  mockFetch({ "POST /api/admin/users": [409, { error: "email_taken", message: "A user with that email already exists." }] });
  renderDialog();
  const dialog = screen.getByRole("dialog", { name: "Add user" });
  await userEvent.type(within(dialog).getByLabelText(/Name/), "Anna");
  await userEvent.type(within(dialog).getByLabelText(/Email/), "anna@example.com");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add user" }));
  expect(await within(dialog).findByText("Someone already uses that email. Use a different one.")).toBeInTheDocument();
  expect(within(dialog).getByLabelText(/Email/)).toHaveAttribute("aria-invalid", "true");
});

it("validates before sending", async () => {
  const calls = mockFetch({});
  renderDialog();
  const dialog = screen.getByRole("dialog", { name: "Add user" });
  await userEvent.type(within(dialog).getByLabelText(/Email/), "not-an-email");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add user" }));
  expect(within(dialog).getByText("Enter their name.")).toBeInTheDocument();
  expect(within(dialog).getByText("Enter a valid email, like name@example.com.")).toBeInTheDocument();
  expect(calls).toHaveLength(0);
});
