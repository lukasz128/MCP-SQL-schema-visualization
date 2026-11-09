// Schema model + layout → one self-contained HTML page (inline CSS + inline SVG, no script).
// Header fill and header text always come from the same theme pair (--hdr-bg/--hdr-fg,
// --hdrv-bg/--hdrv-fg for views), defined in both the light and the dark block; never
// combine a fixed fill with a themed text colour.
import { FONT_SIZE, HEADER_FONT_SIZE, HEADER_HEIGHT, PLACEHOLDER_SUFFIX, ROW_HEIGHT, type Layout, type LayoutNode, type Point } from "./layout.js";
import type { Column, Dialect, Schema, Table } from "./model.js";

export interface RenderMeta {
  dialect: Dialect;
  /** How the dialect was chosen: passed by the caller, detected, or the fallback default. */
  dialectSource: "given" | "detected" | "default";
  /** Shown as the page heading, e.g. the input file's name. */
  title?: string;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

const n = (v: number): string => String(Math.round(v * 10) / 10);
const BASELINE = FONT_SIZE * 0.35; // vertical offset from a row's center to the text baseline
const CORNER = 4;

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#c9d1d9;--hdr-bg:#e8eef6;--hdr-fg:#1f2328;--hdrv-bg:#efe9f8;--hdrv-fg:#1f2328;--edge:#6e7781;--key:#9a6700;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#3d444d;--hdr-bg:#1c2633;--hdr-fg:#e6edf3;--hdrv-bg:#2a2238;--hdrv-fg:#e6edf3;--edge:#8b949e;--key:#d29922;--card:#151b23}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:18px;margin:0 0 2px}header p,footer{margin:0;color:var(--muted);font-size:13px}main{margin:12px 0;overflow:auto}
svg{display:block;max-width:100%;height:auto}svg text{font:${FONT_SIZE}px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--fg)}
.c{fill:var(--card);stroke:none}.o{fill:none;stroke:var(--line)}.h{fill:var(--hdr-bg)}.v .h{fill:var(--hdrv-bg)}.hn{fill:var(--hdr-fg);font-size:${HEADER_FONT_SIZE}px;font-weight:700;dominant-baseline:middle}.v .hn{fill:var(--hdrv-fg)}
.k{fill:var(--key);font-size:10px;font-weight:600}.ty{fill:var(--muted)}.nl{opacity:.62}.pk{font-weight:600}
.p .o{stroke-dasharray:4 3}.p .hn{font-style:italic;font-weight:400;fill:var(--muted)}
.e{fill:none;stroke:var(--edge);stroke-width:1.25}.ev{stroke-dasharray:2 3;opacity:.8}.m{fill:var(--edge)}
details{margin-top:8px;font-size:13px}summary{cursor:pointer;color:var(--muted)}details ul{margin:6px 0;padding-left:20px}code{font:12px ui-monospace,Menlo,Consolas,monospace}`;

/** Path through the routed points; axis-aligned routes (loops, brackets) get rounded corners. */
function pathData(points: Point[]): string {
  if (points.length < 2) return "";
  const [first] = points as [Point];
  const orthogonal = points.every((p, i) => i === 0 || p.x === points[i - 1]!.x || p.y === points[i - 1]!.y);
  if (orthogonal) {
    let d = `M${n(first.x)},${n(first.y)}`;
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1]!;
      const cur = points[i]!;
      const next = points[i + 1]!;
      const r = Math.min(6, dist(prev, cur) / 2, dist(cur, next) / 2);
      const a = toward(cur, prev, r);
      const b = toward(cur, next, r);
      d += `L${n(a.x)},${n(a.y)}Q${n(cur.x)},${n(cur.y)} ${n(b.x)},${n(b.y)}`;
    }
    const last = points.at(-1)!;
    return `${d}L${n(last.x)},${n(last.y)}`;
  }
  // One cubic per segment with horizontal tangents at both ends: smooth joins
  // (every tangent is horizontal) and no overshoot back into the boxes.
  let d = `M${n(first.x)},${n(first.y)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    const mx = (p.x + q.x) / 2;
    d += p.y === q.y ? `L${n(q.x)},${n(q.y)}` : `C${n(mx)},${n(p.y)} ${n(mx)},${n(q.y)} ${n(q.x)},${n(q.y)}`;
  }
  return d;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function toward(from: Point, to: Point, len: number): Point {
  const d = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) / d) * len, y: from.y + ((to.y - from.y) / d) * len };
}

