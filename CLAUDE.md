# MCP SQL Schema Visualization (TypeScript)

## Goal
An MCP server that takes SQL DDL — either a path to a `.sql` file or a raw SQL string — and returns a self-contained HTML page visualizing the schema (tables, columns, keys and the relationships between tables).

## Current state
- `src/index.ts` is still the MCP "weather" tutorial boilerplate (`get-alerts` tool, NWS API). It is a placeholder to be replaced with the schema-visualization tool.
- No build/start scripts yet in `package.json`.

## Stack
- TypeScript, ESM (`"type": "module"`), run with `tsx`
- `@modelcontextprotocol/server` v2 — `McpServer`, `registerTool`, `serveStdio` from `@modelcontextprotocol/server/stdio`
- `zod` v4 (`import * as z from "zod/v4"`) for tool input schemas
- Transport: stdio. **Never write to stdout** (no `console.log`) — it corrupts the protocol. Log with `console.error`.

## Decisions
- **Dialects:** accept most dialects via `node-sql-parser` (`new Parser().astify(sql, { database })`). The calling LLM is asked (via the tool/param description) to pass `dialect` when it knows it, but the param is **optional** — if omitted, the server guesses (see *Dialect detection*). No JS library auto-detects dialects, so we do it ourselves.
- **Parser:** `node-sql-parser` AST → our own simplified schema model (readable intermediate format) → HTML. The renderer never touches the raw AST.
- **Rendering: server-side, fully offline.** The MCP server computes the layout in Node with `@dagrejs/dagre` and writes the finished diagram as inline SVG into the HTML. The output has **no `<script>`, no CDN, no external resources** — plain HTML + inline CSS + inline SVG. dagre is a server dependency only; nothing of it ends up in the output.
- **Output:** return the HTML as a single `text` content item in the tool result. No files written to disk. The calling agent decides what to do with it (save, publish, show). Keep output small (a few KB for a typical schema) since it goes into the agent's context.

## Tool
`visualize-sql-schema`
- Input:
  - `sql` — DDL as a string, **or**
  - `filePath` — path to a `.sql` file to read (exactly one of the two)
  - `dialect` — optional enum: `PostgreSQL | MySQL | MariaDB | SQLite | TransactSQL | BigQuery` (node-sql-parser `database` names). Describe it as: "SQL dialect of the DDL. Pass it if you know it; if omitted the server detects it."
- Output: `{ content: [{ type: "text", text: "<!doctype html>..." }] }`
- Errors (unreadable file, unparsable SQL, no tables found) return `isError: true` with a clear message (include the parser's line/column when available).

## Pipeline
1. **Input** (`src/input.ts`) — resolve `sql` or read `filePath`.
2. **Dialect** (`src/dialect.ts`) — if `dialect` was not passed, guess it (see below).
3. **Parse** (`src/parser.ts`) — `node-sql-parser` → AST → schema model.
4. **Model** (`src/model.ts`) — types only:
   - `Table { name, columns: Column[], primaryKey: string[], foreignKeys: ForeignKey[] }`
   - `Column { name, type, nullable, default?, unique, isPrimaryKey }`
   - `ForeignKey { columns: string[], refTable, refColumns: string[] }`
5. **Layout** (`src/layout.ts`) — schema model → positions via `@dagrejs/dagre`: each table is a node sized from its column count and longest `name type` text; each FK is an edge. Direction `LR` (or `TB`), with `nodesep`/`ranksep` spacing.
5. **Render** (`src/render.ts`) — schema model + layout → standalone HTML string with one inline `<svg>`.

Keep these as separate modules so each can be tested on its own. Tests: sample `.sql` fixtures in `test/fixtures/` (one per dialect).

## Scope of DDL to support (initially)
- `CREATE TABLE` with column definitions and types
- Inline and table-level constraints: `PRIMARY KEY`, `FOREIGN KEY ... REFERENCES`, `UNIQUE`, `NOT NULL`, `DEFAULT`
- `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`
- Ignore (don't fail on) unsupported statements: `INSERT`, comments, `CREATE INDEX`, etc.

## Rendering notes (server-side SVG)
- **Table box:** `<g>` per table — header rect with table name, then one row per column: key marker (`PK`, `FK`, `UQ`), column name, type; nullable columns visually lighter. Monospace font so widths can be estimated without measuring text (≈ chars × font-size × 0.6).
- **Relationships:** FK edges drawn as SVG `<path>` from the exact source column row to the exact referenced column row (row y = node top + header height + row index × row height), with an arrowhead `<marker>`. Use dagre's edge points for routing, then snap the endpoints to the column rows.
- **Page:** `<!doctype html>`, inline `<style>`, title, optional summary (table/FK count), SVG sized to the dagre graph bounds with a `viewBox` so it scales. Light/dark via `prefers-color-scheme` in CSS.
- **Escape** all identifiers/types/defaults before putting them into HTML/SVG (`& < > " '`).
- Edge cases: self-referencing FKs (loop path), FKs to tables not defined in the file (draw a dashed placeholder node), tables with no relationships (still laid out).
- Optional later: a few lines of inline JS for hover-highlighting edges — the diagram must still work fully without it.
- Alternatives considered and rejected: Cytoscape.js and Mermaid `erDiagram` — both render client-side and need a JS library from a CDN (or embedded, making output hundreds of KB to MBs); `mermaid-cli` pre-rendering needs headless Chrome on the server.
