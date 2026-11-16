import { AuthScreen, Button, LoadingState, minLengthRule } from "@qarasky/kore-ui";
import { useState } from "react";
import { useParams } from "wouter";
import { api } from "../lib/api";
import { PASSWORD_MIN, SETUP_GONE, errorCode, errorMessage } from "../lib/strings";
import { useResource } from "../lib/useResource";

export function SetupScreen() {
  const { token = "" } = useParams<{ token: string }>();
  const info = useResource(() => api.setupInfo(token), [token]);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  if (info.loading && !info.data) return <LoadingState className="min-h-dvh" />;

  if (gone || info.error) {
    const code = errorCode(info.error);
    return (
      <AuthScreen
        title={gone || code === "not_found" ? "This link doesn't work" : "Couldn't open this link"}
        description={gone || code === "not_found" ? SETUP_GONE : errorMessage(info.error)}
      >
        <Button asChild variant="secondary" fullWidth>
          <a href="/login">Go to sign in</a>
        </Button>
      </AuthScreen>
    );
  }

  const { email, name } = info.data!;

  async function onSubmit({ password }: { email: string; password: string }) {
    if (password.length < PASSWORD_MIN) {
      setError(`Use at least ${PASSWORD_MIN} characters.`);
      throw new Error("short_password");
    }
    setError(null);
    try {
      const { redirect } = await api.setup(token, password);
      window.location.assign(redirect);
    } catch (err) {
      if (errorCode(err) === "not_found") setGone(true);
      else setError(errorMessage(err));
      throw err;
    }
  }

  return (
    <AuthScreen
      mode="set-password"
      description={`Welcome, ${name}. Choose a password for your Kore ID. You'll use it to sign in to every Kore app.`}
      error={error}
      password={{
        onSubmit,
        defaultEmail: email,
        emailReadOnly: true,
        rules: [minLengthRule(PASSWORD_MIN)],
        labels: { submit: "Set password and sign in", pending: "Setting password…" },
      }}
    />
  );
}
