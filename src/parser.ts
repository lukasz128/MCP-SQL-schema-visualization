// node-sql-parser AST → schema model. The AST never leaves this file.
import nsp from "node-sql-parser";
import { SchemaError } from "./errors.js";
import type { Column, Dialect, ForeignKey, Schema, Table, Warning } from "./model.js";
import type { Statement } from "./split.js";

// The AST is loosely typed and its shape varies by dialect and parser version
// (see test/ast-samples/), so it is read through small defensive accessors.
type Node = any;

const parser = new nsp.Parser();

interface ParseFailure {
  message: string;
  line?: number;
  column?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Identifier text from the forms the AST uses: a string, `{ value }`, or `{ expr: { value } }`. */
function ident(v: Node): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v.value === "string") return v.value;
  if (v.expr != null) return ident(v.expr);
  return undefined;
}

/** Column name of a `column_ref` node. */
function columnName(ref: Node): string | undefined {
  if (ref == null) return undefined;
  if (ref.type === "column_ref") return ident(ref.column);
  return ident(ref);
}

function columnNames(list: Node): string[] {
  if (!Array.isArray(list)) return [];
  return list.map(columnName).filter((n): n is string => n !== undefined);
}

function tableRef(list: Node): { name: string; schema?: string } | undefined {
  const t = Array.isArray(list) ? list[0] : list;
  const name = ident(t?.table);
  if (!name) return undefined;
  const schema = ident(t.db) ?? ident(t.schema);
  return schema ? { name, schema } : { name };
}

function qualified(name: string, schema?: string): string {
  return schema ? `${schema}.${name}` : name;
}

/** Drops the quotes `sqlify` puts around plain identifiers (`"o".id` → `o.id`), leaving string literals alone. */
function unquoteIdentifiers(sql: string): string {
  return sql
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "$1")))
    .join("");
}

/** An expression as SQL text, via the parser's own printer. */
function exprText(expr: Node, database: Dialect): string {
  if (expr == null) return "";
  try {
    const select: Node = { type: "select", columns: [{ expr, as: null }], from: null };
    const sql = parser.sqlify(select, { database });
    return unquoteIdentifiers(sql.replace(/^SELECT\s+/i, ""));
  } catch {
    return typeof expr.value === "string" || typeof expr.value === "number" ? String(expr.value) : "?";
  }
}

function formatType(def: Node): string {
  const base = str(def?.dataType) ?? "";
  let type = base;
  if (def?.length != null && def.length !== "") {
    type += def.scale != null ? `(${def.length},${def.scale})` : `(${def.length})`;
  } else if (Array.isArray(def?.expr?.value) && def.expr.value.length > 0) {
    // e.g. ENUM('a','b') or DECIMAL written with an expression list
    type += `(${def.expr.value.map((v: Node) => (v?.type === "single_quote_string" ? `'${v.value}'` : String(v?.value ?? ""))).join(",")})`;
  }
  const suffix = Array.isArray(def?.suffix) ? def.suffix.filter((s: unknown) => typeof s === "string") : [];
  if (suffix.length) type += ` ${suffix.join(" ").toUpperCase()}`;
  const dims = def?.array?.dimension;
  if (typeof dims === "number" && dims > 0) type += "[]".repeat(dims);
  return type;
}

function isConstraintType(def: Node, kind: "primary key" | "unique" | "foreign key"): boolean {
  const t = str(def?.constraint_type)?.toLowerCase() ?? "";
  if (kind === "unique") return t.startsWith("unique");
  return t === kind;
}

function referenceToFk(columns: string[], ref: Node, name?: string): ForeignKey | undefined {
  const target = tableRef(ref?.table);
  if (!target) return undefined;
  const fk: ForeignKey = { columns, refTable: target.name, refColumns: columnNames(ref.definition) };
  if (target.schema) fk.refSchema = target.schema;
  if (name) fk.name = name;
  return fk;
}

function findColumn(table: Table, name: string): Column | undefined {
  return (
    table.columns.find((c) => c.name === name) ??
    table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase())
  );
}

function markPrimaryKey(table: Table, names: string[]): void {
  for (const n of names) {
    if (!table.primaryKey.includes(n)) table.primaryKey.push(n);
    const col = findColumn(table, n);
    if (col) {
      col.isPrimaryKey = true;
      col.nullable = false;
    }
  }
}