function columnTitle(c: Column): string {
  const parts = [c.name, c.type];
  if (!c.nullable && !c.isPrimaryKey && c.type !== "") parts.push("NOT NULL");
  if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
  return parts.filter(Boolean).join(" ");
}

function renderNode(node: LayoutNode, table: Table | undefined): string {
  const w = n(node.width);
  const cls = node.placeholder ? "p" : node.kind === "view" ? "v" : "t";
  const headerPath = node.placeholder
    ? ""
    : `<path class="h" d="M0,${HEADER_HEIGHT}V${CORNER}Q0,0 ${CORNER},0H${n(node.width - CORNER)}Q${w},0 ${w},${CORNER}V${HEADER_HEIGHT}Z"/>`;
  const label = node.placeholder ? `${node.label}${PLACEHOLDER_SUFFIX}` : node.label;
  let out =
    `<g class="${cls}" transform="translate(${n(node.x)},${n(node.y)})">` +
    `<title>${escape(node.placeholder ? `${node.label}: referenced but not defined in this DDL` : `${node.kind === "view" ? "view" : "table"} ${node.label}`)}</title>` +
    `<rect class="c" width="${w}" height="${n(node.height)}" rx="${CORNER}"/>${headerPath}` +
    `<text class="hn" x="${n(node.markerX)}" y="${n(HEADER_HEIGHT / 2)}">${escape(label)}</text>`;

  if (table) {
    table.columns.forEach((c, i) => {
      const y = n(HEADER_HEIGHT + i * ROW_HEIGHT + ROW_HEIGHT / 2 + BASELINE);
      const marker = node.markers[i] ?? "";
      const rowCls = c.nullable ? ' class="nl"' : "";
      out +=
        `<text${rowCls} y="${y}"><title>${escape(columnTitle(c))}</title>` +
        (marker ? `<tspan class="k" x="${n(node.markerX)}">${marker}</tspan>` : "") +
        `<tspan${c.isPrimaryKey ? ' class="pk"' : ""} x="${n(node.nameX)}">${escape(c.name)}</tspan>` +
        (c.type ? `<tspan class="ty" x="${n(node.typeX)}">${escape(c.type)}</tspan>` : "") +
        `</text>`;
    });
  }
  return `${out}<rect class="o" width="${w}" height="${n(node.height)}" rx="${CORNER}"/></g>`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function renderHtml(schema: Schema, layout: Layout, meta: RenderMeta): string {
  const tables = schema.tables.filter((t) => t.kind === "table").length;
  const views = schema.tables.length - tables;
  const fks = schema.tables.reduce((sum, t) => sum + t.foreignKeys.length, 0);
  const missing = layout.nodes.filter((nd) => nd.placeholder).length;

  const summary = [plural(tables, "table"), ...(views ? [plural(views, "view")] : []), plural(fks, "foreign key")];
  if (missing) summary.push(`${plural(missing, "referenced table")} not defined`);
  const source = { given: "given", detected: "detected", default: "default" }[meta.dialectSource];
  const heading = meta.title ? meta.title : "Database schema";

  const edges = layout.edges
    .map((e) => `<path class="e${e.kind === "view" ? " ev" : ""}" d="${pathData(e.points)}" marker-end="url(#a)"/>`)
    .join("");
  const nodes = layout.nodes
    .map((nd) => renderNode(nd, nd.tableIndex === undefined ? undefined : schema.tables[nd.tableIndex]))
    .join("");

  const warnings = schema.warnings.length
    ? `<details><summary>${plural(schema.warnings.length, "statement")} skipped or adjusted</summary><ul>${schema.warnings
        .map((w) => `<li>${w.line ? `Line ${w.line}${w.column ? `:${w.column}` : ""}: ` : ""}${escape(w.message).replace(/`([^`]*)`/g, "<code>$1</code>")}</li>`)
        .join("")}</ul></details>`
    : "";

  const W = n(layout.width);
  const H = n(layout.height);
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escape(heading)}</title><style>${CSS}</style></head><body>` +
    `<header><h1>${escape(heading)}</h1><p>${summary.join(" · ")} · Parsed as ${escape(meta.dialect)} (${source})</p></header>` +
    `<main><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escape(`Schema diagram: ${summary.join(", ")}`)}">` +
    `<defs><marker id="a" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path class="m" d="M0,0L8,4L0,8z"/></marker></defs>` +
    `${edges}${nodes}</svg></main>` +
    `<footer>PK primary key · FK foreign key · UQ unique · faded rows are nullable${views ? " · dotted lines link views to their tables" : ""}${missing ? " · dashed boxes are referenced but not defined" : ""}</footer>` +
    `${warnings}</body></html>\n`
  );
}
