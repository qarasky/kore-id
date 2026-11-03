import {
  AppMark,
  Button,
  Card,
  PageBody,
  PageHeader,
  SectionHeader,
  Skeleton,
  Table,
  TableBody,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "@qarasky/kore-ui";
import { Link } from "wouter";
import { api } from "../lib/api";
import { isAppId } from "../lib/apps";
import { plural } from "../lib/format";
import { Shell } from "../lib/Shell";
import { errorMessage } from "../lib/strings";
import { useResource } from "../lib/useResource";
import { ActivityRows } from "./ActivityPage";
import { Stat } from "./parts";

export function OverviewPage() {
  return (
    <Shell section="overview" admin>
      <Overview />
    </Shell>
  );
}

function Overview() {
  const users = useResource(() => api.users(), []);
  const apps = useResource(() => api.apps(), []);
  const audit = useResource(() => api.audit({ limit: 8 }), []);
  const list = users.data?.users ?? [];
  const count = (f: (u: (typeof list)[number]) => boolean) => (users.data ? list.filter(f).length : "–");

  return (
    <>
      <PageHeader title="Overview" breadcrumbs={[{ label: "Admin" }]} />
      <PageBody>
        {users.error ? <p className="mb-3 text-meta text-danger">{errorMessage(users.error)}</p> : null}
        <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Users" value={users.data ? list.length : "–"} />
          <Stat label="Active" value={count((u) => !u.disabled && u.hasPassword)} hint={users.data ? `${count((u) => !u.disabled && !u.hasPassword)} setup pending` : undefined} />
          <Stat label="Disabled" value={count((u) => u.disabled)} />
          <Stat label="Admins" value={count((u) => u.role === "admin")} />
        </div>

        <SectionHeader
          title="Apps"
          description="Active users who can sign in to each app."
          actions={
            <Button asChild size="sm" variant="ghost">
              <Link href="/admin/apps">View apps</Link>
            </Button>
          }
        />
        <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {apps.data
            ? apps.data.apps.map((a) => (
                <Card key={a.app} className="flex items-center gap-3 px-4 py-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-ui border border-border bg-bg/60">
                    {isAppId(a.app) ? <AppMark app={a.app} size={20} /> : <span className="text-meta text-muted">{a.app.slice(0, 2)}</span>}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{a.name}</span>
                    <span className="block text-meta text-muted">{plural(a.userCount, "user")}</span>
                  </span>
                </Card>
              ))
            : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[66px]" />)}
          {apps.data?.apps.length === 0 ? <p className="text-muted">No apps registered. Add them to clients.json.</p> : null}
        </div>

        <SectionHeader
          title="Recent activity"
          description="Sign-ins, failed sign-ins and admin actions."
          actions={
            <Button asChild size="sm" variant="ghost">
              <Link href="/admin/activity">View all</Link>
            </Button>
          }
        />
        <Table caption="Recent activity" className="min-w-[720px]">
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
            {audit.data ? (
              audit.data.entries.length ? (
                <ActivityRows entries={audit.data.entries} />
              ) : (
                <TableEmpty colSpan={5}>No activity yet.</TableEmpty>
              )
            ) : (
              <TableRow>
                <TableRowHeader colSpan={5}>
                  <Skeleton className="h-5 w-1/3" />
                </TableRowHeader>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {audit.error ? <p className="mt-3 text-meta text-danger">{errorMessage(audit.error)}</p> : null}
      </PageBody>
    </>
  );
}
