// Schema model → positioned nodes and routed edges, computed with dagre.
import dagre from "@dagrejs/dagre";
import type { Column, Schema, Table } from "./model.js";

export const FONT_SIZE = 12;
export const CHAR_WIDTH = FONT_SIZE * 0.6; // monospace estimate
/** Table names are drawn bold at about 1.1× the row font size. */
export const HEADER_FONT_SIZE = 13;
/** Shown after the name of a referenced-but-undefined table; part of its width estimate. */
export const PLACEHOLDER_SUFFIX = " (not defined)";
export const HEADER_HEIGHT = 26;
export const ROW_HEIGHT = 20;
export const PAD_X = 10;
const GAP = CHAR_WIDTH * 2; // between marker, name and type
const NODE_SEP = 40;
const RANK_SEP = 90;
const MARGIN = 20;
const STUB = 14; // horizontal run before an edge bends away from a row
const LOOP_OFFSET = 26;
const LOOP_STEP = 10;
/** LR graphs wider than this × their height are re-laid out top-to-bottom. Provisional: tune on the 30-table fixture (Phase 7). */
export const TB_ASPECT_THRESHOLD = 4;

export interface Point {
  x: number;
  y: number;
}

export interface LayoutNode {
  id: string;
  /** Index into `schema.tables`; absent for placeholder nodes. */
  tableIndex?: number;
  /** Placeholder for a referenced table that the DDL never defines. */
  placeholder: boolean;
  kind: "table" | "view" | "placeholder";
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Offsets (from the node's left edge) of the marker, name and type text. */
  markerX: number;
  nameX: number;
  typeX: number;
  /** Per-row key markers, e.g. "PK", "FK", "PK FK", "UQ". */
  markers: string[];
}

export interface LayoutEdge {
  id: string;
  kind: "fk" | "view";
  /** Referencing node (or the view). */
  from: string;
  /** Referenced node (or the view's source table). */
  to: string;
  /** Column row index in each node, -1 for the header. */
  fromRow: number;
  toRow: number;
  /** Route from `from` to `to`; the arrowhead goes at the last point. */
  points: Point[];
}

export interface Layout {
  direction: "LR" | "TB";
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** East Asian wide and fullwidth characters take two monospace cells. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Estimated width in monospace cells. */
export function textCells(s: string): number {
  let n = 0;
  for (const ch of s) n += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return n;
}

export function rowCenterY(node: { y: number }, row: number): number {
  return row < 0 ? node.y + HEADER_HEIGHT / 2 : node.y + HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

function qualifiedName(t: Table): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

function indexColumn(columns: Column[], name: string): number {
  const exact = columns.findIndex((c) => c.name === name);
  return exact >= 0 ? exact : columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
}

/** Width a header needs for its name: larger font than the rows, bold (~8% extra), padded both sides. Never truncated. */
function headerTextWidth(text: string): number {
  return textCells(text) * CHAR_WIDTH * (HEADER_FONT_SIZE / FONT_SIZE) * 1.08 + 2 * PAD_X;
}

/** Sizes a table node from its text; the type column is left-aligned after the longest name. */
function sizeTable(id: string, table: Table, tableIndex: number): LayoutNode {
  const fkCols = new Set(table.foreignKeys.flatMap((fk) => fk.columns.map((c) => c.toLowerCase())));
  const markers = table.columns.map((c) => {
    const m: string[] = [];
    if (c.isPrimaryKey) m.push("PK");
    if (fkCols.has(c.name.toLowerCase())) m.push("FK");
    if (c.unique && !c.isPrimaryKey) m.push("UQ");
    return m.join(" ");
  });
  const markerCells = Math.max(0, ...markers.map((m) => m.length));
  const nameCells = Math.max(0, ...table.columns.map((c) => textCells(c.name)));
  const typeCells = Math.max(0, ...table.columns.map((c) => textCells(c.type)));

  const markerX = PAD_X;
  const nameX = markerX + (markerCells > 0 ? markerCells * CHAR_WIDTH + GAP : 0);
  const typeX = nameX + nameCells * CHAR_WIDTH + GAP;
  const rowsWidth = (typeCells > 0 ? typeX + typeCells * CHAR_WIDTH : nameX + nameCells * CHAR_WIDTH) + PAD_X;
  const headerWidth = headerTextWidth(qualifiedName(table));
  return {
    id,
    tableIndex,
    placeholder: false,
    kind: table.kind,
    label: qualifiedName(table),
    x: 0,
    y: 0,
    width: round(Math.max(rowsWidth, headerWidth, 80)),
    height: HEADER_HEIGHT + Math.max(1, table.columns.length) * ROW_HEIGHT,
    markerX: round(markerX),
    nameX: round(nameX),
    typeX: round(typeX),
    markers,
  };
}

function placeholderNode(id: string, label: string): LayoutNode {
  return {
    id,
    placeholder: true,
    kind: "placeholder",
    label,
    x: 0,
    y: 0,
    width: round(Math.max(headerTextWidth(label + PLACEHOLDER_SUFFIX), 80)),
    height: HEADER_HEIGHT,
    markerX: PAD_X,
    nameX: PAD_X,
    typeX: PAD_X,
    markers: [],
  };
}

interface Link {
  kind: "fk" | "view";
  from: string;
  to: string;
  fromRow: number;
  toRow: number;
}

/** Resolves every FK column pair and view source to a link between nodes, adding placeholders as needed. */
function collectLinks(schema: Schema, nodes: LayoutNode[]): Link[] {
  const byKey = new Map<string, string>();
  const byName = new Map<string, string[]>();
  schema.tables.forEach((t, i) => {
    const id = nodes[i]!.id;
    byKey.set(qualifiedName(t).toLowerCase(), id);
    const list = byName.get(t.name.toLowerCase()) ?? [];
    list.push(id);
    byName.set(t.name.toLowerCase(), list);
  });
  const placeholders = new Map<string, string>();

  // `schema.name`: exact, then unqualified name; `name`: a table of that name in any schema.
  const resolve = (name: string, schemaName?: string): string => {
    const qualified = (schemaName ? `${schemaName}.${name}` : name).toLowerCase();
    const hit = byKey.get(qualified) ?? byName.get(name.toLowerCase())?.[0];
    if (hit) return hit;
    let id = placeholders.get(qualified);
    if (!id) {
      id = `n${nodes.length}`;
      placeholders.set(qualified, id);
      nodes.push(placeholderNode(id, schemaName ? `${schemaName}.${name}` : name));
    }
    return id;
  };
  const tableOf = (id: string): Table | undefined => {
    const n = nodes.find((x) => x.id === id);
    return n?.tableIndex === undefined ? undefined : schema.tables[n.tableIndex];
  };

  const links: Link[] = [];
  schema.tables.forEach((table, i) => {
    const from = nodes[i]!.id;
    for (const fk of table.foreignKeys) {
      const to = resolve(fk.refTable, fk.refSchema);
      const target = tableOf(to);
      const refColumns = fk.refColumns.length > 0 ? fk.refColumns : (target?.primaryKey ?? []);
      fk.columns.forEach((col, k) => {
        const refCol = refColumns[k];
        links.push({
          kind: "fk",
          from,
          to,
          fromRow: indexColumn(table.columns, col),
          toRow: target && refCol !== undefined ? indexColumn(target.columns, refCol) : -1,
        });
      });
    }
    for (const source of table.sources ?? []) {
      const dot = source.lastIndexOf(".");
      const to = dot > 0 ? resolve(source.slice(dot + 1), source.slice(0, dot)) : resolve(source);
      links.push({ kind: "view", from, to, fromRow: -1, toRow: -1 });
    }
  });
  return links;
}

function runDagre(nodes: LayoutNode[], links: Link[], rankdir: "LR" | "TB") {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir, nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  links.forEach((l, i) => {
    // Referenced → referencing, so parent tables rank first (left in LR).
    if (l.from !== l.to) g.setEdge(l.to, l.from, {}, `e${i}`);
  });
  dagre.layout(g);
  const graph = g.graph();
  return { g, width: graph.width ?? 0, height: graph.height ?? 0 };
}

/** True when two boxes share some x range, so no side of one faces the other. */
function overlapsX(a: LayoutNode, b: LayoutNode): boolean {
  return Math.abs(a.x + a.width / 2 - (b.x + b.width / 2)) < (a.width + b.width) / 2;
}

/** Builds the route of one link once nodes are placed. */
function route(link: Link, a: LayoutNode, b: LayoutNode, interior: Point[], loopIndex: number): Point[] {
  const y1 = rowCenterY(a, link.fromRow);
  const y2 = rowCenterY(b, link.toRow);

  if (a === b) {
    // Self-reference: a loop on the right side.
    const right = a.x + a.width;
    const out = right + LOOP_OFFSET + loopIndex * LOOP_STEP;
    const dy = y1 === y2 ? ROW_HEIGHT / 2 : 0;
    return [
      { x: right, y: y1 - dy },
      { x: out, y: y1 - dy },
      { x: out, y: y2 + dy },
      { x: right, y: y2 + dy },
    ];
  }

  const aCenter = a.x + a.width / 2;
  const bCenter = b.x + b.width / 2;
  if (overlapsX(a, b)) {
    // Stacked boxes (typical in TB): leave and enter on the right, bracket outside both.
    const ax = a.x + a.width;
    const bx = b.x + b.width;
    const out = Math.max(ax, bx) + LOOP_OFFSET + loopIndex * LOOP_STEP;
    return [
      { x: ax, y: y1 },
      { x: out, y: y1 },
      { x: out, y: y2 },
      { x: bx, y: y2 },
    ];
  }

  const dir = bCenter > aCenter ? 1 : -1;
  const start = { x: dir > 0 ? a.x + a.width : a.x, y: y1 };
  const end = { x: dir > 0 ? b.x : b.x + b.width, y: y2 };
  // Keep only dagre's bend points that lie strictly between the two boxes.
  const lo = Math.min(start.x, end.x) + STUB;
  const hi = Math.max(start.x, end.x) - STUB;
  const mid = interior.filter((p) => p.x > lo && p.x < hi);
  return [start, { x: start.x + dir * STUB, y: y1 }, ...mid, { x: end.x - dir * STUB, y: y2 }, end];
}

function place(nodes: LayoutNode[], links: Link[], rankdir: "LR" | "TB"): Layout {
  const { g } = runDagre(nodes, links, rankdir);
  const placed = nodes.map((n) => {
    const d = g.node(n.id);
    return { ...n, x: (d.x ?? 0) - n.width / 2, y: (d.y ?? 0) - n.height / 2 };
  });
  const byId = new Map(placed.map((n) => [n.id, n]));
  const loopCount = new Map<string, number>();

  const edges: LayoutEdge[] = links.map((l, i) => {
    const a = byId.get(l.from)!;
    const b = byId.get(l.to)!;
    let interior: Point[] = [];
    if (a !== b) {
      // dagre returns [border, ...one point per rank crossed, border]. An edge between
      // adjacent ranks has a single mid point that only adds a detour; longer edges keep
      // theirs so they pass between the tables of the ranks in between.
      const pts = g.edge(l.to, l.from, `e${i}`)?.points ?? [];
      interior = pts.length > 3 ? pts.slice(1, -1).reverse() : [];
    }
    // Loops and brackets on the same side get increasing offsets so they don't overlap.
    const bracketed = a === b || overlapsX(a, b);
    const loopKey = a === b ? a.id : [a.id, b.id].sort().join("|");
    const k = bracketed ? (loopCount.get(loopKey) ?? 0) : 0;
    if (bracketed) loopCount.set(loopKey, k + 1);
    const points = route(l, a, b, interior, k);
    return { id: `e${i}`, kind: l.kind, from: l.from, to: l.to, fromRow: l.fromRow, toRow: l.toRow, points };
  });

  // Normalize to a MARGIN around everything that is drawn (loops can stick out).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of placed) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  for (const e of edges) {
    for (const p of e.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  const dx = MARGIN - minX;
  const dy = MARGIN - minY;
  return {
    direction: rankdir,
    width: round(maxX - minX + 2 * MARGIN),
    height: round(maxY - minY + 2 * MARGIN),
    nodes: placed.map((n) => ({ ...n, x: round(n.x + dx), y: round(n.y + dy) })),
    edges: edges.map((e) => ({ ...e, points: e.points.map((p) => ({ x: round(p.x + dx), y: round(p.y + dy) })) })),
  };
}

/**
 * Lays the schema out left-to-right (referenced tables on the left); switches to
 * top-to-bottom when the LR result is much wider than tall.
 */
export function layoutSchema(schema: Schema): Layout {
  const nodes = schema.tables.map((t, i) => sizeTable(`n${i}`, t, i));
  const links = collectLinks(schema, nodes);
  const lr = place(nodes, links, "LR");
  if (lr.width / Math.max(lr.height, 1) <= TB_ASPECT_THRESHOLD) return lr;
  return place(nodes, links, "TB");
}
