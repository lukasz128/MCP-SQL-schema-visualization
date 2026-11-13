# MCP SQL Schema Visualization (TypeScript)

## Goal

An MCP server that takes SQL DDL — either a path to a `.sql` file or a raw SQL string — and returns a self-contained HTML page visualizing the schema (tables, columns, keys and the relationships between tables).

## Current state

- **M1 (walking skeleton) done:** `visualize-sql-schema` works end-to-end for PostgreSQL with `dialect` given. Plan: project doc `claude/implementation-plan.md`.
- Modules: `index.ts` (SDK only) → `tool.ts` (`runVisualize`) → `input.ts` → `split.ts` → `parser.ts` → `layout.ts` → `render.ts`; `model.ts` types, `errors.ts` `SchemaError`.
- Not yet: `dialect.ts` (Phase 5). An omitted `dialect` currently falls back to PostgreSQL ("Parsed as PostgreSQL (default)").
- Scripts: `npm start`, `npm test` (vitest), `npm run typecheck`, `npm run spike:ast` (rewrites `test/ast-samples/`).
- **M1 corrections (Phase 4) done:** readable table names (themed header pair, contrast test) and drag and drop of tables (`src/drag.ts`, one inline script;).
- Known parser gaps (node-sql-parser 5.4, PostgreSQL): `GENERATED ... AS IDENTITY` columns and `REFERENCES t` without a column list make the whole statement fail → it becomes a warning. Candidates for Phase 6.

## Stack

- TypeScript, ESM (`"type": "module"`), run with `tsx`
- `@modelcontextprotocol/server` v2 — `McpServer`, `registerTool`, `serveStdio` from `@modelcontextprotocol/server/stdio`
- `zod` v4 (`import * as z from "zod/v4"`) for tool input schemas
- Transport: stdio. **Never write to stdout** (no `console.log`) — it corrupts the protocol. Log with `console.error`.

## Decisions

- **Dialects:** accept most dialects via `node-sql-parser` (`new Parser().astify(sql, { database })`). The calling LLM is asked (via the tool/param description) to pass `dialect` when it knows it, but the param is **optional** — if omitted, the server guesses (see _Dialect detection_). No JS library auto-detects dialects, so we do it ourselves.
- **Parser:** `node-sql-parser` AST → our own simplified schema model (readable intermediate format) → HTML. The renderer never touches the raw AST.
- **Rendering: server-side, fully offline.** The MCP server computes the layout in Node with `@dagrejs/dagre` and writes the finished diagram as inline SVG into the HTML. The output has **no CDN, no external resources** — HTML + inline CSS + inline SVG + **exactly one small inline `<script>`** (`src/drag.ts`, ~3 KB) for dragging tables. The SVG is complete without the script. dagre is a server dependency only; nothing of it ends up in the output.
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
6. **Render** (`src/render.ts`) — schema model + layout → standalone HTML string with one inline `<svg>`.

Keep these as separate modules so each can be tested on its own. Tests: sample `.sql` fixtures in `test/fixtures/` (one per dialect).

## Scope of DDL to support (initially)

- `CREATE TABLE` with column definitions and types
- Inline and table-level constraints: `PRIMARY KEY`, `FOREIGN KEY ... REFERENCES`, `UNIQUE`, `NOT NULL`, `DEFAULT`
- `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`
- Ignore (don't fail on) unsupported statements: `INSERT`, comments, `CREATE INDEX`, etc.

## Rendering notes (server-side SVG)

- **Header colours:** header fill and table-name text always come from one theme pair of CSS variables — `--hdr-bg`/`--hdr-fg` (tables), `--hdrv-bg`/`--hdrv-fg` (views) — defined in both the light block and the `prefers-color-scheme: dark` block. Never combine a fixed fill with a themed text colour. `test/render.test.ts` asserts ≥ 4.5:1 contrast for each pair in both themes.
- **Table name:** bold, `HEADER_FONT_SIZE` (13px, ~1.1× rows), `dominant-baseline: middle` at the header's vertical centre. Long names (and a placeholder's `(not defined)` suffix) widen the node via the size estimate; never truncate.
- **Table box:** `<g>` per table — header rect with table name, then one row per column: key marker (`PK`, `FK`, `UQ`), column name, type; nullable columns visually lighter. Monospace font so widths can be estimated without measuring text (≈ chars × font-size × 0.6).
- **Relationships:** FK edges drawn as SVG `<path>` from the exact source column row to the exact referenced column row (row y = node top + header height + row index × row height), with an arrowhead `<marker>`. Use dagre's edge points for routing, then snap the endpoints to the column rows.
- **Page:** `<!doctype html>`, inline `<style>`, title, optional summary (table/FK count), SVG sized to the dagre graph bounds with a `viewBox` so it scales. Light/dark via `prefers-color-scheme` in CSS.
- **Escape** all identifiers/types/defaults before putting them into HTML/SVG (`& < > " '`). Anything written unescaped must be a number, a generated id or a constant — never text from the SQL. `test/render.test.ts` feeds hostile identifiers, defaults, a skipped statement and a file name through the renderer and asserts none of it becomes markup.
- **Content-Security-Policy** (`CSP` in `render.ts`): a `<meta http-equiv>` right after the charset — `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-…'; base-uri 'none'; form-action 'none'`. The hash is computed from `dragScript()` at module load, so editing `drag.ts` updates it automatically; never add a second script, inline event handlers (`onclick=`), `eval`, or anything that loads a resource, because the policy blocks them. It is a backstop for escaping mistakes, not a replacement.
- Edge cases: self-referencing FKs (loop path), FKs to tables not defined in the file (draw a dashed placeholder node), tables with no relationships (still laid out).
- **Drag and drop** (`src/drag.ts`): each node is `<g data-t="<node id>" transform="translate(x,y)">` with children in local coordinates; each edge `<path data-from data-fr data-to data-tr>` (node ids + row indexes, -1 = header). Pointer Events on the header only (mouse, touch, pen), `getScreenCTM().inverse()` for coordinates. A moved table's edges are redrawn as cubic Béziers with the `layout.ts` anchor formula (constants `HEADER_HEIGHT`, `ROW_HEIGHT`, `LOOP_OFFSET`, `MARGIN` are written into the script); self-loops just translate. The `viewBox` grows on drop, never below the original. "Reset layout" button (hidden without JS) restores the exact original SVG. Positions are not saved.
- Optional later: hover-highlighting edges — add it to the same script; the diagram must still work fully without it.
- Alternatives considered and rejected: Cytoscape.js and Mermaid `erDiagram` — both render client-side and need a JS library from a CDN (or embedded, making output hundreds of KB to MBs); `mermaid-cli` pre-rendering needs headless Chrome on the server.
