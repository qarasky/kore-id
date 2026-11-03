// UI copy that is shared or mapped from API codes. Voice: kore-ui DESIGN.md §5.
import { ApiError } from "./api";

/** API error code → a plain sentence that says what to do next. */
export const ERRORS: Record<string, string> = {
  network: "Couldn't reach Kore ID. Check your connection and try again.",
  server_error: "Something went wrong on the server. Try again in a moment.",
  csrf_failed: "Your page is out of date. Reload it and try again.",
  unauthorized: "You're signed out. Sign in again.",
  forbidden: "You need admin access for this.",
  not_found: "That doesn't exist any more. Reload the page.",
  invalid_credentials: "That email and password don't match. Try again, or ask your admin for a reset link.",
  rate_limited: "Too many attempts. Wait 15 minutes and try again.",
  invalid_email: "Enter a valid email, like name@example.com.",
  invalid_name: "Enter a name (up to 100 characters).",
  invalid_password: "Use at least 10 characters.",
  invalid_current_password: "Your current password is wrong. Try again.",
  invalid_role: "Choose Admin or User.",
  invalid_apps: "One of those apps no longer exists. Reload the page and try again.",
  invalid_disabled: "Couldn't change the status. Reload the page and try again.",
  email_taken: "Someone already uses that email. Use a different one.",
  last_admin: "This is the last active admin. Make someone else an admin first.",
};

/** The sentence to show for any thrown error. `overrides` lets a screen say it better in context. */
export function errorMessage(err: unknown, overrides: Partial<Record<string, string>> = {}): string {
  if (err instanceof ApiError) return overrides[err.code] ?? ERRORS[err.code] ?? err.message ?? ERRORS.server_error!;
  return ERRORS.server_error!;
}

export const errorCode = (err: unknown) => (err instanceof ApiError ? err.code : "unknown");

/** Setup links: invalid, used or expired. */
export const SETUP_GONE = "This setup link doesn't work any more. It may have been used or expired. Ask your admin for a new link.";

export const PASSWORD_MIN = 10;

/** Audit actions in words (past tense). */
export const ACTIONS: Record<string, string> = {
  login: "Signed in",
  login_failed: "Failed sign-in",
  logout: "Signed out",
  setup_completed: "Set password",
  profile_updated: "Updated profile",
  password_changed: "Changed password",
  session_revoked: "Ended a session",
  signed_out_everywhere: "Signed out everywhere",
  user_created: "Added user",
  user_updated: "Updated user",
  user_disabled: "Disabled user",
  user_enabled: "Enabled user",
  user_deleted: "Deleted user",
  password_reset: "Reset password",
  user_signed_out: "Signed user out everywhere",
  app_access_denied: "Denied app access",
  admin_bootstrapped: "Created first admin",
};
export const actionLabel = (a: string) => ACTIONS[a] ?? a.replace(/_/g, " ");
