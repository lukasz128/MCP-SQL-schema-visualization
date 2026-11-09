import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSchema } from "../src/parser.js";
import { splitStatements } from "../src/split.js";
import { SchemaError } from "../src/errors.js";
import type { Schema } from "../src/model.js";

const fixtures = join(import.meta.dirname, "fixtures");
const pg = (sql: string): Schema => parseSchema(splitStatements(sql), "PostgreSQL");

describe("parseSchema — PostgreSQL fixture", () => {
  it("maps test/fixtures/postgresql.sql to the expected model", () => {
    const sql = readFileSync(join(fixtures, "postgresql.sql"), "utf8");
    const expected = JSON.parse(readFileSync(join(fixtures, "postgresql.expected.json"), "utf8"));
    expect(pg(sql)).toEqual(expected);
  });
});

describe("parseSchema — CREATE TABLE", () => {
  it("reads types with length, precision and arrays", () => {
    const { tables } = pg("CREATE TABLE t (a VARCHAR(20), b NUMERIC(8,3), c INT[], d TIMESTAMP)");
    expect(tables[0]!.columns.map((c) => c.type)).toEqual(["VARCHAR(20)", "NUMERIC(8,3)", "INT[]", "TIMESTAMP"]);
  });

  it("reads NOT NULL, DEFAULT and inline keys", () => {
    const { tables } = pg("CREATE TABLE t (id INT PRIMARY KEY, e TEXT NOT NULL UNIQUE, n INT DEFAULT 42, s TEXT DEFAULT 'x')");
    expect(tables[0]).toMatchObject({
      primaryKey: ["id"],
      columns: [
        { name: "id", nullable: false, isPrimaryKey: true },
        { name: "e", nullable: false, unique: true },
        { name: "n", nullable: true, default: "42" },
        { name: "s", default: "'x'" },
      ],
    });
  });

  it("reads table-level PRIMARY KEY, UNIQUE and FOREIGN KEY", () => {
    const { tables } = pg(
      "CREATE TABLE p (id INT); CREATE TABLE t (a INT, b INT, c INT, PRIMARY KEY (a, b), UNIQUE (c), CONSTRAINT t_fk FOREIGN KEY (c) REFERENCES p (id))",
    );
    const t = tables[1]!;
    expect(t.primaryKey).toEqual(["a", "b"]);
    expect(t.columns.map((c) => [c.isPrimaryKey, c.unique])).toEqual([[true, false], [true, false], [false, true]]);
    expect(t.foreignKeys).toEqual([{ name: "t_fk", columns: ["c"], refTable: "p", refColumns: ["id"] }]);
  });

  it("keeps schema-qualified names", () => {
    const { tables } = pg("CREATE TABLE app.users (id INT, org INT REFERENCES core.orgs (id))");
    expect(tables[0]).toMatchObject({ name: "users", schema: "app", foreignKeys: [{ refTable: "orgs", refSchema: "core" }] });
  });

  it("keeps quoted identifiers as written", () => {
    const { tables } = pg('CREATE TABLE "Order Items" ("Id" INT PRIMARY KEY)');
    expect(tables[0]).toMatchObject({ name: "Order Items", primaryKey: ["Id"] });
  });

  it("keeps an FK to a table that is never defined", () => {
    const { tables } = pg("CREATE TABLE t (x INT REFERENCES elsewhere (id))");
    expect(tables[0]!.foreignKeys).toEqual([{ columns: ["x"], refTable: "elsewhere", refColumns: ["id"] }]);
  });

  it("warns about and keeps the first of two tables with the same name", () => {
    const { tables, warnings } = pg("CREATE TABLE t (a INT);\nCREATE TABLE t (b INT);");
    expect(tables).toHaveLength(1);
    expect(tables[0]!.columns[0]!.name).toBe("a");
    expect(warnings[0]).toMatchObject({ line: 2, message: expect.stringMatching(/defined twice/) });
  });
});

