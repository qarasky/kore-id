// Small admin pieces composed from kore-ui parts.
import { AppMark, Badge, Card, CopyButton, Input, StatusDot } from "@qarasky/kore-ui";
import type { ReactNode } from "react";
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

/** A setup link shown once: read-only input + CopyButton, and what to do with it. */
export function SetupLink({ url, name }: { url: string; name: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input readOnly value={url} aria-label="Setup link" className="font-mono text-meta" onFocus={(e) => e.currentTarget.select()} />
        <CopyButton value={url} />
      </div>
      <p className="text-meta text-muted">Send this link to {name}. It works once and expires in 24 hours.</p>
    </div>
  );
}

/** A number with a label (kore-ui has no stat tile; a Card holds it). */
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-meta text-muted">{label}</p>
      <p className="mt-1 text-display font-semibold tabular-nums tracking-[-0.01em]">{value}</p>
      {hint ? <p className="text-meta text-muted">{hint}</p> : null}
    </Card>
  );
}
