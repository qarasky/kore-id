import { EmptyState, Button } from "@qarasky/kore-ui";
import { Compass } from "lucide-react";
import { Redirect, Route, Switch } from "wouter";
import { AccountPage } from "./account/AccountPage";
import { ActivityPage } from "./admin/ActivityPage";
import { AppsPage } from "./admin/AppsPage";
import { OverviewPage } from "./admin/OverviewPage";
import { UserDetailPage } from "./admin/UserDetailPage";
import { UsersPage } from "./admin/UsersPage";
import { LoginScreen } from "./screens/Login";
import { LogoutConfirmScreen } from "./screens/LogoutConfirm";
import { NoAccessScreen } from "./screens/NoAccess";
import { SetupScreen } from "./screens/Setup";

export function App() {
  return (
    <Switch>
      <Route path="/login" component={LoginScreen} />
      <Route path="/setup/:token" component={SetupScreen} />
      {/* Served by the server's /authorize (403) and GET /logout. */}
      <Route path="/authorize" component={NoAccessScreen} />
      <Route path="/logout" component={LogoutConfirmScreen} />

      <Route path="/account">{() => <AccountPage section="profile" />}</Route>
      <Route path="/account/security">{() => <AccountPage section="security" />}</Route>
      <Route path="/account/apps">{() => <AccountPage section="apps" />}</Route>

      <Route path="/admin" component={OverviewPage} />
      <Route path="/admin/users" component={UsersPage} />
      <Route path="/admin/users/:id">{(p) => <UserDetailPage id={p.id} tab="profile" />}</Route>
      <Route path="/admin/users/:id/apps">{(p) => <UserDetailPage id={p.id} tab="apps" />}</Route>
      <Route path="/admin/users/:id/security">{(p) => <UserDetailPage id={p.id} tab="security" />}</Route>
      <Route path="/admin/apps" component={AppsPage} />
      <Route path="/admin/activity" component={ActivityPage} />

      <Route path="/">
        <Redirect to="/account" replace />
      </Route>
      <Route>
        <div className="grid min-h-dvh place-items-center bg-bg">
          <EmptyState
            icon={<Compass />}
            title="This page doesn't exist"
            description="Check the address, or go to your account."
            action={
              <Button asChild variant="primary">
                <a href="/account">Go to your account</a>
              </Button>
            }
          />
        </div>
      </Route>
    </Switch>
  );
}
