// stdout is the MCP protocol channel: anything printed there corrupts it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = join(import.meta.dirname, "..", "src");
const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));

describe("src/ never writes to stdout", () => {
  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} has no console.log / console.info / process.stdout.write`, () => {
      const code = readFileSync(join(srcDir, file), "utf8");
      expect(code).not.toMatch(/console\.(log|info|debug|table|dir)\s*\(|process\.stdout\.write/);
    });
  }
});
