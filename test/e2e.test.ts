// Spawns the real server and talks newline-delimited JSON-RPC to it over stdio.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const fixture = join(root, "test", "fixtures", "postgresql.sql");

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

class StdioClient {
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, (r: RpcResponse) => void>();
  /** Every line the server wrote to stdout; all of them must be JSON-RPC. */
  readonly lines: string[] = [];

  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        this.lines.push(line);
        const msg = JSON.parse(line) as RpcResponse;
        if (typeof msg.id === "number") this.pending.get(msg.id)?.(msg);
      }
    });
  }

  request(method: string, params: object = {}): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params: object = {}): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
}

describe("MCP server over stdio", () => {
  let proc: ChildProcessWithoutNullStreams;
  let client: StdioClient;
  let stderr = "";

  beforeAll(async () => {
    proc = spawn(process.execPath, ["--import", "tsx", join(root, "src", "index.ts")], { cwd: root, env: process.env });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c: string) => (stderr += c));
    client = new StdioClient(proc);
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });
    expect(init.error).toBeUndefined();
    client.notify("notifications/initialized");
  });

  afterAll(() => {
    proc?.stdin.end();
    proc?.kill();
  });

  it("lists the visualize-sql-schema tool", async () => {
    const r = await client.request("tools/list");
    const tool = r.result.tools.find((t: { name: string }) => t.name === "visualize-sql-schema");
    expect(tool).toBeDefined();
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["dialect", "filePath", "sql"]);
    expect(tool.inputSchema.properties.dialect.enum).toEqual(["PostgreSQL", "MySQL", "MariaDB", "SQLite", "TransactSQL", "BigQuery"]);
  });

  it("renders the PostgreSQL fixture with an explicit dialect", async () => {
    const r = await client.request("tools/call", {
      name: "visualize-sql-schema",
      arguments: { filePath: fixture, dialect: "PostgreSQL" },
    });
    expect(r.error).toBeUndefined();
    expect(r.result.isError ?? false).toBe(false);
    expect(r.result.content[0].type).toBe("text");
    expect(r.result.content[0].text).toMatch(/^<!doctype html>/);
    expect(r.result.content[0].text).toContain("6 tables · 1 view · 6 foreign keys");
  });

  it("returns isError for an unreadable file", async () => {
    const r = await client.request("tools/call", {
      name: "visualize-sql-schema",
      arguments: { filePath: "/no/such/file.sql" },
    });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/File not found/);
  });

  it("rejects an unknown dialect", async () => {
    const r = await client.request("tools/call", {
      name: "visualize-sql-schema",
      arguments: { sql: "CREATE TABLE a (id INT)", dialect: "Oracle" },
    });
    // The SDK reports schema violations either as a JSON-RPC error or as an isError result.
    expect(r.error !== undefined || r.result?.isError === true).toBe(true);
  });

  it("wrote nothing but JSON-RPC to stdout", () => {
    expect(client.lines.length).toBeGreaterThan(0);
    for (const line of client.lines) expect(JSON.parse(line).jsonrpc).toBe("2.0");
    expect(stderr).toContain("running on stdio");
  });
});
