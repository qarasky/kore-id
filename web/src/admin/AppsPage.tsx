import {
  AppMark,
  Badge,
  Card,
  PageBody,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "@qarasky/kore-ui";
import { Info } from "lucide-react";
import { api } from "../lib/api";
import { isAppId } from "../lib/apps";
import { plural } from "../lib/format";
import { Shell } from "../lib/Shell";
import { errorMessage } from "../lib/strings";
import type { AdminClient } from "../lib/types";
import { useResource } from "../lib/useResource";

/** A client's URLs as labelled lines (they're long; a column each would wrap them mid-word). */
function Endpoints({ c }: { c: AdminClient }) {
  const rows: [string, string[]][] = [
    ["Redirect URIs", c.redirectUris],
    ["Home URL", c.homeUrl ? [c.homeUrl] : []],
    ["Back-channel logout", c.backchannelLogoutUri ? [c.backchannelLogoutUri] : []],
    ["After sign-out", c.postLogoutRedirectUris],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      {rows.map(([label, list]) => (
        <div key={label} className="contents">
          <dt className="text-meta whitespace-nowrap text-muted">{label}</dt>
          <dd className="min-w-0">
            {list.length ? (
              list.map((u) => (
                <span key={u} className="block font-mono text-meta [overflow-wrap:anywhere]">
                  {u}
                </span>
              ))
            ) : (
              <span className="text-meta text-muted">Not set</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function AppsPage() {
  return (
    <Shell section="apps" admin>
      <Apps />
    </Shell>
  );
}

function Apps() {
  const apps = useResource(() => api.apps(), []);
  return (
    <>
      <PageHeader
        title="Apps"
        breadcrumbs={[{ label: "Admin", href: "/admin" }]}
        meta={apps.data ? plural(apps.data.apps.length, "app") : undefined}
      />
      <PageBody>
        <Card className="mb-6 flex items-start gap-3 px-4 py-3 text-sub text-muted">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            Edit <code className="font-mono text-text">clients.json</code> on the server to change apps, then restart Kore ID. It holds
            the client secrets, so it isn't editable here.
          </p>
        </Card>
        {apps.error ? <p className="mb-3 text-meta text-danger">{errorMessage(apps.error)}</p> : null}
        {!apps.data && !apps.error ? <Skeleton className="h-40 w-full" /> : null}
        {apps.data?.apps.length === 0 ? <p className="text-muted">No apps are registered yet.</p> : null}
        <div className="flex flex-col gap-8">
          {apps.data?.apps.map((a) => (
            <section key={a.app} aria-labelledby={`app-${a.app}`}>
              <div className="mb-3 flex items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-ui border border-border bg-bg/60">
                  {isAppId(a.app) ? <AppMark app={a.app} size={20} /> : <span className="text-meta text-muted">{a.app.slice(0, 2)}</span>}
                </span>
                <div className="min-w-0">
                  <h2 id={`app-${a.app}`} className="text-title font-semibold tracking-[-0.01em]">
                    {a.name}
                  </h2>
                  <p className="text-meta text-muted">
                    App key <code className="font-mono">{a.app}</code> · {plural(a.userCount, "active user")} with access
                  </p>
                </div>
              </div>
              <Table caption={`${a.name} clients`} className="min-w-[680px]">
                <TableHeader>
                  <tr>
                    <TableHead className="w-[220px]">Client</TableHead>
                    <TableHead className="w-[130px]">Type</TableHead>
                    <TableHead>URLs</TableHead>
                  </tr>
                </TableHeader>
                <TableBody>
                  {a.clients.map((c) => (
                    <TableRow key={c.id} className="align-top">
                      <TableRowHeader>
                        <span className="block">{c.name}</span>
                        <code className="block font-mono text-meta text-muted">{c.id}</code>
                      </TableRowHeader>
                      <TableCell>
                        {c.public ? (
                          <Badge tone="outline" title="No secret; PKCE only (native apps)">
                            Public
                          </Badge>
                        ) : (
                          <Badge tone="neutral" title="Authenticates with a client secret">
                            Confidential
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Endpoints c={c} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          ))}
        </div>
      </PageBody>
    </>
  );
}
