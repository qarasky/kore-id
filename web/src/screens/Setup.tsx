import { AuthScreen, Avatar, Button, Field, Input } from "@qarasky/kore-ui";
import { useState, type FormEvent } from "react";
import { useParams } from "wouter";
import { api } from "../lib/api";
import { Loading } from "../lib/Shell";
import { PASSWORD_MIN, SETUP_GONE, errorCode, errorMessage } from "../lib/strings";
import { useResource } from "../lib/useResource";

export function SetupScreen() {
  const { token = "" } = useParams<{ token: string }>();
  const info = useResource(() => api.setupInfo(token), [token]);
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; form?: string }>({});
  const [pending, setPending] = useState(false);
  const [gone, setGone] = useState(false);

  if (info.loading && !info.data) return <Loading />;

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

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const data = new FormData(e.currentTarget);
    const password = String(data.get("password") ?? "");
    const confirm = String(data.get("confirm") ?? "");
    const next: typeof errors = {};
    if (password.length < PASSWORD_MIN) next.password = `Use at least ${PASSWORD_MIN} characters.`;
    else if (confirm !== password) next.confirm = "The passwords don't match.";
    setErrors(next);
    if (next.password || next.confirm) return;
    setPending(true);
    try {
      const { redirect } = await api.setup(token, password);
      window.location.assign(redirect);
    } catch (err) {
      setPending(false);
      const code = errorCode(err);
      if (code === "not_found") setGone(true);
      else if (code === "invalid_password") setErrors({ password: errorMessage(err) });
      else setErrors({ form: errorMessage(err) });
    }
  }

  return (
    <AuthScreen title="Set your password" description="Choose a password for your Kore ID. You'll use it to sign in to every Kore app." error={errors.form}>
      <div className="flex items-center gap-3 rounded-ui border border-border px-3 py-2.5">
        <Avatar name={name} email={email} />
        <div className="min-w-0">
          <p className="truncate font-medium">{name}</p>
          <p className="truncate text-meta text-muted">{email}</p>
        </div>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {/* Lets password managers save the right account. */}
        <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        <Field label="New password" hint={`At least ${PASSWORD_MIN} characters.`} error={errors.password}>
          <Input name="password" type="password" autoComplete="new-password" autoFocus />
        </Field>
        <Field label="Confirm password" error={errors.confirm}>
          <Input name="confirm" type="password" autoComplete="new-password" />
        </Field>
        <Button type="submit" variant="primary" fullWidth loading={pending}>
          {pending ? "Setting password…" : "Set password and sign in"}
        </Button>
      </form>
    </AuthScreen>
  );
}
