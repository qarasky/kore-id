// Rendered at GET /logout when an app asked to sign out without a valid id_token_hint. The form posts to the
// server's POST /logout (CSRF checked there, post_logout_redirect_uri validated there).
import { AuthScreen, Button } from "@qarasky/kore-ui";
import { useSearch } from "wouter";
import { api } from "../lib/api";
import { Loading } from "../lib/Shell";
import { useResource } from "../lib/useResource";

export function LogoutConfirmScreen() {
  const q = new URLSearchParams(useSearch());
  const s = useResource(() => api.session(q.get("client_id") ?? undefined), []);
  if (!s.data) return <Loading />;
  const hidden = (["post_logout_redirect_uri", "client_id", "state"] as const)
    .map((k) => [k, q.get(k)] as const)
    .filter(([, v]) => v);
  return (
    <AuthScreen
      title="Sign out of Kore ID?"
      description={`${s.data.user ? `You're signed in as ${s.data.user.email}. ` : ""}You'll be signed out of every Kore app in this browser.`}
    >
      <form method="post" action="/logout" className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <input type="hidden" name="csrf" value={s.data.csrf} />
        {hidden.map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v!} />
        ))}
        <Button asChild variant="secondary">
          <a href="/account">Cancel</a>
        </Button>
        <Button type="submit" variant="primary">
          Sign out
        </Button>
      </form>
    </AuthScreen>
  );
}
