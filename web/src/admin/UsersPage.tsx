import {
  Avatar,
  Badge,
  Button,
  Input,
  PageBody,
  PageHeader,
  SectionHeader,
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
  type SortDirection,
} from "@qarasky/kore-ui";
import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { api } from "../lib/api";
import { formatTime, fullTime, plural } from "../lib/format";
import { useSession } from "../lib/session";
import { Shell } from "../lib/Shell";
import { errorMessage } from "../lib/strings";
import { useResource } from "../lib/useResource";
import type { User } from "../lib/types";
import { AddUserDialog } from "./AddUserDialog";
import { AppList, RoleBadge, UserStatus } from "./parts";

type Filter = "all" | "active" | "disabled" | "admin" | "pending";
type SortKey = "name" | "lastLogin";

const matches = (u: User, f: Filter) =>
  f === "all" ||
  (f === "active" && !u.disabled && u.hasPassword) ||
  (f === "disabled" && u.disabled) ||
  (f === "admin" && u.role === "admin") ||
  (f === "pending" && !u.disabled && !u.hasPassword);

export function UsersPage() {
  return (
    <Shell section="users" admin>
      <Users />
    </Shell>
  );
}

function Users() {
  const { user: me } = useSession();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDirection }>({ key: "name", dir: "asc" });
  const [adding, setAdding] = useState(false);

  // Search on the server, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const users = useResource(() => api.users(q), [q]);
  const apps = useResource(() => api.apps(), []);
  const appNames = useMemo(() => Object.fromEntries((apps.data?.apps ?? []).map((a) => [a.app, a.name])), [apps.data]);

  const rows = useMemo(() => {
    const list = (users.data?.users ?? []).filter((u) => matches(u, filter));
    const dir = sort.dir === "asc" ? 1 : -1;
    return list.sort((a, b) =>
      sort.key === "name"
        ? (a.name || a.email).localeCompare(b.name || b.email) * dir
        : ((a.lastLoginAt ? Date.parse(a.lastLoginAt) : 0) - (b.lastLoginAt ? Date.parse(b.lastLoginAt) : 0)) * dir,
    );
  }, [users.data, filter, sort]);

  const sortBy = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));
  const total = users.data?.users.length;

  return (
    <>
      <PageHeader title="Users" breadcrumbs={[{ label: "Admin", href: "/admin" }]} />
      <PageBody>
        <SectionHeader
          title="Users"
          description={
            users.data
              ? `${plural(total ?? 0, "user")} · ${users.data.users.filter((u) => !u.disabled && u.hasPassword).length} active`
              : "Loading…"
          }
          actions={
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus /> Add user
            </Button>
          }
        />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search />}
            placeholder="Search by name or email"
            aria-label="Search users"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-[320px]"
          />
          <Select<Filter>
            size="sm"
            aria-label="Show"
            value={filter}
            onValueChange={setFilter}
            className="w-[170px]"
            options={[
              { value: "all", label: "All users" },
              { value: "active", label: "Active" },
              { value: "pending", label: "Setup pending" },
              { value: "disabled", label: "Disabled" },
              { value: "admin", label: "Admins" },
            ]}
          />
        </div>
        {users.error ? <p className="mb-3 text-meta text-danger">{errorMessage(users.error)}</p> : null}
        <Table caption="Users" className="min-w-[820px]">
          <TableHeader>
            <tr>
              <TableHead onSort={() => sortBy("name")} sorted={sort.key === "name" && sort.dir}>
                Name
              </TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Apps</TableHead>
              <TableHead onSort={() => sortBy("lastLogin")} sorted={sort.key === "lastLogin" && sort.dir}>
                Last sign-in
              </TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {!users.data ? (
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-5 w-1/2" />
                  </TableCell>
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableEmpty colSpan={5}>{q ? `No users match “${q}”.` : "No users to show."}</TableEmpty>
            ) : (
              rows.map((u) => (
                <TableRow key={u.id} interactive onClick={() => navigate(`/admin/users/${u.id}`)}>
                  <TableRowHeader>
                    <span className="flex min-w-0 items-center gap-3">
                      <Avatar name={u.name} email={u.email} size="sm" />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <Link
                            href={`/admin/users/${u.id}`}
                            className="truncate rounded-[4px] hover:underline"
                            onClick={(e: React.MouseEvent) => e.stopPropagation()}
                          >
                            {u.name}
                          </Link>
                          {u.id === me?.id ? <Badge tone="accent">You</Badge> : null}
                        </span>
                        <span className="block truncate text-meta text-muted">{u.email}</span>
                      </span>
                    </span>
                  </TableRowHeader>
                  <TableCell>
                    <RoleBadge role={u.role} />
                  </TableCell>
                  <TableCell>
                    <UserStatus user={u} />
                  </TableCell>
                  <TableCell>
                    <AppList user={u} names={appNames} />
                  </TableCell>
                  <TableCell muted className="whitespace-nowrap" title={fullTime(u.lastLoginAt)}>
                    {formatTime(u.lastLoginAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </PageBody>
      <AddUserDialog open={adding} onOpenChange={setAdding} apps={apps.data?.apps ?? []} onCreated={() => void users.reload()} />
    </>
  );
}
