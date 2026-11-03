import {
  Button,
  PageBody,
  PageHeader,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "@qarasky/kore-ui";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { api } from "../lib/api";
import { describeDevice, formatTime, fullTime } from "../lib/format";
import { Shell } from "../lib/Shell";
import { ACTIONS, actionLabel, errorMessage } from "../lib/strings";
import type { AuditEntry } from "../lib/types";
import { useResource } from "../lib/useResource";

const PAGE = 50;

/** Short detail text for an entry ("KoreMind", "role → admin"). */
function detailText(e: AuditEntry): string | null {
  const d = e.detail;
  if (!d) return null;
  if (typeof d.client === "string") return d.client;
  if (d.reason === "disabled") return "account disabled";
  const parts: string[] = [];
  if (typeof d.role === "string") parts.push(`role ${d.role}`);
  if (Array.isArray(d.apps)) parts.push(d.apps.length ? `apps ${d.apps.join(", ")}` : "no apps");
  if (typeof d.name === "string") parts.push(`name “${d.name}”`);
  const email = d.email as { to?: string } | undefined;
  if (email?.to) parts.push(`email ${email.to}`);
  if (d.current === true) parts.push("this device");
  return parts.join(" · ") || null;
}

const userLink = (id: string | null | undefined, label: string) =>
  id ? (
    <Link href={`/admin/users/${id}`} className="rounded-[4px] hover:underline">
      {label}
    </Link>
  ) : (
    label
  );

export function ActivityRows({ entries }: { entries: AuditEntry[] }) {
  return (
    <>
      {entries.map((e) => {
        const detail = detailText(e);
        return (
          <TableRow key={e.id}>
            <TableCell muted className="whitespace-nowrap" title={fullTime(e.time)}>
              {formatTime(e.time)}
            </TableCell>
            <TableRowHeader className="max-w-[220px] truncate">
              {e.actor ? (
                userLink(e.actor.id, e.actor.email ?? "Deleted user")
              ) : (
                <span className="text-muted">{e.action === "login_failed" ? "Not signed in" : "Kore ID"}</span>
              )}
            </TableRowHeader>
            <TableCell>
              <span className={e.action === "login_failed" || e.action === "app_access_denied" ? "text-warning" : undefined}>
                {actionLabel(e.action)}
              </span>
              {detail ? <span className="block max-w-[260px] truncate text-meta text-muted">{detail}</span> : null}
            </TableCell>
            <TableCell className="max-w-[220px] truncate">{e.target ? userLink(e.target.id, e.target.label ?? "—") : "—"}</TableCell>
            <TableCell muted className="whitespace-nowrap" title={e.userAgent ?? undefined}>
              {e.ip ?? "—"}
              {e.userAgent ? <span className="block text-meta">{describeDevice(e.userAgent)}</span> : null}
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}

export function ActivityPage() {
  return (
    <Shell section="activity" admin>
      <Activity />
    </Shell>
  );
}

function Activity() {
  const initial = new URLSearchParams(window.location.search);
  const [user, setUser] = useState(initial.get("user") ?? "all");
  const [action, setAction] = useState(initial.get("action") ?? "all");
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const users = useResource(() => api.users(), []);

  const filters = { user: user === "all" ? undefined : user, action: action === "all" ? undefined : action };

  useEffect(() => {
    let live = true;
    setEntries(null);
    setError(null);
    // Keep the filters in the URL so the view can be shared and survives a reload.
    const q = new URLSearchParams();
    if (filters.user) q.set("user", filters.user);
    if (filters.action) q.set("action", filters.action);
    window.history.replaceState(null, "", `/admin/activity${q.size ? `?${q}` : ""}`);
    api
      .audit({ ...filters, limit: PAGE })
      .then((r) => {
        if (!live) return;
        setEntries(r.entries);
        setCursor(r.nextCursor);
      })
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, action]);

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await api.audit({ ...filters, limit: PAGE, cursor });
      setEntries((e) => [...(e ?? []), ...r.entries]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <PageHeader title="Activity" breadcrumbs={[{ label: "Admin", href: "/admin" }]} />
      <PageBody>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select
            size="sm"
            aria-label="User"
            value={user}
            onValueChange={setUser}
            className="w-[240px]"
            options={[
              { value: "all", label: "Everyone" },
              ...(users.data?.users ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.email})` })),
            ]}
          />
          <Select
            size="sm"
            aria-label="Action"
            value={action}
            onValueChange={setAction}
            className="w-[220px]"
            options={[{ value: "all", label: "All actions" }, ...Object.entries(ACTIONS).map(([value, label]) => ({ value, label }))]}
          />
          {user !== "all" || action !== "all" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setUser("all");
                setAction("all");
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
        {error ? <p className="mb-3 text-meta text-danger">{errorMessage(error)}</p> : null}
        <Table caption="Audit log" className="min-w-[760px]">
          <TableHeader>
            <tr>
              <TableHead>Time</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>IP and device</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {entries === null ? (
              [0, 1, 2, 3].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-5 w-2/3" />
                  </TableCell>
                </TableRow>
              ))
            ) : entries.length === 0 ? (
              <TableEmpty colSpan={5}>{user !== "all" || action !== "all" ? "Nothing matches these filters." : "No activity yet."}</TableEmpty>
            ) : (
              <ActivityRows entries={entries} />
            )}
          </TableBody>
        </Table>
        {cursor ? (
          <div className="mt-4 flex justify-center">
            <Button onClick={() => void more()} loading={loadingMore}>
              {loadingMore ? "Loading…" : "Show older"}
            </Button>
          </div>
        ) : entries?.length ? (
          <p className="mt-4 text-center text-meta text-muted">That's everything.</p>
        ) : null}
      </PageBody>
    </>
  );
}
