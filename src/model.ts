// The schema model: the only shape that leaves parser.ts. Types only.

export interface Column {
  name: string;
  /** Data type as written, e.g. `VARCHAR(255)`. For view columns: the source expression, or "" when it equals the name. */
  type: string;
  nullable: boolean;
  default?: string;
  unique: boolean;
  isPrimaryKey: boolean;
}

export interface ForeignKey {
  name?: string;
  columns: string[];
  refTable: string;
  refSchema?: string;
  /** Empty when the DDL omits them (`REFERENCES users`): the referenced table's primary key is meant. */
  refColumns: string[];
}

export interface Table {
  name: string;
  schema?: string;
  kind: "table" | "view";
  columns: Column[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  /** Views only: referenced tables, schema-qualified when the DDL qualifies them. */
  sources?: string[];
}

export interface Warning {
  message: string;
  line?: number;
  column?: number;
}

export interface Schema {
  tables: Table[];
  warnings: Warning[];
}

export const DIALECTS = [
  "PostgreSQL",
  "MySQL",
  "MariaDB",
  "SQLite",
  "TransactSQL",
  "BigQuery",
] as const;

export type Dialect = (typeof DIALECTS)[number];
