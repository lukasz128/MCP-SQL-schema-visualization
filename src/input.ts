import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { SchemaError } from "./errors.js";

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface InputArgs {
  sql?: string | undefined;
  filePath?: string | undefined;
}

export interface ResolvedInput {
  sql: string;
  /** Absolute path when the SQL came from a file. */
  path?: string;
}

export interface InputOptions {
  cwd?: string;
  maxBytes?: number;
}

/** Size cap from `SQL_VIZ_MAX_BYTES` (a positive integer of bytes), else 10 MB. */
export function maxInputBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SQL_VIZ_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${+(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KB`;
  return `${n} bytes`;
}

function tooLarge(size: number, max: number): SchemaError {
  return new SchemaError(
    "INPUT",
    `Input is ${formatBytes(size)}, over the ${formatBytes(max)} limit (set SQL_VIZ_MAX_BYTES to raise it).`,
  );
}

function ensureNotEmpty(sql: string, what: string): string {
  if (sql.trim() === "") throw new SchemaError("INPUT", `${what} is empty.`);
  return sql;
}

/** Returns `sql` as-is, or reads `filePath` (UTF-8, size-capped). Exactly one must be given. */
export async function resolveInput(
  args: InputArgs,
  options: InputOptions = {},
): Promise<ResolvedInput> {
  const maxBytes = options.maxBytes ?? maxInputBytes();
  const hasSql = typeof args.sql === "string";
  const hasPath = typeof args.filePath === "string" && args.filePath !== "";

  if (hasSql === hasPath) {
    throw new SchemaError(
      "INVALID_ARGS",
      hasSql
        ? "Pass either `sql` or `filePath`, not both."
        : "Pass the DDL as `sql`, or a path to a .sql file as `filePath`.",
    );
  }

  if (hasSql) {
    const sql = args.sql as string;
    const size = Buffer.byteLength(sql, "utf8");
    if (size > maxBytes) throw tooLarge(size, maxBytes);
    return { sql: ensureNotEmpty(sql, "`sql`") };
  }

  const path = resolve(options.cwd ?? process.cwd(), args.filePath as string);
  let info;
  try {
    info = await stat(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new SchemaError("INPUT", `File not found: ${path}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new SchemaError("INPUT", `Permission denied reading ${path}`);
    }
    throw new SchemaError(
      "INPUT",
      `Cannot read ${path}: ${(e as Error).message}`,
    );
  }
  if (info.isDirectory()) {
    throw new SchemaError("INPUT", `${path} is a directory, not a .sql file.`);
  }
  if (!info.isFile()) {
    throw new SchemaError("INPUT", `${path} is not a regular file.`);
  }
  if (info.size > maxBytes) throw tooLarge(info.size, maxBytes);

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (e) {
    throw new SchemaError(
      "INPUT",
      `Cannot read ${path}: ${(e as Error).message}`,
    );
  }
  let sql: string;
  try {
    sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SchemaError("INPUT", `${path} is not valid UTF-8 text.`);
  }
  // TextDecoder strips a leading BOM by default.
  return { sql: ensureNotEmpty(sql, `File ${path}`), path };
}
