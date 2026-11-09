// MCP stdio entry point. All SDK use stays in this file; stdout belongs to the protocol.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { TOOL_DESCRIPTION, TOOL_NAME, runVisualize, visualizeInputSchema } from "./tool.js";

function createServer(): McpServer {
  const server = new McpServer({ name: "sql-schema-visualization", version: "0.1.0" });

  server.registerTool(
    TOOL_NAME,
    {
      title: "Visualize SQL schema",
      description: TOOL_DESCRIPTION,
      inputSchema: visualizeInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => runVisualize(args),
  );

  return server;
}

serveStdio(createServer);
console.error("sql-schema-visualization MCP server running on stdio");
