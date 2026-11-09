import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layoutSchema } from "../src/layout.js";
import { parseSchema } from "../src/parser.js";
import { escape, renderHtml } from "../src/render.js";
import { splitStatements } from "../src/split.js";

const render = (sql: string) => {
  const schema = parseSchema(splitStatements(sql), "PostgreSQL");
  return renderHtml(schema, layoutSchema(schema), { dialect: "PostgreSQL", dialectSource: "given" });
};

/** The CSS custom properties of the light `:root` block or the `prefers-color-scheme: dark` one. */
function themeVars(html: string, theme: "light" | "dark"): Record<string, string> {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
  const dark = css.match(/@media \(prefers-color-scheme:dark\)\{:root\{([^}]*)\}\}/)![1]!;
  const light = css.replace(/@media[^{]*\{:root\{[^}]*\}\}/g, "").match(/:root\{([^}]*)\}/)![1]!;
  return Object.fromEntries([...(theme === "dark" ? dark : light).matchAll(/(--[\w-]+):([^;]+)/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** WCAG 2 contrast ratio of two #rgb / #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (color: string) => {
    const hex = color.length === 4 ? color.replace(/\w/g, "$&$&") : color;
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const fixtureHtml = render(readFileSync(join(import.meta.dirname, "fixtures", "postgresql.sql"), "utf8"));

describe("escape", () => {
  it.each([
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ['"', "&quot;"],
    ["'", "&#39;"],
    ["a<b & 'c'", "a&lt;b &amp; &#39;c&#39;"],
    ["plain", "plain"],
  ])("escapes %j", (input, out) => {
    expect(escape(input)).toBe(out);
  });
});

describe("renderHtml — PostgreSQL fixture", () => {
  it("matches the snapshot", async () => {
    await expect(fixtureHtml).toMatchFileSnapshot("./__snapshots__/postgresql.html");
  });

  it("draws table names bold, larger than rows and vertically centred in the header", () => {
    expect(fixtureHtml).toMatch(/\.hn\{fill:var\(--hdr-fg\);font-size:13px;font-weight:700;dominant-baseline:middle\}/);
    expect(fixtureHtml).toContain('<text class="hn" x="10" y="13">public.customers</text>');
  });

  it.each(["light", "dark"] as const)("header text contrasts with header fill in %s mode (≥ 4.5:1)", (theme) => {
    const v = themeVars(fixtureHtml, theme);
    expect(contrast(v["--hdr-fg"]!, v["--hdr-bg"]!)).toBeGreaterThanOrEqual(4.5); // tables
    expect(contrast(v["--hdrv-fg"]!, v["--hdrv-bg"]!)).toBeGreaterThanOrEqual(4.5); // views
    expect(contrast(v["--muted"]!, v["--card"]!)).toBeGreaterThanOrEqual(4.5); // placeholder names
  });

  it("is a standalone HTML page with one inline SVG", () => {
    expect(fixtureHtml.startsWith("<!doctype html>")).toBe(true);
    expect(fixtureHtml.match(/<svg /g)).toHaveLength(1);
    expect(fixtureHtml).toMatch(/<svg [^>]*viewBox="0 0 [\d.]+ [\d.]+"/);
    expect(fixtureHtml).toContain("prefers-color-scheme:dark");
  });

  it("stays offline: no script, no external resources", () => {
    expect(fixtureHtml).not.toMatch(/<script/i);
    expect(fixtureHtml).not.toMatch(/\ssrc=/i);
    expect(fixtureHtml).not.toMatch(/href="http/i);
    expect(fixtureHtml).not.toMatch(/@import|url\(http/i);
  });

  it("stays small", () => {
    // 7 tables/views: the plan's budget is a few KB per 10 tables.
    expect(Buffer.byteLength(fixtureHtml)).toBeLessThan(20_000);
  });

  it("shows the summary and the dialect", () => {
    expect(fixtureHtml).toContain("6 tables · 1 view · 6 foreign keys · Parsed as PostgreSQL (given)");
  });

  it("draws one group per node and one path per edge", () => {
    expect(fixtureHtml.match(/<g class="[tvp]"/g)).toHaveLength(7);
    expect(fixtureHtml.match(/<path class="e/g)).toHaveLength(11); // 7 FK column pairs (one composite FK) + 4 view sources
    expect(fixtureHtml.match(/<path class="e ev"/g)).toHaveLength(4);
  });

  it("marks keys and fades nullable columns", () => {
    expect(fixtureHtml).toContain('<tspan class="k" x="10">PK FK</tspan>');
    expect(fixtureHtml).toContain('>UQ</tspan><tspan x="');
    expect(fixtureHtml).toMatch(/<text class="nl" y="[\d.]+"><title>full_name TEXT<\/title>/);
  });

  it("lists skipped statements in a <details> block", () => {
    expect(fixtureHtml).toMatch(/<details><summary>1 statement skipped or adjusted<\/summary><ul><li>Line 71:30: Skipped <code>CREATE TABLE audit_log \(<\/code>/);
  });
});

describe("renderHtml — escaping and edge cases", () => {
  it("escapes identifiers, types and defaults", () => {
    const html = render(`CREATE TABLE "a<b&c" ("x>'y" TEXT DEFAULT '<&>')`);
    expect(html).toContain("a&lt;b&amp;c");
    expect(html).toContain("x&gt;&#39;y");
    expect(html).toContain("DEFAULT &#39;&lt;&amp;&gt;&#39;");
    expect(html).not.toMatch(/a<b|<&>/);
  });

  it("draws a dashed placeholder for an undefined table", () => {
    const html = render("CREATE TABLE t (id INT, org_id INT REFERENCES orgs (id))");
    expect(html).toContain('<g class="p"');
    expect(html).toContain("orgs (not defined)");
    expect(html).toContain("1 table · 1 foreign key · 1 referenced table not defined");
  });

  it("omits the warnings block when nothing was skipped", () => {
    expect(render("CREATE TABLE t (id INT)")).not.toContain("<details>");
  });
});
