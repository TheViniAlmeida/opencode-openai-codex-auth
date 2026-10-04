![opencode-openai-codex-auth](assets/readme-hero.svg)

# OpenCode V2 Codex OAuth plugin

This fork targets **OpenCode 2.0.22** and `@opencode/plugin` **2.0.22**.
It uses your own ChatGPT subscription through OpenCode's OpenAI integration.
The upstream npm package is not this fork. Build and configure
[this repository](https://github.com/TheViniAlmeida/opencode-openai-codex-auth) as a local plugin.

## Build and install

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
node scripts/install-opencode-codex-auth.js --v2 --plugin "$PWD"
```

The installer backs up an existing JSON/JSONC config, preserves comments and
unrelated settings, migrates OpenAI settings into `providers.openai`, and writes
`plugins`. It leaves credentials and OpenCode's package cache under OpenCode's
management. `--dry-run` previews changes. Invalid existing configuration causes
an error instead of replacement.

For an existing setup that already has its models configured, add only the local
plugin directory:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-openai-codex-auth"]
}
```

`config/opencode-v2.json` configures native V2 defaults. Models come from the
current OpenCode catalog; this fork does not add retired V1 model presets. The older `--modern`
and `--legacy` installer flags emit older configuration syntax, which V2 can
normalize; the plugin implementation itself requires V2.

## Authentication and use

```bash
opencode auth login openai
opencode run --model openai/gpt-5.6-luna#low "Reply with OK without using tools"
```

Select the ChatGPT OAuth browser method or the manual redirect URL method.
Existing OpenCode API-key and headless methods remain available. OpenCode owns
credential storage and coordinates refreshes; accounts are resolved for every
request, including after switching the active account. Each OS user keeps their
own credentials.

## V2 behavior

- Stable plugin ID: `opencode-openai-codex-auth`.
- Native HTTP and WebSocket request hooks support primary, title, compaction,
  and transient generation requests.
- Requests use the Codex endpoint, `store: false`, encrypted reasoning content,
  and account-specific OAuth headers. Native V2 responses remain streamed.
- Repository, agent, and user instructions are preserved. The tool bridge uses
  the actual V2 tool schemas, including `shell` and `subagent` when available.
- Newer canonical GPT model IDs remain unchanged instead of being downgraded
  to an older model family.
- OAuth listeners close after completion, timeout, or plugin unload. Manual
  callbacks reject a supplied mismatched state.
- Diagnostic logs redact credentials and model-visible request bodies.

Plugin options can be provided in the config entry:

```jsonc
{
  "plugins": [{
    "package": "/absolute/path/to/opencode-openai-codex-auth",
    "options": { "codexMode": true }
  }]
}
```

`CODEX_MODE` overrides the legacy plugin config file and the option above.
The old `docs/` guides describe the inherited V1 implementation; use this README
and `config/opencode-v2.json` for V2 installation.

Official references: [Plugins](https://opencode.ai/v2/docs/plugins),
[Plugin API](https://opencode.ai/v2/docs/build/plugins),
[V1 plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1).
