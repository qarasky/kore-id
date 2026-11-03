// A list of Kore ID sessions (devices). Used by /account and the admin user detail.
import { Badge, Button } from "@qarasky/kore-ui";
import { Monitor, Smartphone } from "lucide-react";
import { describeDevice, formatTimeInline, fullTime, isMobileUa } from "../lib/format";
import type { Session } from "../lib/types";

export function SessionList({
  sessions,
  onSignOut,
  empty = "No active sessions.",
}: {
  sessions: Session[];
  /** Per-row "Sign out" (not shown for the current session). */
  onSignOut?: (s: Session) => void;
  empty?: string;
}) {
  if (!sessions.length) return <p className="text-muted">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-border" aria-label="Sessions">
      {sessions.map((s) => {
        const device = describeDevice(s.userAgent);
        const meta = [s.ip, s.lastSeenAt ? `Last active ${formatTimeInline(s.lastSeenAt)}` : null]
          .filter(Boolean)
          .join(" · ");
        return (
          <li key={s.id} className="flex min-h-row items-center gap-3 py-2">
            <span className="text-muted [&_svg]:size-5" aria-hidden>
              {isMobileUa(s.userAgent) ? <Smartphone /> : <Monitor />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2">
                <span className="truncate" title={s.userAgent ?? undefined}>
                  {device}
                </span>
                {s.current ? <Badge tone="accent">This device</Badge> : null}
              </p>
              <p className="truncate text-meta text-muted" title={`Signed in ${fullTime(s.createdAt)}`}>
                {meta}
              </p>
              <p className="truncate text-meta text-muted">
                {s.apps.length ? `Used for ${s.apps.map((a) => a.name).join(", ")}` : "Kore ID only"}
              </p>
            </div>
            {onSignOut && !s.current ? (
              <Button size="sm" onClick={() => onSignOut(s)}>
                Sign out
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
