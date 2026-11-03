import { AuthScreen } from "@qarasky/kore-ui";
import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { api } from "../lib/api";
import { clientIdOf, safeReturnTo } from "../lib/returnTo";
import { errorCode, errorMessage } from "../lib/strings";
import type { SessionInfo } from "../lib/types";
import { Loading } from "../lib/Shell";

export function LoginScreen() {
  const search = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const returnTo = safeReturnTo(search.get("return_to"));
  const forceLogin = search.get("prompt") === "login";
  const signedOut = search.has("signed_out");
  const clientId = clientIdOf(returnTo);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .session(clientId)
      .then((s) => {
        if (!live) return;
        // Already signed in and not asked to sign in again: carry on.
        if (s.user && !forceLogin) {
          if (returnTo) window.location.assign(returnTo);
          else navigate("/account", { replace: true });
          return;
        }
        setSession(s);
      })
      .catch((e) => {
        if (!live) return;
        setSession({ user: null, csrf: "" });
        setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [clientId, forceLogin, returnTo, navigate]);

  if (!session) return <Loading />;

  const appName = session.app?.name;
  const switching = forceLogin && !!session.user;
  const notice = switching
    ? `You're signed in as ${session.user!.email}.${appName ? ` Sign in with another account to use ${appName}.` : ""}`
    : appName
      ? `Sign in to continue to ${appName}.`
      : returnTo
        ? "Sign in to continue to the app."
        : signedOut
          ? "You're signed out of Kore ID."
          : undefined;

  return (
    <AuthScreen
      app="kore-id"
      title={switching ? "Sign in as someone else" : "Sign in"}
      description="Use the account your admin created for you."
      notice={notice}
      error={error}
      password={{
        invalid,
        hint: "Forgot it? Ask your admin for a reset link.",
        onSubmit: async ({ email, password }) => {
          setError(null);
          setInvalid(false);
          try {
            const { redirect } = await api.login({ email, password, ...(returnTo && { returnTo }) });
            window.location.assign(redirect);
            // Keep "Signing in…" while the browser navigates.
            await new Promise(() => {});
          } catch (e) {
            setInvalid(errorCode(e) === "invalid_credentials");
            setError(errorMessage(e));
            throw e;
          }
        },
      }}
    />
  );
}
