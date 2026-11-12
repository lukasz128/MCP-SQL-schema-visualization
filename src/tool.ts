// The tool's contract and orchestration, testable without MCP.
import { basename } from "node:path";
import * as z from "zod/v4";
import { SchemaError } from "./errors.js";
import { resolveInput, type InputOptions } from "./input.js";
import { layoutSchema } from "./layout.js";
import { DIALECTS, type Dialect } from "./model.js";
import { parseSchema } from "./parser.js";
import { renderHtml, type RenderMeta } from "./render.js";
import { splitStatements } from "./split.js";

export const TOOL_NAME = "visualize-sql-schema";

export const TOOL_DESCRIPTION =
  "Render SQL DDL (CREATE TABLE, ALTER TABLE ... ADD CONSTRAINT, CREATE VIEW) as an entity-relationship diagram. " +
  "Pass exactly one of `sql` (the DDL text) or `filePath` (a .sql file on this machine). " +
  "Returns one self-contained HTML page (inline SVG and CSS plus one small inline script for dragging tables; no network, works offline) as text: save it as a .html file or show it to the user. " +
  "Statements that are not schema DDL (INSERT, CREATE INDEX, functions, ...) are skipped and listed in the page.";

export const visualizeInputSchema = z.object({
  sql: z.string().optional().describe("The DDL as a string. Use this or `filePath`, not both."),
  filePath: z
    .string()
    .optional()
    .describe(
      "Absolute path to a .sql file to read. Relative paths resolve against the server's working directory, so prefer an absolute path. Use this or `sql`, not both.",
    ),
  dialect: z
    .enum(DIALECTS)
    .optional()
    .describe("SQL dialect of the DDL. Pass it if you know it; if omitted the server detects it."),
});

export type VisualizeArgs = z.infer<typeof visualizeInputSchema>;

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Until dialect detection lands (Phase 5), an omitted dialect means PostgreSQL. */
const FALLBACK_DIALECT: Dialect = "PostgreSQL";

const text = (t: string, isError = false): ToolResult =>
  isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] };

/** Runs the whole pipeline; expected failures become `isError: true` results with a readable message. */
export async function runVisualize(args: VisualizeArgs, options: InputOptions = {}): Promise<ToolResult> {
  try {
    const input = await resolveInput(args, options);
    const dialect = args.dialect ?? FALLBACK_DIALECT;
    const schema = parseSchema(splitStatements(input.sql), dialect);
    const layout = layoutSchema(schema);
    const meta: RenderMeta = { dialect, dialectSource: args.dialect ? "given" : "default" };
    if (input.path) meta.title = basename(input.path);
    return text(renderHtml(schema, layout, meta));
  } catch (e) {
    if (e instanceof SchemaError) return text(e.message, true);
    console.error(`[${TOOL_NAME}] unexpected error:`, e);
    return text(`Internal error while visualizing the schema: ${(e as Error)?.message ?? String(e)}`, true);
  }
}
