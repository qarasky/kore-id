import {
  AppGrid,
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  SettingsLayout,
  SettingsSection,
  Skeleton,
  useToast,
} from "@qarasky/kore-ui";
import { AppWindow, KeyRound, UserRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { appProps, isAppId } from "../lib/apps";
import { describeDevice } from "../lib/format";
import { useSession } from "../lib/session";
import { Shell } from "../lib/Shell";
import { PASSWORD_MIN, errorCode, errorMessage } from "../lib/strings";
import { useResource } from "../lib/useResource";
import { SessionList } from "./SessionList";

export type AccountSection = "profile" | "security" | "apps";

const SECTIONS = [
  { id: "profile", label: "Profile", icon: <UserRound />, href: "/account" },
  { id: "security", label: "Security", icon: <KeyRound />, href: "/account/security" },
  { id: "apps", label: "Your apps", icon: <AppWindow />, href: "/account/apps" },
];

export function AccountPage({ section }: { section: AccountSection }) {
  return (
    <Shell section="account">
      <PageHeader title="Your account" />
      <SettingsLayout current={section} items={SECTIONS} navLabel="Account sections">
        {section === "profile" ? <Profile /> : null}
        {section === "security" ? (
          <>
            <Password />
            <Sessions />
          </>
        ) : null}
        {section === "apps" ? <YourApps /> : null}
      </SettingsLayout>
    </Shell>
  );
}

function Profile() {
  const { user, setUser } = useSession();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!user) return null;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    if (!name) return setError("Enter your name.");
    setError(null);
    setSaving(true);
    try {
      const r = await api.updateMe(name);
      setUser(r.user);
      toast.show({ message: "Profile saved", tone: "success" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="Profile" description="How you appear in every Kore app.">
      <div className="flex items-center gap-4">
        <Avatar name={user.name} email={user.email} size="lg" />
        <div className="min-w-0">
          <p className="truncate font-medium">{user.name}</p>
          <p className="flex items-center gap-2 text-meta text-muted">
            <span className="truncate">{user.email}</span>
            <Badge tone="outline">{user.role === "admin" ? "Admin" : "User"}</Badge>
          </p>
        </div>
      </div>
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <Field label="Name" error={error}>
          <Input name="name" defaultValue={user.name} autoComplete="name" maxLength={100} />
        </Field>
        <Field label="Email" hint="Ask an admin to change it.">
          <Input value={user.email} readOnly disabled />
        </Field>
        <div>
          <Button type="submit" variant="primary" loading={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function Password() {
  const toast = useToast();
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    const current = String(d.get("current") ?? "");
    const next = String(d.get("next") ?? "");
    const confirm = String(d.get("confirm") ?? "");
    const errs: typeof errors = {};
    if (!current) errs.current = "Enter your current password.";
    if (next.length < PASSWORD_MIN) errs.next = `Use at least ${PASSWORD_MIN} characters.`;
    else if (confirm !== next) errs.confirm = "The passwords don't match.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      await api.changePassword(current, next);
      form.reset();
      toast.show({ message: "Password changed. Your other devices were signed out.", tone: "success" });
      window.dispatchEvent(new Event("kore:sessions-changed"));
    } catch (err) {
      const code = errorCode(err);
      if (code === "invalid_current_password" || code === "rate_limited") setErrors({ current: errorMessage(err) });
      else setErrors({ next: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="Password" description={`At least ${PASSWORD_MIN} characters. Changing it signs out your other devices.`}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <Field label="Current password" error={errors.current}>
          <Input name="current" type="password" autoComplete="current-password" />
        </Field>
        <Field label="New password" error={errors.next}>
          <Input name="next" type="password" autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password" error={errors.confirm}>
          <Input name="confirm" type="password" autoComplete="new-password" />
        </Field>
        <div>
          <Button type="submit" variant="primary" loading={saving}>
            {saving ? "Changing…" : "Change password"}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function Sessions() {
  const toast = useToast();
  const sessions = useResource(() => api.mySessions(), []);
  const [confirmAll, setConfirmAll] = useState(false);
  useEventReload("kore:sessions-changed", sessions.reload);

  return (
    <SettingsSection
      title="Active sessions"
      description="Where you're signed in to Kore ID, and the apps you used there."
      actions={
        <Button size="sm" variant="danger-outline" onClick={() => setConfirmAll(true)}>
          Sign out everywhere
        </Button>
      }
    >
      {sessions.data ? (
        <SessionList
          sessions={sessions.data.sessions}
          onSignOut={async (s) => {
            try {
              await api.revokeSession(s.id);
              toast.show({ message: `Signed out “${describeDevice(s.userAgent)}”` });
              await sessions.reload();
            } catch (err) {
              toast.show({ message: errorMessage(err), tone: "error" });
            }
          }}
        />
      ) : sessions.error ? (
        <p className="text-meta text-danger">{errorMessage(sessions.error)}</p>
      ) : (
        <Skeleton className="h-row w-full" />
      )}
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Sign out everywhere?"
        description="Every device is signed out of Kore ID and the apps you opened with it, including this one."
        confirmLabel="Sign out everywhere"
        danger
        onConfirm={async () => {
          try {
            await api.revokeAllSessions();
          } catch (err) {
            toast.show({ message: errorMessage(err), tone: "error" });
            throw err;
          }
          window.location.assign("/login?signed_out=1");
        }}
      />
    </SettingsSection>
  );
}

function YourApps() {
  const apps = useResource(() => api.myApps(), []);
  if (!apps.data) return <Skeleton className="h-24 w-full" />;
  const { urls, names } = appProps(apps.data.apps);
  const elsewhere = apps.data.apps.filter((a) => !isAppId(a.app) || !a.homeUrl);
  return (
    <SettingsSection title="Your apps" description="The Kore apps your account can open.">
      {apps.data.apps.length === 0 ? (
        <EmptyState
          icon={<AppWindow />}
          title="No apps yet"
          description="Your account can't open any app yet. Ask an admin to give you access."
        />
      ) : (
        <>
          {Object.keys(urls).length ? <AppGrid urls={urls} names={names} label="Your apps" className="grid-cols-2 sm:grid-cols-4" /> : null}
          {elsewhere.length ? (
            <p className="text-meta text-muted">
              You can also use {elsewhere.map((a) => a.name).join(", ")}. {elsewhere.length === 1 ? "It has" : "They have"} no web
              address set.
            </p>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

/** Reload when another section says the sessions changed (a password change signs out other devices). */
function useEventReload(name: string, reload: () => Promise<void>) {
  useEffect(() => {
    const fn = () => void reload();
    window.addEventListener(name, fn);
    return () => window.removeEventListener(name, fn);
  }, [name, reload]);
}
