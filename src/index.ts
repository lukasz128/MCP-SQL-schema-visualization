import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const NWS_API = "https://api.weather.gov";

interface AlertsResponse {
  features: { properties: { event?: string; headline?: string } }[];
}

function createServer(): McpServer {
  const server = new McpServer({ name: "weather", version: "1.0.0" });

  server.registerTool(
    "get-alerts",
    {
      description: "Get the active weather alerts for a US state",
      inputSchema: z.object({
        state: z
          .string()
          .length(2)
          .describe("Two-letter US state code, e.g. CA"),
      }),
    },
    async ({ state }) => {
      const code = state.toUpperCase();
      const url = `${NWS_API}/alerts/active?area=${code}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "mcp-weather-tutorial/1.0" },
      });
      if (!res.ok) {
        return {
          content: [
            { type: "text", text: `NWS API error: HTTP ${res.status}` },
          ],
          isError: true,
        };
      }
      const { features } = (await res.json()) as AlertsResponse;
      if (features.length === 0) {
        return {
          content: [{ type: "text", text: `No active alerts for ${code}.` }],
        };
      }
      const lines = features.map(
        (f) => f.properties.headline ?? f.properties.event ?? "Unnamed alert",
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  return server;
}

void serveStdio(createServer);
console.error("weather MCP server running on stdio");
