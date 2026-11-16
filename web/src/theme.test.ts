import { KORE_THEME_COLOR, themeInitScript } from "@qarasky/kore-ui";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

describe("index.html theme wiring", () => {
  it("inlines kore-ui's no-flash script unchanged, so a stored theme shows from the first paint", () => {
    expect(html).toContain(`<script>${themeInitScript()}</script>`);
  });

  it("starts the theme-color meta on the Color theme", () => {
    expect(html).toContain(`<meta name="theme-color" content="${KORE_THEME_COLOR}" />`);
  });
});
