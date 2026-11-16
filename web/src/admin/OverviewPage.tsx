import {
  AppTile,
  Button,
  Card,
  InlineMessage,
  PageBody,
  PageHeader,
  SectionHeader,
  Skeleton,
  Stat,
  Table,
  TableBody,
  TableEmpty,
  TableHead,
  TableHeader,
  TableSkeleton,
} from "@qarasky/kore-ui";
import { Link } from "wouter";
import { api } from "../lib/api";
import { plural } from "../lib/format";
import { Shell } from "../lib/Shell";
import { errorMessage } from "../lib/strings";
import { useResource } from "../lib/useResource";
import { ActivityRows } from "./ActivityPage";

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
  const count = (f: (u: (typeof list)[number]) => boolean) => list.filter(f).length;
  const loading = !users.data;

  return (
    <>
      <PageHeader title="Overview" breadcrumbs={[{ label: "Admin" }]} />
      <PageBody>
        {users.error ? <InlineMessage className="mb-3">{errorMessage(users.error)}</InlineMessage> : null}
        <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Users" value={list.length} loading={loading} />
          <Stat
            label="Active"
            value={count((u) => !u.disabled && u.hasPassword)}
            hint={loading ? undefined : `${count((u) => !u.disabled && !u.hasPassword)} setup pending`}
            loading={loading}
          />
          <Stat label="Disabled" value={count((u) => u.disabled)} loading={loading} />
          <Stat label="Admins" value={count((u) => u.role === "admin")} loading={loading} />
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
                  <AppTile app={a.app} name={a.name} />
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
              <TableSkeleton columns={["w-24", "w-32", "w-24", "w-32", "w-40"]} rows={3} />
            )}
          </TableBody>
        </Table>
        {audit.error ? <InlineMessage className="mt-3">{errorMessage(audit.error)}</InlineMessage> : null}
      </PageBody>
    </>
  );
}