/** Applies one table-level constraint (from CREATE TABLE or ALTER TABLE ADD). */
function applyConstraint(table: Table, def: Node): void {
  const cols = columnNames(def.definition);
  const name = str(def.constraint) ?? undefined;
  if (isConstraintType(def, "primary key")) {
    markPrimaryKey(table, cols);
  } else if (isConstraintType(def, "unique")) {
    if (cols.length === 1) {
      const col = findColumn(table, cols[0]!);
      if (col) col.unique = true;
    }
  } else if (isConstraintType(def, "foreign key")) {
    const fk = referenceToFk(cols, def.reference_definition, name);
    if (fk) table.foreignKeys.push(fk);
  }
}

function columnFromDefinition(def: Node, database: Dialect): { column: Column; fk?: ForeignKey } | undefined {
  const name = columnName(def.column);
  if (!name) return undefined;
  const isPrimaryKey = Boolean(def.primary_key);
  const notNull = str(def.nullable?.type)?.toLowerCase() === "not null";
  const column: Column = {
    name,
    type: formatType(def.definition),
    nullable: !(notNull || isPrimaryKey),
    unique: Boolean(def.unique),
    isPrimaryKey,
  };
  if (def.default_val?.value != null) column.default = exprText(def.default_val.value, database);
  const fk = def.reference_definition ? referenceToFk([name], def.reference_definition) : undefined;
  return fk ? { column, fk } : { column };
}

function createTable(ast: Node, database: Dialect): Table | undefined {
  const ref = tableRef(ast.table);
  if (!ref) return undefined;
  const table: Table = { name: ref.name, kind: "table", columns: [], primaryKey: [], foreignKeys: [] };
  if (ref.schema) table.schema = ref.schema;

  const defs: Node[] = Array.isArray(ast.create_definitions) ? ast.create_definitions : [];
  for (const def of defs) {
    if (def?.resource !== "column") continue;
    const mapped = columnFromDefinition(def, database);
    if (!mapped) continue;
    table.columns.push(mapped.column);
    if (mapped.column.isPrimaryKey) table.primaryKey.push(mapped.column.name);
    if (mapped.fk) table.foreignKeys.push(mapped.fk);
  }
  for (const def of defs) {
    if (def?.resource === "constraint") applyConstraint(table, def);
  }
  return table;
}

/** Table names a SELECT reads from, including joins, subqueries and set operations. */
function selectSources(select: Node, ctes: Set<string>, out: string[]): void {
  if (select == null) return;
  for (const cte of Array.isArray(select.with) ? select.with : []) {
    const name = ident(cte?.name);
    if (name) ctes.add(name.toLowerCase());
    selectSources(cte?.stmt?.ast ?? cte?.stmt, ctes, out);
  }
  for (const item of Array.isArray(select.from) ? select.from : []) {
    const name = ident(item?.table);
    if (name && item?.expr == null) {
      if (!ctes.has(name.toLowerCase())) {
        const q = qualified(name, ident(item.db) ?? undefined);
        if (!out.includes(q)) out.push(q);
      }
    } else if (item?.expr?.ast) {
      selectSources(item.expr.ast, ctes, out);
    }
  }
  if (select._next) selectSources(select._next, ctes, out);
}

function viewColumn(col: Node, database: Dialect): Column {
  const expr = col?.expr;
  const alias = ident(col?.as);
  let derived: string;
  if (expr?.type === "column_ref" && (expr.column === "*" || ident(expr.column) === "*")) {
    const qualifier = ident(expr.table);
    derived = qualifier ? `${qualifier}.*` : "*";
  } else if (expr?.type === "column_ref") {
    derived = ident(expr.column) ?? exprText(expr, database);
  } else {
    derived = exprText(expr, database);
  }
  const name = alias ?? derived;
  const source = exprText(expr, database);
  const type = alias !== undefined || source !== name ? source : "";
  return { name, type: type === name ? "" : type, nullable: false, unique: false, isPrimaryKey: false };
}

function createView(ast: Node, database: Dialect): Table | undefined {
  const name = ident(ast.view?.view) ?? ident(ast.view);
  if (!name) return undefined;
  const select = ast.select ?? ast.query_expr;
  const cols: Node[] = Array.isArray(select?.columns) ? select.columns : [];
  const table: Table = {
    name,
    kind: "view",
    columns: select?.columns === "*" ? [{ name: "*", type: "", nullable: false, unique: false, isPrimaryKey: false }] : cols.map((c) => viewColumn(c, database)),
    primaryKey: [],
    foreignKeys: [],
    sources: [],
  };
  const schema = ident(ast.view?.db);
  if (schema) table.schema = schema;
  selectSources(select, new Set(), table.sources!);
  return table;
}

