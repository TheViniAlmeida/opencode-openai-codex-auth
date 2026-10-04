# Configuration examples

- `opencode-v2.json`: native OpenCode V2 defaults, using the current model catalog;
  this is the default installer template.
- `opencode-modern.json`: inherited V1 modern configuration syntax (`--modern`).
- `opencode-legacy.json`: inherited V1 model presets (`--legacy`).
- `minimal-opencode.json`: inherited minimal V1 example.

The plugin implementation requires OpenCode 2.0.22. Older config syntax is
retained for V2's configuration normalization; it does not make this fork run
on a V1 plugin runtime.

Install a built local fork using `node scripts/install-opencode-codex-auth.js
--v2 --plugin /absolute/path/to/package`. Use `--dry-run` to inspect the planned
configuration change. The installer preserves unrelated configuration and
creates a backup before writing an existing file.
