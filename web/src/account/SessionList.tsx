// A list of Kore ID sessions (devices). Used by /account and the admin user detail.
import { Badge, Button, CardList, ListRow } from "@qarasky/kore-ui";
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
    <CardList aria-label="Sessions">
      {sessions.map((s) => {
        const device = describeDevice(s.userAgent);
        const meta = [s.ip, s.lastSeenAt ? `Last active ${formatTimeInline(s.lastSeenAt)}` : null]
          .filter(Boolean)
          .join(" · ");
        return (
          <ListRow
            key={s.id}
            icon={isMobileUa(s.userAgent) ? <Smartphone /> : <Monitor />}
            label={
              <span className="flex items-center gap-2">
                <span className="truncate" title={s.userAgent ?? undefined}>
                  {device}
                </span>
                {s.current ? <Badge tone="accent">This device</Badge> : null}
              </span>
            }
            description={
              <>
                <span className="block truncate" title={`Signed in ${fullTime(s.createdAt)}`}>
                  {meta}
                </span>
                <span className="block truncate">
                  {s.apps.length ? `Used for ${s.apps.map((a) => a.name).join(", ")}` : "Kore ID only"}
                </span>
              </>
            }
            actions={
              onSignOut && !s.current ? (
                <Button size="sm" onClick={() => onSignOut(s)}>
                  Sign out
                </Button>
              ) : null
            }
          />
        );
      })}
    </CardList>
  );
}
