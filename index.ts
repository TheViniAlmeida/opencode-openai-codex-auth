import { Credential, Integration, Plugin } from "@opencode/plugin";
import type { IntegrationOAuthAuthorization } from "@opencode/plugin/promise/integration";
import { createAuthorizationFlow, decodeJWT, exchangeAuthorizationCode, parseAuthorizationInput, REDIRECT_URI } from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import { getCodexMode, loadPluginConfig } from "./lib/config.js";
import { AUTH_LABELS, CODEX_BASE_URL, ERROR_MESSAGES, JWT_CLAIM_PATH, PROVIDER_ID } from "./lib/constants.js";
import { createCodexHeaders, handleErrorResponse, handleSuccessResponse, refreshOAuthCredential, transformRequestForCodex } from "./lib/request/fetch-helpers.js";
import type { ConfigOptions, OAuthServerInfo, TokenResult, UserConfig } from "./lib/types.js";

const BROWSER_METHOD = "chatgpt-browser";
const MANUAL_METHOD = "chatgpt-manual";
const CODEX_ENDPOINT = `${CODEX_BASE_URL}/codex/responses`;
const BRIDGE = `# Codex in OpenCode V2
Use only the tools declared in this request, with their exact names and schemas.
OpenCode V2 uses shell for commands and subagent for delegation when available.
Follow the session's instructions, permissions and approval rules. Preserve user changes.
Verify edits with the project's checks and report what was actually validated.`;

function credential(methodID: string, tokens: TokenResult): Credential.OAuth {
	if (tokens.type !== "success") throw new Error("OAuth authentication failed");
	const accountID = decodeJWT(tokens.access)?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	return Credential.OAuth.make({
		type: "oauth",
		methodID: Integration.MethodID.make(methodID),
		access: tokens.access,
		refresh: tokens.refresh,
		expires: tokens.expires,
		...(accountID ? { metadata: { accountID } } : {}),
	});
}

function options(settings: Record<string, unknown> | undefined): ConfigOptions {
	const result: Record<string, unknown> = {};
	for (const key of ["reasoningEffort", "reasoningSummary", "textVerbosity", "include"]) {
		if (settings?.[key] !== undefined) result[key] = settings[key];
	}
	return result as ConfigOptions;
}

