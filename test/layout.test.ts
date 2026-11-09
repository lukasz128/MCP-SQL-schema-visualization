import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEADER_HEIGHT, ROW_HEIGHT, layoutSchema, rowCenterY, textCells, type Layout, type LayoutNode } from "../src/layout.js";
import { parseSchema } from "../src/parser.js";
import { splitStatements } from "../src/split.js";
import type { Schema } from "../src/model.js";

const pg = (sql: string): Schema => parseSchema(splitStatements(sql), "PostgreSQL");
const fixture = readFileSync(join(import.meta.dirname, "fixtures", "postgresql.sql"), "utf8");

const node = (l: Layout, label: string): LayoutNode => {
  const n = l.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}`);
  return n;
};
const overlap = (a: LayoutNode, b: LayoutNode) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("layoutSchema — PostgreSQL fixture", () => {
  const schema = pg(fixture);
  const layout = layoutSchema(schema);

  it("has one node per table and view, no placeholders", () => {
    expect(layout.nodes.map((n) => n.label)).toEqual(schema.tables.map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name)));
    expect(layout.nodes.some((n) => n.placeholder)).toBe(false);
  });

  it("places no two nodes on top of each other", () => {
    for (const [i, a] of layout.nodes.entries()) {
      for (const b of layout.nodes.slice(i + 1)) expect(overlap(a, b)).toBe(false);
    }
  });

  it("keeps everything inside the reported bounds", () => {
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.width).toBeLessThanOrEqual(layout.width);
      expect(n.y + n.height).toBeLessThanOrEqual(layout.height);
    }
    for (const p of layout.edges.flatMap((e) => e.points)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(layout.width);
      expect(p.y).toBeLessThanOrEqual(layout.height);
    }
  });

  it("draws one FK edge per column pair (composite FK → two edges)", () => {
    const fks = layout.edges.filter((e) => e.kind === "fk");
    expect(fks).toHaveLength(schema.tables.reduce((n, t) => n + t.foreignKeys.reduce((m, fk) => m + fk.columns.length, 0), 0));
    const shipments = node(layout, "shipments");
    const items = node(layout, "order_items");
    const pairs = fks.filter((e) => e.from === shipments.id && e.to === items.id).map((e) => [e.fromRow, e.toRow]);
    expect(pairs).toEqual([[1, 0], [2, 1]]);
  });

  it("anchors FK edges on the exact column rows, on facing sides", () => {
    const orders = node(layout, "orders");
    const customers = node(layout, "public.customers");
    const e = layout.edges.find((x) => x.from === orders.id && x.to === customers.id)!;
    const start = e.points[0]!;
    const end = e.points.at(-1)!;
    expect(start.y).toBe(rowCenterY(orders, 1)); // orders.customer_id
    expect(end.y).toBe(rowCenterY(customers, 0)); // customers.id
    // customers is referenced, so it ranks left of orders.
    expect(customers.x + customers.width).toBeLessThan(orders.x);
    expect(start.x).toBe(orders.x);
    expect(end.x).toBe(customers.x + customers.width);
  });

  it("routes a self-reference as a loop on the right side", () => {
    const cat = node(layout, "categories");
    const loop = layout.edges.find((e) => e.from === cat.id && e.to === cat.id)!;
    expect(loop.points).toHaveLength(4);
    expect(loop.points[0]).toEqual({ x: cat.x + cat.width, y: rowCenterY(cat, 1) });
    expect(loop.points[3]).toEqual({ x: cat.x + cat.width, y: rowCenterY(cat, 0) });
    expect(loop.points[1]!.x).toBeGreaterThan(cat.x + cat.width);
  });

  it("links the view to each source table at the headers", () => {
    const view = node(layout, "order_totals");
    const viewEdges = layout.edges.filter((e) => e.kind === "view");
    expect(viewEdges.every((e) => e.from === view.id && e.fromRow === -1 && e.toRow === -1)).toBe(true);
    expect(viewEdges.map((e) => layout.nodes.find((n) => n.id === e.to)!.label).sort()).toEqual(
      ["order_items", "orders", "products", "public.customers"],
    );
  });

  it("is deterministic", () => {
    expect(layoutSchema(pg(fixture))).toEqual(layout);
  });
});

describe("layoutSchema — sizing and edge cases", () => {
  it("sizes nodes from header and rows", () => {
    const l = layoutSchema(pg("CREATE TABLE t (id INT PRIMARY KEY, a_rather_long_column_name VARCHAR(255))"));
    const n = l.nodes[0]!;
    expect(n.height).toBe(HEADER_HEIGHT + 2 * ROW_HEIGHT);
    expect(n.typeX).toBeGreaterThan(n.nameX + "a_rather_long_column_name".length * 7.2 - 0.1);
    expect(n.width).toBeGreaterThan(n.typeX + "VARCHAR(255)".length * 7.2);
    expect(n.markers).toEqual(["PK", ""]);
  });

  it("counts wide characters as two cells", () => {
    expect(textCells("abc")).toBe(3);
    expect(textCells("顧客")).toBe(4);
  });

  it("adds a dashed placeholder for an undefined referenced table", () => {
    const l = layoutSchema(pg("CREATE TABLE t (id INT, org_id INT REFERENCES core.orgs (id))"));
    const ph = l.nodes.find((n) => n.placeholder)!;
    expect(ph).toMatchObject({ label: "core.orgs", kind: "placeholder", height: HEADER_HEIGHT });
    expect(l.edges[0]).toMatchObject({ from: "n0", to: ph.id, fromRow: 1, toRow: -1 });
    expect(l.edges[0]!.points.at(-1)!.y).toBe(ph.y + HEADER_HEIGHT / 2);
  });

  it("resolves REFERENCES without columns to the target's primary key", () => {
    const schema = pg("CREATE TABLE p (code TEXT, id INT PRIMARY KEY); CREATE TABLE c (p_id INT)");
    schema.tables[1]!.foreignKeys.push({ columns: ["p_id"], refTable: "p", refColumns: [] });
    expect(layoutSchema(schema).edges[0]).toMatchObject({ fromRow: 0, toRow: 1 });
  });

  it("keeps two FKs between the same tables as separate edges", () => {
    const l = layoutSchema(
      pg("CREATE TABLE u (id INT PRIMARY KEY); CREATE TABLE m (from_id INT REFERENCES u (id), to_id INT REFERENCES u (id))"),
    );
    expect(l.edges.map((e) => [e.fromRow, e.toRow])).toEqual([[0, 0], [1, 0]]);
  });

  it("lays out tables without relationships", () => {
    const l = layoutSchema(pg("CREATE TABLE a (id INT); CREATE TABLE b (id INT); CREATE TABLE c (id INT)"));
    expect(l.nodes).toHaveLength(3);
    expect(l.edges).toHaveLength(0);
    expect(overlap(l.nodes[0]!, l.nodes[1]!) || overlap(l.nodes[1]!, l.nodes[2]!)).toBe(false);
  });

  it("switches to top-to-bottom for a long chain", () => {
    const sql = Array.from({ length: 12 }, (_, i) =>
      i === 0 ? "CREATE TABLE t0 (id INT PRIMARY KEY)" : `CREATE TABLE t${i} (id INT PRIMARY KEY, p INT REFERENCES t${i - 1} (id))`,
    ).join(";\n");
    expect(layoutSchema(pg(sql)).direction).toBe("TB");
    expect(layoutSchema(pg("CREATE TABLE a (id INT PRIMARY KEY); CREATE TABLE b (a INT REFERENCES a (id))")).direction).toBe("LR");
  });
});
