import { describe, expect, it } from "vitest";
import { Host } from "@opencode/plugin/host";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Package entrypoint", () => {
 it("resolves the root shim used by installed local directory plugins", () => {
  const entries = Host.resolve({ directory: resolve(".") });
  expect(entries.server).toBe(new URL("../server.js", import.meta.url).href);
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  expect(manifest.files).toContain("server.js");
  expect(manifest.exports["./server"].import).toBe("./server.js");
 });
});
