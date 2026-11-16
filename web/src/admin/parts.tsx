// Small admin pieces composed from kore-ui parts.
import { AppMark, Badge, CopyField, StatusDot } from "@qarasky/kore-ui";
import { isAppId } from "../lib/apps";
import type { User } from "../lib/types";

/** "Active" / "Disabled" / "Setup pending" in words with a dot. */
export function UserStatus({ user }: { user: User }) {
  if (user.disabled) return <StatusDot status="off" label="Disabled" />;
  if (!user.hasPassword) return <StatusDot status="warn" label="Setup pending" tintLabel={false} />;
  return <StatusDot status="up" label="Active" tintLabel={false} />;
}

export function RoleBadge({ role }: { role: User["role"] }) {
  return <Badge tone={role === "admin" ? "accent" : "outline"}>{role === "admin" ? "Admin" : "User"}</Badge>;
}

/** The apps a user can open, as marks (names for screen readers and keys kore-ui has no mark for). */
export function AppList({ user, names }: { user: User; names: Record<string, string> }) {
  if (user.role === "admin") return <span className="text-muted">Every app</span>;
  if (!user.apps.length) return <span className="text-muted">No apps</span>;
  return (
    <span className="flex flex-wrap items-center gap-2" aria-label={user.apps.map((a) => names[a] ?? a).join(", ")}>
      {user.apps.map((a) =>
        isAppId(a) ? (
          <span key={a} title={names[a] ?? a} className="flex" aria-hidden>
            <AppMark app={a} size={16} />
          </span>
        ) : (
          <Badge key={a} aria-hidden>
            {names[a] ?? a}
          </Badge>
        ),
      )}
    </span>
  );
}

/** A setup link shown once: a CopyField, and what to do with it. */
export function SetupLink({ url, name }: { url: string; name: string }) {
  return (
    <div className="flex flex-col gap-2">
      <CopyField value={url} mono aria-label="Setup link" />
      <p className="text-meta text-muted">Send this link to {name}. It works once and expires in 24 hours.</p>
    </div>
  );
}
