import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "jsonc-parser";
const script = resolve("scripts/install-opencode-codex-auth.js");
function fixture(content = "{}") {
 const home = mkdtempSync(join(tmpdir(), "opencode-v2-installer-"));
 const dir = join(home, ".config/opencode"); mkdirSync(dir, { recursive: true });
 const config = join(dir, "opencode.jsonc"); writeFileSync(config, content);
 return { home, dir, config, read: () => parse(readFileSync(config, "utf8")) };
}
function install(home: string, args: string[] = []) { return execFileSync(process.execPath, [script, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" }); }
describe("V2 installer", () => {
 it("emits native V2 config by default and creates a backup", () => {
  const f = fixture(); install(f.home); const c = f.read();
  expect(c.plugins).toEqual(["opencode-openai-codex-auth"]); expect(c.plugin).toBeUndefined();
  expect(c.providers.openai.settings.reasoningEffort).toBe("medium");
  expect(c.providers.openai.models).toBeUndefined();
  expect(readdirSync(f.dir).some(name => name.includes(".bak"))).toBe(true);
 });
 it("migrates only OpenAI and plugin syntax, preserving comments and other providers", () => {
  const f = fixture(`{ // retained comment\n "plugin": ["other", "opencode-openai-codex-auth@4.4.0"], "provider": {"anthropic":{"options":{"custom":true}}, "openai":{"options":{"reasoningEffort":"low"},"models":{"custom":{"id":"remote-model","options":{"reasoningEffort":"high"},"variants":{"low":{"reasoningEffort":"low"}},"modalities":{"input":["text"],"output":["text"]}}}}}, "model":"openai/custom" }`);
  install(f.home); const c = f.read();
  expect(readFileSync(f.config,"utf8")).toContain("retained comment");
  expect(c.plugins).toEqual(["other","opencode-openai-codex-auth"]);
  expect(c.provider.anthropic).toEqual({ options: { custom: true } }); expect(c.provider.openai).toBeUndefined();
  expect(c.providers.openai.settings.reasoningEffort).toBe("low");
  expect(c.providers.openai.models.custom).toMatchObject({ modelID:"remote-model", settings:{reasoningEffort:"high"}, capabilities:{input:["text"]}, variants:[{id:"low",settings:{reasoningEffort:"low"}}] });
  expect(c.model).toBe("openai/custom");
 });
 it("retains configured native models and supports a built local plugin", () => {
  const f=fixture('{"plugins":["other"],"providers":{"openai":{"models":{"custom":{"name":"Custom"}},"settings":{"reasoningEffort":"high"}}}}');
  install(f.home,["--plugin","/tmp/opencode-openai-codex-auth"]); const c=f.read();
  expect(c.plugins).toEqual(["other","/tmp/opencode-openai-codex-auth"]); expect(c.providers.openai.models.custom.name).toBe("Custom");
  expect(c.providers.openai.settings.reasoningEffort).toBe("high");
 });
 it("does not replace invalid configuration", () => {
  const f=fixture('{"plugins": ['); const before=readFileSync(f.config,"utf8");
  const result=spawnSync(process.execPath,[script],{env:{...process.env,HOME:f.home}});
  expect(result.status).toBe(1); expect(readFileSync(f.config,"utf8")).toBe(before);
 });
 it("does not write a config or backup in dry-run mode", () => {
  const f=fixture(); install(f.home,["--dry-run"]); expect(f.read()).toEqual({}); expect(readdirSync(f.dir)).toEqual(["opencode.jsonc"]);
 });
 it("does not remove integration credentials through --all", () => {
  const f=fixture(); const result=spawnSync(process.execPath,[script,"--all"],{env:{...process.env,HOME:f.home}});
  expect(result.status).toBe(1); expect(f.read()).toEqual({});
 });
});