export const OpenAIAuthPlugin = Plugin.define({
	id: "opencode-openai-codex-auth",
	async setup(ctx) {
		const servers = new Set<OAuthServerInfo>();
		const codexMode = getCodexMode({ ...loadPluginConfig(), ...ctx.options });
		let userConfig: UserConfig = { global: {}, models: {} };

		const manual = (flow: Awaited<ReturnType<typeof createAuthorizationFlow>>, methodID: string): IntegrationOAuthAuthorization => ({
			url: flow.url,
			mode: "code",
			instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
			callback: async (input) => {
				const parsed = parseAuthorizationInput(input);
				if (!parsed.code || (parsed.state && parsed.state !== flow.state)) {
					throw new Error("Invalid OAuth authorization code or state");
				}
				return credential(methodID, await exchangeAuthorizationCode(parsed.code, flow.pkce.verifier, REDIRECT_URI));
			},
		});

		await ctx.integration.transform((editor) => {
			editor.method.update({
				integrationID: PROVIDER_ID,
				method: { id: BROWSER_METHOD, type: "oauth", label: AUTH_LABELS.OAUTH },
				refresh: refreshOAuthCredential,
				authorize: async () => {
					const flow = await createAuthorizationFlow();
					const server = await startLocalOAuthServer({ state: flow.state });
					if (!server.ready) {
						server.close();
						return manual(flow, BROWSER_METHOD);
					}
					servers.add(server);
					openBrowserUrl(flow.url);
					return {
						url: flow.url,
						mode: "auto",
						instructions: AUTH_LABELS.INSTRUCTIONS,
						expiresAt: Date.now() + 60_000,
						callback: (async () => {
							try {
								const result = await server.waitForCode(flow.state);
								if (!result) throw new Error("OAuth authorization timed out or was cancelled");
								return credential(BROWSER_METHOD, await exchangeAuthorizationCode(result.code, flow.pkce.verifier, REDIRECT_URI));
							} finally {
								server.close();
								servers.delete(server);
							}
						})(),
					};
				},
			});
			editor.method.update({
				integrationID: PROVIDER_ID,
				method: { id: MANUAL_METHOD, type: "oauth", label: AUTH_LABELS.OAUTH_MANUAL },
				refresh: refreshOAuthCredential,
				// Both browser and pasted redirect use the same grant and refresh owner.
				// The native OpenAI provider recognizes chatgpt-browser credentials.
				authorize: async () => manual(await createAuthorizationFlow(), BROWSER_METHOD),
			});
		});

		await ctx.provider.transform((editor) => {
			const source = editor.get(PROVIDER_ID);
			userConfig = {
				global: options(source?.provider.settings),
				models: Object.fromEntries(Array.from(source?.models ?? [], ([id, model]) => [id, { options: options(model.settings) }])),
			};
		});

		const activeOAuth = async () => {
			const connection = await ctx.integration.connection.active(PROVIDER_ID);
			const value = connection ? await ctx.integration.connection.resolve(connection) : undefined;
			return value?.type === "oauth" ? value : undefined;
		};
		const accountID = (value: Credential.OAuth) => {
			const id = decodeJWT(value.access)?.[JWT_CLAIM_PATH]?.chatgpt_account_id ?? value.metadata?.accountID;
			if (typeof id !== "string" || !id) throw new Error(ERROR_MESSAGES.NO_ACCOUNT_ID);
			return id;
		};
		const transform = async (body: string) => {
			const original = JSON.parse(body);
			const result = await transformRequestForCodex({ body }, CODEX_ENDPOINT, userConfig, codexMode, BRIDGE);
			if (!result) throw new Error(ERROR_MESSAGES.REQUEST_PARSE_ERROR);
			// V2 puts repository, agent and user policy in instructions, outside input.
			if (typeof original.instructions === "string" && original.instructions.trim()) {
				result.body.instructions = `${result.body.instructions}\n\n${original.instructions}`;
			}
			if (typeof original.previous_response_id === "string") {
				// Incremental WebSocket frames contain only the new input suffix.
				result.body.input = original.input;
			}
			return result.body;
		};

		await ctx.session.hook("model.request", async (event) => {
			if (!(await activeOAuth())) return;
			event.baseURL = `${CODEX_BASE_URL}/codex`;
		}, { providerID: PROVIDER_ID });

		await ctx.session.hook("http.request", async (event) => {
			const value = await activeOAuth();
			if (!value) return;
			const request = event.request;
			if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses")) return;
			const body = await transform(await request.clone().text());
			const headers = createCodexHeaders({ headers: request.headers }, accountID(value), value.access, { promptCacheKey: body.prompt_cache_key });
			headers.delete("content-length");
			headers.set("content-type", "application/json");
			event.request = new Request(CODEX_ENDPOINT, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal });
		}, { providerID: PROVIDER_ID });

		await ctx.session.hook("http.response", async (event) => {
			if (event.request.url !== CODEX_ENDPOINT || !(await activeOAuth())) return;
			// Native V2 requests always consume the streamed response, including titles.
			event.response = event.response.ok
				? await handleSuccessResponse(event.response, true)
				: await handleErrorResponse(event.response);
		}, { providerID: PROVIDER_ID });

		await ctx.session.hook("experimental.ws.handshake", async (event) => {
			const value = await activeOAuth();
			if (!value) return;
			event.url = CODEX_ENDPOINT.replace("https:", "wss:");
			const headers = createCodexHeaders({ headers: event.headers }, accountID(value), value.access);
			headers.set("OpenAI-Beta", "responses_websockets=2026-02-06");
			event.headers = Object.fromEntries(headers);
		}, { providerID: PROVIDER_ID });

		await ctx.session.hook("experimental.ws.send", async (event) => {
			if (!(await activeOAuth())) return;
			const frame = JSON.parse(event.frame);
			if (frame.type !== "response.create") return;
			const body = await transform(event.frame);
			delete body.stream;
			event.frame = JSON.stringify(body);
		}, { providerID: PROVIDER_ID });

		return () => {
			for (const server of servers) server.close();
			servers.clear();
		};
	},
});

export default OpenAIAuthPlugin;
