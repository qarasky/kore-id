// Rendered at /authorize when the server answers 403: the signed-in user may not use this app.
import { AuthScreen, Button } from "@qarasky/kore-ui";
import { useSearch } from "wouter";
import { api } from "../lib/api";
import { switchAccountUrl } from "../lib/returnTo";
import { Loading } from "../lib/Shell";
import { useResource } from "../lib/useResource";

export function NoAccessScreen() {
  const search = useSearch();
  const clientId = new URLSearchParams(search).get("client_id") ?? undefined;
  const s = useResource(() => api.session(clientId), [clientId]);
  if (s.loading && !s.data) return <Loading />;
  const app = s.data?.app?.name ?? "this app";
  const email = s.data?.user?.email;
  return (
    <AuthScreen
      title={`You don't have access to ${app}`}
      description={`${email ? `You're signed in as ${email}. ` : ""}Ask an admin to give you access, or use another account.`}
    >
      <div className="flex flex-col gap-2">
        <Button asChild variant="primary" fullWidth>
          <a href={switchAccountUrl(search)}>Sign in as someone else</a>
        </Button>
        <Button asChild variant="ghost" fullWidth>
          <a href="/account">Go to your account</a>
        </Button>
      </div>
    </AuthScreen>
  );
}