function keyOf(name: string, schema?: string): string {
  return qualified(name, schema).toLowerCase();
}

function firstLine(text: string): string {
  const code = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("--")) ?? text.trim();
  return code.length > 60 ? `${code.slice(0, 57)}...` : code;
}

function shortParserMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Peggy messages list every expected token; keep only what was found.
  const found = /but (.+) found\.?$/.exec(msg);
  if (found) return `unexpected ${found[1]}`;
  return msg.length > 120 ? `${msg.slice(0, 117)}...` : msg;
}

function failurePosition(e: Node, stmt: Statement): { line?: number; column?: number } {
  const loc = e?.location?.start;
  if (typeof loc?.line !== "number") return { line: stmt.startLine };
  const line = stmt.startLine + loc.line - 1;
  const column = loc.line === 1 ? stmt.startColumn + loc.column - 1 : loc.column;
  return { line, column };
}

/**
 * Parses each statement on its own; failures become warnings so one unsupported
 * statement (CREATE TYPE, a function body, …) does not lose the rest of the schema.
 */
export function parseSchema(statements: Statement[], dialect: Dialect): Schema {
  const tables: Table[] = [];
  const byKey = new Map<string, Table>();
  const warnings: Warning[] = [];
  let firstFailure: ParseFailure | undefined;

  const warn = (message: string, pos: { line?: number; column?: number }) => {
    const w: Warning = { message };
    if (pos.line !== undefined) w.line = pos.line;
    if (pos.column !== undefined) w.column = pos.column;
    warnings.push(w);
  };

  const add = (table: Table, stmt: Statement) => {
    const key = keyOf(table.name, table.schema);
    if (byKey.has(key)) {
      warn(`${qualified(table.name, table.schema)} is defined twice; kept the first definition.`, { line: stmt.startLine });
      return;
    }
    byKey.set(key, table);
    tables.push(table);
  };

  const lookup = (name: string, schema?: string): Table | undefined =>
    byKey.get(keyOf(name, schema)) ?? (schema ? undefined : tables.find((t) => t.name.toLowerCase() === name.toLowerCase()));

  for (const stmt of statements) {
    let asts: Node[];
    try {
      const result = parser.astify(stmt.text, { database: dialect });
      asts = Array.isArray(result) ? result : [result];
    } catch (e) {
      const pos = failurePosition(e, stmt);
      const reason = shortParserMessage(e);
      warn(`Skipped \`${firstLine(stmt.text)}\` (${reason}).`, pos);
      firstFailure ??= { message: `${reason} in \`${firstLine(stmt.text)}\``, ...pos };
      continue;
    }

    for (const ast of asts) {
      if (ast?.type === "create" && str(ast.keyword)?.toLowerCase() === "table") {
        const table = createTable(ast, dialect);
        if (table) add(table, stmt);
      } else if (ast?.type === "create" && str(ast.keyword)?.toLowerCase() === "view") {
        const view = createView(ast, dialect);
        if (view) add(view, stmt);
      } else if (ast?.type === "alter" && str(ast.keyword ?? "table")?.toLowerCase() === "table") {
        const ref = tableRef(ast.table);
        if (!ref) continue;
        const table = lookup(ref.name, ref.schema);
        if (!table) {
          warn(`ALTER TABLE ${qualified(ref.name, ref.schema)}: table is not defined before this statement; skipped.`, { line: stmt.startLine });
          continue;
        }
        for (const action of Array.isArray(ast.expr) ? ast.expr : []) {
          if (str(action?.action)?.toLowerCase() !== "add") continue;
          if (action.resource === "constraint" && action.create_definitions) {
            applyConstraint(table, action.create_definitions);
          } else if (action.resource === "column") {
            const mapped = columnFromDefinition(action, dialect);
            if (mapped) {
              table.columns.push(mapped.column);
              if (mapped.column.isPrimaryKey) table.primaryKey.push(mapped.column.name);
              if (mapped.fk) table.foreignKeys.push(mapped.fk);
            }
          }
        }
      }
      // Everything else (INSERT, CREATE INDEX, COMMENT ON, …) is ignored on purpose.
    }
  }

  if (tables.length === 0) {
    const detail = firstFailure
      ? ` First parse error${firstFailure.line ? ` at line ${firstFailure.line}${firstFailure.column ? `, column ${firstFailure.column}` : ""}` : ""}: ${firstFailure.message}.`
      : "";
    throw new SchemaError("NO_TABLES", `No tables found in the ${dialect} DDL.${detail}`, firstFailure ?? {});
  }

  return { tables, warnings };
}
