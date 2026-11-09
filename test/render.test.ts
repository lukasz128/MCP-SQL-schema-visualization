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