describe("parseSchema — ALTER TABLE", () => {
  it("adds a foreign key to an already-defined table", () => {
    const { tables } = pg(
      "CREATE TABLE a (id INT PRIMARY KEY); CREATE TABLE b (a_id INT);\nALTER TABLE b ADD CONSTRAINT b_a FOREIGN KEY (a_id) REFERENCES a (id);",
    );
    expect(tables[1]!.foreignKeys).toEqual([{ name: "b_a", columns: ["a_id"], refTable: "a", refColumns: ["id"] }]);
  });

  it("adds a primary key and a column", () => {
    const { tables } = pg("CREATE TABLE a (id INT); ALTER TABLE ONLY a ADD CONSTRAINT a_pk PRIMARY KEY (id); ALTER TABLE a ADD COLUMN n TEXT NOT NULL;");
    expect(tables[0]).toMatchObject({ primaryKey: ["id"], columns: [{ name: "id", isPrimaryKey: true }, { name: "n", nullable: false }] });
  });

  it("warns when the altered table is unknown", () => {
    const { warnings } = pg("CREATE TABLE a (id INT);\nALTER TABLE b ADD CONSTRAINT x FOREIGN KEY (id) REFERENCES a (id);");
    expect(warnings).toEqual([{ line: 2, message: expect.stringMatching(/^ALTER TABLE b: /) }]);
  });
});

describe("parseSchema — CREATE VIEW", () => {
  it("maps columns as written and collects source tables", () => {
    const { tables } = pg(
      "CREATE TABLE a (id INT); CREATE TABLE s.b (a_id INT);\n" +
        "CREATE VIEW v AS SELECT a.id, b.a_id AS ref, count(*) AS n, b.* FROM a JOIN s.b b ON b.a_id = a.id GROUP BY a.id, b.a_id",
    );
    const v = tables[2]!;
    expect(v).toMatchObject({ name: "v", kind: "view", sources: ["a", "s.b"], primaryKey: [], foreignKeys: [] });
    expect(v.columns.map((c) => [c.name, c.type])).toEqual([
      ["id", "a.id"],
      ["ref", "b.a_id"],
      ["n", "COUNT(*)"],
      ["b.*", ""],
    ]);
  });

  it("does not count CTEs or subquery aliases as sources", () => {
    const { tables } = pg("CREATE VIEW v AS WITH x AS (SELECT id FROM a) SELECT * FROM x JOIN (SELECT id FROM c) sub ON true");
    expect(tables[0]!.sources).toEqual(["a", "c"]);
  });
});

describe("parseSchema — skipping and errors", () => {
  it("ignores statements that are not schema DDL", () => {
    const { tables, warnings } = pg(
      "CREATE TABLE a (id INT); INSERT INTO a VALUES (1); CREATE INDEX i ON a (id); COMMENT ON TABLE a IS 'x';",
    );
    expect(tables).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("turns an unparsable statement into a warning with its line and column", () => {
    const { tables, warnings } = pg("CREATE TABLE a (id INT);\n\nCREATE TABLE b (\n  id INT,\n  x BLAH BLAH\n);");
    expect(tables.map((t) => t.name)).toEqual(["a"]);
    expect(warnings).toEqual([{ line: 5, column: 10, message: expect.stringMatching(/^Skipped `CREATE TABLE b \(`/) }]);
  });

  it("throws NO_TABLES with the first parse error when nothing is found", () => {
    let err: unknown;
    try {
      pg("SELECT 1;\nCREATE TABLE b (x BLAH BLAH);");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SchemaError);
    expect(err).toMatchObject({ code: "NO_TABLES", line: 2, column: 24 });
    expect((err as Error).message).toMatch(/No tables found in the PostgreSQL DDL\. First parse error at line 2, column 24/);
  });

  it("throws NO_TABLES without detail when everything parsed but nothing was a table", () => {
    expect(() => pg("INSERT INTO a VALUES (1)")).toThrow(/^No tables found in the PostgreSQL DDL\.$/);
  });
});
