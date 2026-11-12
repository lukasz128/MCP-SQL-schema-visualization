import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEADER_HEIGHT, LOOP_OFFSET, MARGIN, ROW_HEIGHT, layoutSchema } from "../src/layout.js";
import { parseSchema } from "../src/parser.js";
import { CSP, escape, renderHtml } from "../src/render.js";
import { splitStatements } from "../src/split.js";

const render = (sql: string) => {
  const schema = parseSchema(splitStatements(sql), "PostgreSQL");
  return renderHtml(schema, layoutSchema(schema), { dialect: "PostgreSQL", dialectSource: "given" });
};

const fixtureSql = readFileSync(join(import.meta.dirname, "fixtures", "postgresql.sql"), "utf8");

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

const fixtureHtml = render(fixtureSql);

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

  it("stays offline: exactly one inline script at the end of <body>, no external resources", () => {
    expect(fixtureHtml.match(/<script/gi)).toHaveLength(1);
    expect(fixtureHtml).toMatch(/<script>(?:(?!<\/)[\s\S])*<\/script><\/body><\/html>\n$/); // nothing in it can close the tag early
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

describe("renderHtml — Content-Security-Policy", () => {
  const script = fixtureHtml.match(/<script>([\s\S]*?)<\/script>/)![1]!;

  it("puts the policy right after the charset, before anything it has to cover", () => {
    expect(fixtureHtml).toMatch(/^<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="[^"]+">/);
    expect(fixtureHtml).toContain(`content="${CSP}"`);
  });

  it("allows exactly the page's own script, by its SHA-256 hash", () => {
    const hash = createHash("sha256").update(script).digest("base64");
    expect(CSP).toContain(`script-src 'sha256-${hash}'`);
    expect(CSP).not.toMatch(/script-src[^;]*'unsafe-/);
  });

  it("blocks all loading and only allows inline styles", () => {
    expect(CSP.split("; ")).toEqual([
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      expect.stringMatching(/^script-src 'sha256-[A-Za-z0-9+/]{43}='$/),
      "base-uri 'none'",
      "form-action 'none'",
    ]);
  });
});

describe("renderHtml — drag and drop markup", () => {
  const schema = parseSchema(splitStatements(fixtureSql), "PostgreSQL");
  const layout = layoutSchema(schema);
  const script = fixtureHtml.match(/<script>([\s\S]*?)<\/script>/)![1]!;

  it("keeps the script small", () => {
    expect(Buffer.byteLength(script)).toBeLessThan(3_500);
  });

  it("writes the layout constants into the script, so anchors match layout.ts", () => {
    expect(script).toContain(`const H=${HEADER_HEIGHT},R=${ROW_HEIGHT},O=${LOOP_OFFSET},M=${MARGIN};`);
  });

  it("gives every node a data-t id and a translate() with children in local coordinates", () => {
    for (const nd of layout.nodes) {
      expect(fixtureHtml).toContain(`data-t="${nd.id}" transform="translate(${nd.x},${nd.y})">`);
    }
  });

  it("tags every edge with its two node ids and row indexes", () => {
    const tags = [...fixtureHtml.matchAll(/<path class="e[^"]*" data-from="(\w+)" data-fr="(-?\d+)" data-to="(\w+)" data-tr="(-?\d+)"/g)].map((m) => m.slice(1).join(" "));
    expect(tags).toEqual(layout.edges.map((e) => `${e.from} ${e.fromRow} ${e.to} ${e.toRow}`));
  });

  it("renders the Reset layout button hidden, for the script to reveal", () => {
    expect(fixtureHtml).toContain('<button id="reset" type="button" hidden>Reset layout</button>');
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

  it("keeps hostile identifiers, defaults, warnings and titles inert", () => {
    const sql = [
      `CREATE TABLE "</title><script>alert(1)</script>" (`,
      `  "x' onmouseover='alert(1)" TEXT DEFAULT '</script><script>alert(2)</script>',`,
      `  "<img src=x onerror=alert(3)>" INT REFERENCES "<svg onload=alert(4)>" (id)`,
      `);`,
      // A statement the parser can't handle: its text ends up in the warnings list.
      `CREATE TABLE "<img src=y onerror=alert(5)>" (id INT GENERATED ALWAYS AS IDENTITY);`,
    ].join("\n");
    const schema = parseSchema(splitStatements(sql), "PostgreSQL");
    expect(schema.warnings).toHaveLength(1);
    const html = renderHtml(schema, layoutSchema(schema), {
      dialect: "PostgreSQL",
      dialectSource: "given",
      title: `"><script>alert(6)</script>.sql`,
    });

    expect(html.match(/<script/gi)).toHaveLength(1); // only the drag script
    expect(html).not.toMatch(/<(img|svg onload|title><script)/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son\w+=/i); // no event-handler attribute inside any real tag
    expect(html).not.toMatch(/<\/script>(?!<\/body>)/); // nothing closes the script tag early
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("x&#39; onmouseover=&#39;alert(1)");
    expect(html).toContain("&lt;img src=x onerror=alert(3)&gt;");
    expect(html).toContain("&lt;svg onload=alert(4)&gt; (not defined)");
    expect(html).toContain("&lt;img src=y onerror=alert(5)&gt;");
    expect(html).toContain("<title>&quot;&gt;&lt;script&gt;alert(6)&lt;/script&gt;.sql</title>");
    expect(html).toContain(`content="${CSP}"`);
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
