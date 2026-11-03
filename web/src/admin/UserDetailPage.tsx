import {
  Avatar,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  EmptyState,
  Field,
  Input,
  NavTabs,
  PageBody,
  PageHeader,
  Select,
  SettingsSection,
  Switch,
  useToast,
} from "@qarasky/kore-ui";
import { UserX } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { SessionList } from "../account/SessionList";
import { api } from "../lib/api";
import { formatTimeInline } from "../lib/format";
import { useSession } from "../lib/session";
import { Loading, Shell } from "../lib/Shell";
import { errorCode, errorMessage } from "../lib/strings";
import type { AdminApp, Role, Session, User } from "../lib/types";
import { useResource } from "../lib/useResource";
import { RoleBadge, SetupLink, UserStatus } from "./parts";

export type UserTab = "profile" | "apps" | "security";

export function UserDetailPage({ id, tab }: { id: string; tab: UserTab }) {
  return (
    <Shell section="users" admin>
      <UserDetail id={id} tab={tab} />
    </Shell>
  );
}

function UserDetail({ id, tab }: { id: string; tab: UserTab }) {
  const detail = useResource(() => api.user(id), [id]);
  const apps = useResource(() => api.apps(), []);
  const crumbs = [
    { label: "Admin", href: "/admin" },
    { label: "Users", href: "/admin/users" },
  ];

  if (detail.error) {
    return (
      <>
        <PageHeader title="User not found" breadcrumbs={crumbs} />
        <PageBody>
          <EmptyState
            icon={<UserX />}
            title={errorCode(detail.error) === "not_found" ? "This user doesn't exist" : "Couldn't load this user"}
            description={errorCode(detail.error) === "not_found" ? "They may have been deleted." : errorMessage(detail.error)}
            action={
              <Button asChild>
                <a href="/admin/users">Back to users</a>
              </Button>
            }
          />
        </PageBody>
      </>
    );
  }
  if (!detail.data) return <Loading />;

  const { user, sessions } = detail.data;
  const setUser = (u: User) => detail.set({ user: u, sessions: detail.data!.sessions });
  const base = `/admin/users/${user.id}`;

  return (
    <>
      <PageHeader title={user.name} breadcrumbs={crumbs} />
      <PageBody width="reading">
        <div className="mb-5 flex items-center gap-4">
          <Avatar name={user.name} email={user.email} size="lg" />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2">
              <span className="truncate text-title font-semibold tracking-[-0.01em]">{user.name}</span>
              <RoleBadge role={user.role} />
            </p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted">
              <span className="truncate">{user.email}</span>
              <UserStatus user={user} />
              <span>Last sign-in {formatTimeInline(user.lastLoginAt)}</span>
            </p>
          </div>
        </div>
        <NavTabs
          label="User sections"
          variant="underline"
          className="mb-6"
          items={[
            { href: base, label: "Profile", active: tab === "profile" },
            { href: `${base}/apps`, label: "Apps", active: tab === "apps" },
            { href: `${base}/security`, label: "Security", active: tab === "security" },
          ]}
        />
        {tab === "profile" ? <ProfileTab user={user} onSaved={setUser} /> : null}
        {tab === "apps" ? <AppsTab user={user} apps={apps.data?.apps} onSaved={setUser} /> : null}
        {tab === "security" ? <SecurityTab user={user} sessions={sessions} reload={detail.reload} onSaved={setUser} /> : null}
      </PageBody>
    </>
  );
}

