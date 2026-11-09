import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runVisualize, visualizeInputSchema } from "../src/tool.js";

const fixture = join(import.meta.dirname, "fixtures", "postgresql.sql");

describe("runVisualize", () => {
  it("renders the fixture from a file path with an explicit dialect", async () => {
    const r = await runVisualize({ filePath: fixture, dialect: "PostgreSQL" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(1);
    expect(r.content[0]!.type).toBe("text");
    expect(r.content[0]!.text).toMatch(/^<!doctype html>/);
    expect(r.content[0]!.text).toContain("<h1>postgresql.sql</h1>");
    expect(r.content[0]!.text).toContain("Parsed as PostgreSQL (given)");
  });

  it("renders an SQL string; an omitted dialect falls back to PostgreSQL for now", async () => {
    const r = await runVisualize({ sql: "CREATE TABLE a (id INT PRIMARY KEY)" });
    expect(r.content[0]!.text).toContain("<h1>Database schema</h1>");
    expect(r.content[0]!.text).toContain("Parsed as PostgreSQL (default)");
  });

  it.each([
    ["neither sql nor filePath", {}, /Pass the DDL as `sql`/],
    ["both sql and filePath", { sql: "x", filePath: fixture }, /not both/],
    ["a missing file", { filePath: "/definitely/not/here.sql" }, /File not found: \/definitely\/not\/here\.sql/],
    ["SQL without tables", { sql: "SELECT 1;\nCREATE TABLE b (x BLAH BLAH);" }, /No tables found .* line 2, column 24/],
  ])("returns isError for %s", async (_name, args, message) => {
    const r = await runVisualize(args);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(message);
  });
});

describe("visualizeInputSchema", () => {
  it("accepts the documented dialects only", () => {
    expect(visualizeInputSchema.safeParse({ sql: "x", dialect: "SQLite" }).success).toBe(true);
    expect(visualizeInputSchema.safeParse({ sql: "x", dialect: "Oracle" }).success).toBe(false);
  });

  it("leaves the exactly-one check to the handler", () => {
    expect(visualizeInputSchema.safeParse({}).success).toBe(true);
  });
});
