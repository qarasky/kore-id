import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { ERRORS, errorMessage } from "./strings";

describe("errorMessage", () => {
  it("maps every API error code to a plain sentence", () => {
    const codes = [
      "csrf_failed", "unauthorized", "forbidden", "not_found", "invalid_credentials", "rate_limited", "invalid_email",
      "invalid_name", "invalid_password", "invalid_current_password", "invalid_role", "invalid_apps", "invalid_disabled",
      "email_taken", "last_admin",
    ];
    for (const code of codes) {
      const msg = errorMessage(new ApiError(400, code, "server text"));
      expect(msg, code).toBe(ERRORS[code]);
      expect(msg, code).toMatch(/^[A-Z].*\.$/);
      expect(msg, code).not.toMatch(/oops|please|!/i);
    }
  });

  it("uses the wording the sign-in screen needs", () => {
    expect(errorMessage(new ApiError(401, "invalid_credentials", "Invalid email or password."))).toBe(
      "That email and password don't match. Try again, or ask your admin for a reset link.",
    );
    expect(errorMessage(new ApiError(0, "network", ""))).toMatch(/Couldn't reach Kore ID/);
  });

  it("falls back to the server's message for unknown codes, and to a generic one for non-API errors", () => {
    expect(errorMessage(new ApiError(400, "something_new", "Something new happened."))).toBe("Something new happened.");
    expect(errorMessage(new Error("boom"))).toBe(ERRORS.server_error);
  });

  it("lets a screen override a code", () => {
    expect(errorMessage(new ApiError(409, "last_admin", ""), { last_admin: "Keep one admin." })).toBe("Keep one admin.");
  });
});