function ProfileTab({ user, onSaved }: { user: User; onSaved: (u: User) => void }) {
  const toast = useToast();
  const session = useSession();
  const [role, setRole] = useState<Role>(user.role);
  const [errors, setErrors] = useState<{ name?: string; email?: string; role?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const name = String(d.get("name") ?? "").trim();
    const email = String(d.get("email") ?? "").trim();
    const errs: typeof errors = {};
    if (!name) errs.name = "Enter their name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = "Enter a valid email, like name@example.com.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      const r = await api.updateUser(user.id, { name, email, role });
      onSaved(r.user);
      toast.show({ message: "Changes saved", tone: "success" });
      if (r.user.id === session.user?.id) await session.refresh();
    } catch (err) {
      const code = errorCode(err);
      const msg = errorMessage(err);
      if (code === "email_taken" || code === "invalid_email") setErrors({ email: msg });
      else if (code === "invalid_name") setErrors({ name: msg });
      else if (code === "last_admin" || code === "invalid_role")
        setErrors({ role: code === "last_admin" ? "This is the last active admin, so they have to stay an admin. Make someone else an admin first." : msg });
      else setErrors({ form: msg });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="flex max-w-form flex-col gap-4" onSubmit={onSubmit} noValidate>
      <Field label="Name" error={errors.name}>
        <Input name="name" defaultValue={user.name} autoComplete="off" maxLength={100} />
      </Field>
      <Field label="Email" hint="Their sign-in name. Apps match accounts by it." error={errors.email}>
        <Input name="email" type="email" defaultValue={user.email} autoComplete="off" />
      </Field>
      <Field label="Role" hint="Admins manage users and can use every app." error={errors.role}>
        <Select<Role>
          value={role}
          onValueChange={setRole}
          options={[
            { value: "user", label: "User" },
            { value: "admin", label: "Admin" },
          ]}
        />
      </Field>
      {errors.form ? (
        <p role="alert" className="text-meta text-danger">
          {errors.form}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" loading={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function AppsTab({ user, apps, onSaved }: { user: User; apps: AdminApp[] | undefined; onSaved: (u: User) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const admin = user.role === "admin";
  if (!apps) return <Loading />;

  async function toggle(app: AdminApp, on: boolean) {
    setBusy(app.app);
    const next = on ? [...new Set([...user.apps, app.app])] : user.apps.filter((a) => a !== app.app);
    try {
      const r = await api.updateUser(user.id, { apps: next });
      onSaved(r.user);
      toast.show({ message: on ? `${user.name} can now use ${app.name}` : `${user.name} can no longer use ${app.name}` });
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsSection
      title="App access"
      description={admin ? "Admins can use every app." : "Turn an app on to let them sign in to it. Changes apply right away."}
      className="max-w-form"
    >
      {apps.length === 0 ? <p className="text-muted">No apps are registered. Add them to clients.json on the server.</p> : null}
      {apps.map((a) => (
        <Switch
          key={a.app}
          labelFirst
          label={a.name}
          description={a.clients.length > 1 ? `${a.clients.length} clients: ${a.clients.map((c) => c.id).join(", ")}` : a.app}
          checked={admin || user.apps.includes(a.app)}
          disabled={admin || busy !== null}
          onCheckedChange={(on) => void toggle(a, on)}
        />
      ))}
    </SettingsSection>
  );
}

type Pending = "signout" | "reset" | "disable" | "delete" | null;

function SecurityTab({
  user,
  sessions,
  reload,
  onSaved,
}: {
  user: User;
  sessions: Session[];
  reload: () => Promise<void>;
  onSaved: (u: User) => void;
}) {
  const toast = useToast();
  const session = useSession();
  const [, navigate] = useLocation();
  const [confirm, setConfirm] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const isMe = user.id === session.user?.id;

  const open = (p: Pending) => {
    setError(null);
    setConfirm(p);
  };
  /** Run an action from a ConfirmDialog: show the error inside it and keep it open on failure. */
  const run = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (err) {
      setError(errorCode(err) === "last_admin" ? lastAdminText(confirm) : errorMessage(err));
      throw err;
    }
  };

  async function enable() {
    setEnabling(true);
    try {
      const r = await api.updateUser(user.id, { disabled: false });
      onSaved(r.user);
      toast.show({ message: `Enabled ${user.name}`, tone: "success" });
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: "error" });
    } finally {
      setEnabling(false);
    }
  }

  const errorText = error ? (
    <p role="alert" className="text-meta text-danger">
      {error}
    </p>
  ) : null;

  return (
    <div className="max-w-form">
      <SettingsSection
        title="Active sessions"
        description="Devices where they're signed in to Kore ID, and the apps used there."
        actions={
          <Button size="sm" variant="danger-outline" onClick={() => open("signout")} disabled={!sessions.length}>
            Sign out everywhere
          </Button>
        }
      >
        <SessionList sessions={sessions} empty="Not signed in anywhere." />
      </SettingsSection>

      <SettingsSection
        title="Password"
        description={
          user.hasPassword
            ? "Resetting clears their password, signs them out everywhere and gives you a new setup link."
            : "They haven't set a password yet. Reset to get a new setup link; the old one stops working."
        }
        actions={
          <Button size="sm" onClick={() => open("reset")}>
            Reset password
          </Button>
        }
      />

      <SettingsSection
        title={user.disabled ? "Account disabled" : "Disable account"}
        description={
          user.disabled
            ? "They can't sign in to Kore ID or any app until you enable the account."
            : "They're signed out everywhere and can't sign in until you enable the account again."
        }
        actions={
          user.disabled ? (
            <Button size="sm" onClick={() => void enable()} loading={enabling}>
              {enabling ? "Enabling…" : "Enable"}
            </Button>
          ) : (
            <Button size="sm" variant="danger-outline" onClick={() => open("disable")}>
              Disable
            </Button>
          )
        }
      />

      <SettingsSection
        title="Delete user"
        description="Removes the account and its app access for good. Apps keep what they stored for them."
        actions={
          <Button size="sm" variant="danger-outline" onClick={() => open("delete")}>
            Delete user
          </Button>
        }
      />

      <ConfirmDialog
        open={confirm === "signout"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Sign ${user.name} out everywhere?`}
        description={isMe ? "Every device is signed out, including this one." : "Every device and app they're signed in to is signed out. They can sign in again."}
        confirmLabel="Sign out everywhere"
        danger
        onConfirm={run(async () => {
          await api.signOutUser(user.id);
          if (isMe) return window.location.assign("/login?signed_out=1");
          toast.show({ message: `Signed ${user.name} out everywhere` });
          await reload();
        })}
      >
        {errorText}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "reset"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Reset ${user.name}'s password?`}
        description="Their current password stops working and they're signed out everywhere. You get a new setup link to send them."
        confirmLabel="Reset password"
        danger
        onConfirm={run(async () => {
          const r = await api.resetUser(user.id);
          if (isMe) return window.location.assign("/login?signed_out=1");
          setLink(r.setupUrl);
          await reload();
        })}
      >
        {errorText}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "disable"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Disable ${user.name}?`}
        description="They're signed out everywhere and can't sign in to Kore ID or any app until you enable the account."
        confirmLabel="Disable"
        danger
        onConfirm={run(async () => {
          const r = await api.updateUser(user.id, { disabled: true });
          onSaved(r.user);
          toast.show({ message: `Disabled ${user.name}` });
          await reload();
        })}
      >
        {errorText}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete ${user.name}?`}
        description={`${user.email} can't sign in any more and their app access is removed. This can't be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={run(async () => {
          await api.deleteUser(user.id);
          if (isMe) return window.location.assign("/login");
          toast.show({ message: `Deleted ${user.name}` });
          navigate("/admin/users");
        })}
      >
        {errorText}
      </ConfirmDialog>

      <Dialog open={link !== null} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent title="New setup link" description="Copy it now. It isn't shown again.">
          <DialogBody>{link ? <SetupLink url={link} name={user.name} /> : null}</DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="primary">Done</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function lastAdminText(action: Pending) {
  const verb = action === "delete" ? "deleted" : action === "disable" ? "disabled" : "changed";
  return `This is the last active admin, so they can't be ${verb}. Make someone else an admin first.`;
}
