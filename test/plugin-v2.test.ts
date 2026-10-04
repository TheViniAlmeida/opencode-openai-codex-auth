import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Credential, Integration } from "@opencode/plugin";
import plugin from "../index.js";
import * as auth from "../lib/auth/auth.js";
import * as server from "../lib/auth/server.js";
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration";

vi.mock("../lib/prompts/codex.js", async (original) => ({
 ...await original<typeof import("../lib/prompts/codex.js")>(),
 getCodexInstructions: vi.fn(async () => "Codex instructions"),
}));
vi.mock("../lib/prompts/opencode-codex.js", () => ({ getOpenCodeCodexPrompt: vi.fn(async () => "old OpenCode system prompt") }));
vi.mock("../lib/config.js", () => ({ loadPluginConfig: () => ({ codexMode: true }), getCodexMode: (config: any) => config.codexMode }));
vi.mock("../lib/auth/browser.js", () => ({ openBrowserUrl: vi.fn() }));
vi.mock("../lib/auth/server.js", () => ({ startLocalOAuthServer: vi.fn() }));

const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const token = (account = "test-account") => `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
const oauth = (account = "test-account") => Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("chatgpt-browser"), access: token(account), refresh: "test-refresh", expires: Date.now() + 60_000 });

async function harness(value: Credential.Value | undefined = oauth(), opts = {}) {
 const methods = new Map<string, IntegrationOAuthMethodRegistration>();
 const hooks = new Map<string, (event: any) => Promise<void>>();
 const connection = { integrationID: "openai", credentialID: "test-credential" };
 const ctx = {
  options: opts,
  integration: {
   transform: vi.fn(async (callback) => callback({ method: { update: (method: IntegrationOAuthMethodRegistration) => methods.set(method.method.id, method) } })),
   connection: { active: vi.fn(async () => connection), resolve: vi.fn(async () => value) },
  },
  provider: { transform: vi.fn(async (callback) => callback({ get: () => ({ provider: { settings: { reasoningEffort: "medium", apiKey: "private-test-key" } }, models: new Map() }) })) },
  session: { hook: vi.fn(async (name, callback, scope) => { expect(scope).toEqual({ providerID: "openai" }); hooks.set(name, callback); }) },
 };
 const cleanup = await plugin.setup(ctx as any);
 return { ctx, methods, hooks, cleanup: cleanup as () => void };
}
function requestEvent(kind = "primary", body: Record<string, unknown> = {}) {
 return { kind, request: new Request("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: "Bearer original-key", "content-type": "application/json", "content-length": "1" }, body: JSON.stringify({ model: "gpt-5.4", instructions: "Repository policy: ask before committing", input: [{ type: "message", role: "user", content: "Hello" }], tools: [{ type: "function", name: "shell", parameters: {} }], ...body }) }) };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("OpenCode V2 plugin", () => {
 it("exports a stable definition and registers OAuth methods and scoped native hooks", async () => {
  const h = await harness();
  expect(plugin.id).toBe("opencode-openai-codex-auth");
  expect([...h.methods.keys()]).toEqual(["chatgpt-browser", "chatgpt-manual"]);
  expect([...h.hooks.keys()]).toEqual(["model.request", "http.request", "http.response", "experimental.ws.handshake", "experimental.ws.send"]);
 });
 it.each(["primary", "title", "compaction", "generate"])("transforms %s HTTP requests, preserves V2 instructions, and uses current OAuth headers", async (kind) => {
  const h = await harness(); const event = requestEvent(kind); const original = event.request;
  await h.hooks.get("http.request")!(event);
  const body = await event.request.json();
  expect(event.request.url).toBe(endpoint);
  expect(body.model).toBe("gpt-5.4"); expect(body.store).toBe(false); expect(body.stream).toBe(true);
  expect(body.instructions).toContain("Codex instructions"); expect(body.instructions).toContain("ask before committing");
  expect(JSON.stringify(body.input)).toContain("Codex in OpenCode V2");
  expect(JSON.stringify(body.input)).toContain("shell"); expect(JSON.stringify(body.input)).not.toContain("todowrite");
  expect(event.request.headers.get("authorization")).toBe(`Bearer ${token()}`);
  expect(event.request.headers.get("chatgpt-account-id")).toBe("test-account");
  expect(event.request.headers.has("content-length")).toBe(false);
  expect(await original.json()).toMatchObject({ instructions: "Repository policy: ask before committing" });
 });
 it.each([Credential.Key.make({ type: "key", key: "test-api-key" }), undefined])("leaves non-OAuth traffic unchanged", async (value) => {
  const h = await harness(value); if (value === undefined) h.ctx.integration.connection.resolve.mockResolvedValue(undefined);
  const event = requestEvent(); const original = event.request;
  await h.hooks.get("http.request")!(event); expect(event.request).toBe(original);
  const modelEvent = { baseURL: "https://api.openai.com/v1" };
  await h.hooks.get("model.request")!(modelEvent); expect(modelEvent.baseURL).toBe("https://api.openai.com/v1");
 });
 it("reads the active account on every request rather than retaining a stale token", async () => {
  const h = await harness(); h.ctx.integration.connection.resolve.mockResolvedValue(oauth("second-account"));
  const event = requestEvent(); await h.hooks.get("http.request")!(event);
  expect(event.request.headers.get("chatgpt-account-id")).toBe("second-account");
 });
 it("preserves resolved reasoning for newer V2 models", async () => {
  const h = await harness(); const event = requestEvent("primary", { reasoning: { effort: "xhigh", summary: "auto" } });
  await h.hooks.get("http.request")!(event);
  expect((await event.request.json()).reasoning.effort).toBe("xhigh");
 });
 it("fails explicitly when an OAuth credential has no account ID", async () => {
  const h = await harness(Credential.OAuth.make({ ...oauth(), access: "invalid-jwt" }));
  await expect(h.hooks.get("http.request")!(requestEvent())).rejects.toThrow("accountId");
 });
 it("preserves native SSE for title and other auxiliary requests", async () => {
  const h = await harness(); const text = 'data: {"type":"response.completed"}\n\n';
  const event = { kind: "title", request: new Request(endpoint), response: new Response(new TextEncoder().encode(text)) };
  await h.hooks.get("http.response")!(event);
  expect(event.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(await event.response.text()).toBe(text);
 });
 it("rewrites WebSocket handshakes with the correct beta header", async () => {
  const h = await harness(); const event = { url: "wss://api.openai.com/v1/responses", headers: {} };
  await h.hooks.get("experimental.ws.handshake")!(event);
  expect(event.url).toBe(endpoint.replace("https:", "wss:"));
  expect(new Headers(event.headers).get("openai-beta")).toBe("responses_websockets=2026-02-06");
 });
 it("transforms full WebSocket frames without HTTP stream flags", async () => {
  const h = await harness(); const event = { frame: JSON.stringify({ type: "response.create", model: "gpt-5.4", input: [], instructions: "Policy" }) };
  await h.hooks.get("experimental.ws.send")!(event);
  expect(JSON.parse(event.frame)).toMatchObject({ type: "response.create", model: "gpt-5.4", store: false });
  expect(JSON.parse(event.frame).stream).toBeUndefined();
 });
 it("preserves incremental WebSocket tool results and previous response ID", async () => {
  const h = await harness(); const input = [{ type: "function_call_output", call_id: "call-test", output: "test-output" }];
  const event = { frame: JSON.stringify({ type: "response.create", model: "gpt-5.4", previous_response_id: "resp-test", input }) };
  await h.hooks.get("experimental.ws.send")!(event);
  expect(JSON.parse(event.frame).input).toEqual(input); expect(JSON.parse(event.frame).previous_response_id).toBe("resp-test");
 });
 it("rejects a mismatched manual OAuth state before exchanging the code", async () => {
  vi.spyOn(auth, "createAuthorizationFlow").mockResolvedValue({ pkce: { verifier: "test", challenge: "test" }, state: "expected", url: "https://example.invalid" });
  const exchange = vi.spyOn(auth, "exchangeAuthorizationCode"); const h = await harness();
  const flow = await h.methods.get("chatgpt-manual")!.authorize({});
  expect(flow.mode).toBe("code"); if (flow.mode !== "code") throw new Error("Expected manual flow");
  await expect(flow.callback("http://localhost:1455/auth/callback?code=test&state=wrong")).rejects.toThrow("state");
  expect(exchange).not.toHaveBeenCalled();
 });
 it("returns a V2 credential on successful manual OAuth", async () => {
  vi.spyOn(auth, "createAuthorizationFlow").mockResolvedValue({ pkce: { verifier: "test", challenge: "test" }, state: "expected", url: "https://example.invalid" });
  vi.spyOn(auth, "exchangeAuthorizationCode").mockResolvedValue({ type: "success", access: token(), refresh: "test-refresh", expires: 123 });
  const h = await harness(); const flow = await h.methods.get("chatgpt-manual")!.authorize({});
  if (flow.mode !== "code") throw new Error("Expected manual flow");
  expect(await flow.callback("test-code")).toMatchObject({ type: "oauth", methodID: "chatgpt-browser", metadata: { accountID: "test-account" } });
 });
 it("uses a Promise callback for automatic OAuth and always closes the callback server", async () => {
  vi.spyOn(auth, "createAuthorizationFlow").mockResolvedValue({ pkce: { verifier: "test", challenge: "test" }, state: "expected", url: "https://example.invalid" });
  vi.spyOn(auth, "exchangeAuthorizationCode").mockResolvedValue({ type: "success", access: token(), refresh: "test-refresh", expires: 123 });
  const close = vi.fn(); vi.mocked(server.startLocalOAuthServer).mockResolvedValue({ ready: true, port: 1455, close, waitForCode: async () => ({ code: "test" }) });
  const h = await harness(); const flow = await h.methods.get("chatgpt-browser")!.authorize({});
  expect(flow.mode).toBe("auto"); if (flow.mode !== "auto") throw new Error("Expected automatic flow");
  expect(await flow.callback).toMatchObject({ type: "oauth", methodID: "chatgpt-browser" }); expect(close).toHaveBeenCalledOnce();
 });
 it("falls back to manual authorization when the callback port is unavailable", async () => {
  const close = vi.fn(); vi.mocked(server.startLocalOAuthServer).mockResolvedValue({ ready: false, port: 1455, close, waitForCode: async () => null });
  const h = await harness(); const flow = await h.methods.get("chatgpt-browser")!.authorize({});
  expect(flow.mode).toBe("code"); expect(close).toHaveBeenCalledOnce();
 });
 it("keeps V2 tool names when codexMode is disabled", async () => {
  const h = await harness(oauth(), { codexMode: false }); const event = requestEvent();
  await h.hooks.get("http.request")!(event);
  const body = await event.request.json();
  expect(JSON.stringify(body.input)).toContain("Codex in OpenCode V2");
  expect(JSON.stringify(body.input)).not.toContain("todowrite");
 });
});
