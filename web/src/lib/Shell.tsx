// The signed-in frame: kore-ui AppShell with the Kore ID wordmark, app switcher, account menu and one sidebar
// (your account, plus the admin console for admins).
import {
  AccountMenu,
  AppShell,
  AppSwitcher,
  EmptyState,
  MenuItem,
  Sidebar,
  SidebarItem,
  SidebarNav,
  Spinner,
  TopBar,
  Wordmark,
} from "@qarasky/kore-ui";
import { Activity, AppWindow, LayoutDashboard, ShieldCheck, UserRound, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { useLocation } from "wouter";
import { api } from "./api";
import { appProps } from "./apps";
import { useResource } from "./useResource";
import { useSession } from "./session";

export type Section = "account" | "overview" | "users" | "apps" | "activity";

function KoreIdSidebar({ current, admin }: { current: Section; admin: boolean }) {
  return (
    <Sidebar>
      <SidebarNav label="Account">
        <SidebarItem href="/account" icon={<UserRound />} active={current === "account"}>
          Your account
        </SidebarItem>
      </SidebarNav>
      {admin ? (
        <SidebarNav label="Admin" title="Admin">
          <SidebarItem href="/admin" icon={<LayoutDashboard />} active={current === "overview"}>
            Overview
          </SidebarItem>
          <SidebarItem href="/admin/users" icon={<Users />} active={current === "users"}>
            Users
          </SidebarItem>
          <SidebarItem href="/admin/apps" icon={<AppWindow />} active={current === "apps"}>
            Apps
          </SidebarItem>
          <SidebarItem href="/admin/activity" icon={<Activity />} active={current === "activity"}>
            Activity
          </SidebarItem>
        </SidebarNav>
      ) : null}
    </Sidebar>
  );
}

/** Centred spinner for first loads. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="grid min-h-[200px] flex-1 place-items-center text-muted">
      <Spinner size={20} label={label} />
    </div>
  );
}

/** Requires a signed-in user (else → /login). `admin` additionally requires the admin role (else a 403 view). */
export function Shell({ section, admin = false, children }: { section: Section; admin?: boolean; children: ReactNode }) {
  const { user, signOut } = useSession();
  const [, navigate] = useLocation();
  const myApps = useResource(() => (user ? api.myApps() : Promise.resolve({ apps: [] })), [user?.id]);

  useEffect(() => {
    if (user === null) window.location.assign("/login");
  }, [user]);

  if (!user) return <Loading />;
  const isAdmin = user.role === "admin";
  const { urls, names } = appProps(myApps.data?.apps ?? []);

  return (
    <AppShell
      brand={<Wordmark app="kore-id" />}
      brandHref="/account"
      topBar={
        <TopBar
          actions={
            <>
              {Object.keys(urls).length ? <AppSwitcher urls={urls} names={names} /> : null}
              <AccountMenu user={user} accountUrl="/account" apps={{ urls, names }} onSignOut={signOut}>
                {isAdmin ? (
                  <MenuItem icon={<ShieldCheck />} onSelect={() => navigate("/admin")}>
                    Admin console
                  </MenuItem>
                ) : null}
              </AccountMenu>
            </>
          }
        />
      }
      sidebar={<KoreIdSidebar current={section} admin={isAdmin} />}
    >
      {admin && !isAdmin ? (
        <div className="grid flex-1 place-items-center">
          <EmptyState
            icon={<ShieldCheck />}
            title="You need admin access"
            description="Only Kore ID admins can open the admin console. Ask an admin if you need it."
          />
        </div>
      ) : (
        children
      )}
    </AppShell>
  );
}
