// Kore ID's app keys (clients.json `app`) vs kore-ui's AppId (the four products with marks).
import { KORE_APP_IDS, type AppId, type AppNames, type AppUrls } from "@qarasky/kore-ui";

export const isAppId = (key: string): key is AppId => (KORE_APP_IDS as readonly string[]).includes(key);

/** AppGrid/AppSwitcher props from a list of {app, name, homeUrl}. Unknown keys can't be shown by kore-ui. */
export function appProps(apps: { app: string; name: string; homeUrl: string | null }[]): { urls: AppUrls; names: AppNames } {
  const urls: AppUrls = {};
  const names: AppNames = {};
  for (const a of apps) {
    if (!isAppId(a.app)) continue;
    names[a.app] = a.name;
    if (a.homeUrl) urls[a.app] = a.homeUrl;
  }
  return { urls, names };
}
