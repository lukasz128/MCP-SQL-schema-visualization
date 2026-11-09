import { describe, expect, it } from "vitest";
import { splitStatements } from "../src/split.js";

const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

describe("splitStatements", () => {
  it("splits on semicolons and trims", () => {
    expect(texts("CREATE TABLE a (id int);\n\n  CREATE TABLE b (id int) ;")).toEqual([
      "CREATE TABLE a (id int)",
      "CREATE TABLE b (id int)",
    ]);
  });

  it("keeps a last statement without a semicolon", () => {
    expect(texts("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it.each([
    ["single-quoted string", "INSERT INTO t VALUES ('a;b')"],
    ["doubled quote inside string", "INSERT INTO t VALUES ('it''s;fine')"],
    ["E-string with backslash escape", "INSERT INTO t VALUES (E'a\\';b')"],
    ["double-quoted identifier", 'CREATE TABLE "a;b" (id int)'],
    ["backtick identifier", "CREATE TABLE `a;b` (id int)"],
    ["line comment", "CREATE TABLE a (id int -- not; here\n)"],
    ["block comment", "CREATE TABLE a (id int /* not; here */)"],
    ["nested block comment", "CREATE TABLE a (id int /* x /* y; */ z; */)"],
    ["$$ body", "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; SELECT 2; $$ LANGUAGE sql"],
    ["$tag$ body", "CREATE FUNCTION f() AS $body$ x; $$ y; $body$ LANGUAGE sql"],
  ])("does not split inside a %s", (_name, sql) => {
    expect(texts(`${sql}; SELECT 1`)).toEqual([sql, "SELECT 1"]);
  });

  it("does not treat $1 parameters as dollar quotes", () => {
    expect(texts("PREPARE p AS SELECT $1; SELECT 2")).toEqual(["PREPARE p AS SELECT $1", "SELECT 2"]);
  });

  it("treats a line with only GO as a separator", () => {
    const sql = "CREATE TABLE a (id int)\nGO\nCREATE TABLE b (id int)\n  go  \nCREATE TABLE c (id int)\nGO 2\n";
    expect(texts(sql)).toEqual([
      "CREATE TABLE a (id int)",
      "CREATE TABLE b (id int)",
      "CREATE TABLE c (id int)",
    ]);
  });

  it("does not treat GO inside a line or an identifier as a separator", () => {
    expect(texts("CREATE TABLE GOODS (id int);\nSELECT 1 GO")).toEqual([
      "CREATE TABLE GOODS (id int)",
      "SELECT 1 GO",
    ]);
  });

  it("drops comment-only and empty statements", () => {
    expect(texts("-- header\n;;\n/* nothing */;\nCREATE TABLE a (id int);\n-- trailer\n")).toEqual([
      "CREATE TABLE a (id int)",
    ]);
  });

  it("keeps a leading comment with its statement", () => {
    expect(texts("-- users\nCREATE TABLE u (id int);")).toEqual(["-- users\nCREATE TABLE u (id int)"]);
  });

  it("records each statement's start line and column", () => {
    const sql = "-- header\n\nCREATE TABLE a (\n  id int\n);\n\n   CREATE TABLE b (id int);";
    expect(splitStatements(sql)).toEqual([
      { text: "-- header\n\nCREATE TABLE a (\n  id int\n)", startLine: 1, startColumn: 1 },
      { text: "CREATE TABLE b (id int)", startLine: 7, startColumn: 4 },
    ]);
  });

  it("counts lines inside strings, comments and dollar bodies", () => {
    const sql = "SELECT 'a\nb';\n/* x\ny */\nSELECT $$\n;\n$$;\nSELECT 3;";
    expect(splitStatements(sql).map((s) => s.startLine)).toEqual([1, 3, 8]);
  });

  it("returns nothing for whitespace-only input", () => {
    expect(splitStatements("  \n\t ")).toEqual([]);
  });
});
