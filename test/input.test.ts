import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { DEFAULT_MAX_BYTES, maxInputBytes, resolveInput } from "../src/input.js";
import { SchemaError } from "../src/errors.js";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sqlviz-input-"));
  writeFileSync(join(dir, "ok.sql"), "CREATE TABLE a (id int);");
  writeFileSync(join(dir, "bom.sql"), "﻿CREATE TABLE a (id int);");
  writeFileSync(join(dir, "empty.sql"), "  \n");
  writeFileSync(join(dir, "latin1.sql"), Buffer.from([0x2d, 0x2d, 0x20, 0xe9, 0x0a]));
  writeFileSync(join(dir, "big.sql"), "x".repeat(200));
  mkdirSync(join(dir, "folder.sql"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveInput", () => {
  it("returns sql as-is", async () => {
    expect(await resolveInput({ sql: "CREATE TABLE a (id int)" })).toEqual({ sql: "CREATE TABLE a (id int)" });
  });

  it("reads an absolute filePath", async () => {
    const path = join(dir, "ok.sql");
    expect(await resolveInput({ filePath: path })).toEqual({ sql: "CREATE TABLE a (id int);", path });
  });

  it("resolves a relative filePath against cwd", async () => {
    const r = await resolveInput({ filePath: "ok.sql" }, { cwd: dir });
    expect(r.path).toBe(join(dir, "ok.sql"));
  });

  it("strips a UTF-8 BOM", async () => {
    expect((await resolveInput({ filePath: join(dir, "bom.sql") })).sql).toBe("CREATE TABLE a (id int);");
  });

  it.each([
    ["neither argument", {}, /Pass the DDL as `sql`/],
    ["both arguments", { sql: "x", filePath: "y.sql" }, /not both/],
  ])("rejects %s", async (_name, args, message) => {
    await expect(resolveInput(args)).rejects.toThrow(message);
    await expect(resolveInput(args)).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });

  it.each([
    ["a missing file", "nope.sql", /File not found/],
    ["a directory", "folder.sql", /is a directory/],
    ["a non-UTF-8 file", "latin1.sql", /not valid UTF-8/],
    ["an empty file", "empty.sql", /is empty/],
  ])("rejects %s", async (_name, file, message) => {
    const p = resolveInput({ filePath: join(dir, file) });
    await expect(p).rejects.toThrow(message);
    await expect(resolveInput({ filePath: join(dir, file) })).rejects.toMatchObject({ code: "INPUT" });
  });

  it("rejects an empty sql string", async () => {
    await expect(resolveInput({ sql: "   " })).rejects.toThrow(/is empty/);
  });

  it("rejects input over the size cap", async () => {
    await expect(resolveInput({ filePath: join(dir, "big.sql") }, { maxBytes: 100 })).rejects.toThrow(/over the 100 bytes limit/);
    await expect(resolveInput({ sql: "y".repeat(101) }, { maxBytes: 100 })).rejects.toThrow(SchemaError);
  });
});

describe("maxInputBytes", () => {
  it("defaults to 2 MB", () => {
    expect(maxInputBytes({})).toBe(DEFAULT_MAX_BYTES);
    expect(DEFAULT_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it("reads SQL_VIZ_MAX_BYTES", () => {
    expect(maxInputBytes({ SQL_VIZ_MAX_BYTES: "5000" })).toBe(5000);
  });

  it.each(["abc", "-1", "0", "1.5"])("ignores an invalid value %j", (v) => {
    expect(maxInputBytes({ SQL_VIZ_MAX_BYTES: v })).toBe(DEFAULT_MAX_BYTES);
  });
});
