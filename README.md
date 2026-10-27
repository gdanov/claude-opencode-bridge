# claude-opencode-bridge

An OpenCode plugin that makes Claude Code assets work inside OpenCode.

OpenCode and Claude Code are separate tools with separate asset formats. This
bridge reads the Claude Code configuration tree and registers what it finds
with OpenCode's own registries, so a Claude Code skill, command, agent,
plugin, hook, or MCP server keeps working after moving to OpenCode.

Targets the OpenCode V2 plugin API. A V1 plugin does not load on V2: it
exports a named function, while V2 requires a default export with an `id` and
a `setup` or `effect` function.

## What it bridges

| Claude Code | OpenCode | How |
| --- | --- | --- |
| `~/.claude/skills/`, `.claude/skills/` | skills | Already native to OpenCode; the bridge leaves them alone |
| Plugin `skills/<name>/SKILL.md` | skills, named `<plugin>:<name>` | Registered through the skill transform |
| `~/.claude/commands/`, `.claude/commands/` | commands | Registered through the command transform |
| Plugin `commands/<name>.md` | commands, named `<plugin>:<name>` | Registered through the command transform |
| `~/.claude/agents/`, `.claude/agents/` | subagents | Registered through the agent transform |
| Plugin `agents/<name>.md` | subagents, named `<plugin>:<name>` | Registered through the agent transform |
| Plugin `.mcp.json` | MCP servers | Registered through the MCP transform |
| `settings.json` and plugin `hooks/hooks.json` | tool, prompt, and permission hooks | Run as child processes, with Claude Code's JSON protocol |
| `CLAUDE.md`, `.claude/rules/*.md` | system context | Appended to the request's system prompt |

A rule that carries a `paths` frontmatter field is scoped to files that match
it. The bridge keeps that behaviour: such a rule is added to the system prompt
once the session touches a matching file, rather than on every request.

Plugin namespacing follows Claude Code: a plugin's components are reachable as
`<plugin>:<component>`, so `code-simplifier:code-simplifier` and
`cloudflare:wrangler` mean what they mean in Claude Code.

## Install

The plugin is a plain directory with no runtime dependencies.

```sh
git clone <this repository> ~/.config/opencode/plugins/claude-bridge
```

OpenCode discovers plugins under `~/.config/opencode/plugins/` automatically.
Restart the service, or run `opencode service restart`.

For development, symlink a checkout instead:

```sh
ln -s "$PWD" ~/.config/opencode/plugins/claude-bridge
```

## Configuration

Every option is optional. Pass them in `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/claude-bridge",
      "options": {
        "commands": true,
        "agents": true,
        "pluginSkills": true,
        "mcp": true,
        "hooks": true,
        "instructions": true,
        "excludePlugins": [],
        "modelPolicy": "~/.config/opencode/model-policy.json"
      }
    }
  ]
}
```

| Option | Default | Effect |
| --- | --- | --- |
| `commands` | `true` | Register Claude Code commands |
| `agents` | `true` | Register Claude Code subagents |
| `pluginSkills` | `true` | Register skills that plugins provide |
| `mcp` | `true` | Import MCP servers that plugins provide |
| `hooks` | `true` | Run Claude Code hooks |
| `instructions` | `true` | Load `CLAUDE.md` and `.claude/rules` into the system prompt |
| `excludePlugins` | `[]` | Plugin names to skip, by name |
| `modelPolicy` | `~/.config/opencode/model-policy.json` | Path of the model policy file |

`excludePlugins` skips a Claude Code plugin entirely — its assets and its
hooks. Use it when OpenCode already provides the same integration another way.
The Warp notifications, for instance, are provided natively by
[opencode-warp](https://github.com/gdanov/opencode-warp), which raises them
from the terminal client; the Claude Code `warp` plugin's hooks run in the
OpenCode service, which has no terminal, so they cannot reach Warp.

## How hooks are bridged

Claude Code hooks are child processes that read a JSON event on stdin and
report a decision through their exit code and stdout. The bridge runs them
with the same contract, and translates the decisions it understands:

| Claude Code | OpenCode |
| --- | --- |
| `PreToolUse` | `tool.execute.before` |
| `PostToolUse` | `tool.execute.after` |
| `UserPromptSubmit` | `session.prompt` |
| `PermissionRequest` | `permission.evaluate` |

A hook that exits 2 blocks the action, and its stderr becomes the reason.
A hook that prints `{"decision": "block", "reason": "..."}` blocks for the same
reason. A hook that prints `permissionDecision: "deny"` denies the call. A
hook that prints `additionalContext` has its text added to the conversation.

`tool.execute.before` has no field for text the model sees, so a `PreToolUse` hook's `additionalContext` is appended to the result of the same tool call: after the call's output, or after its error message when the call fails. A hook that blocks the call has its `additionalContext` dropped.

Tool names are translated in both directions, because Claude Code calls the
shell tool `Bash` and OpenCode calls it `shell`. The `if` field on a hook
handler, which filters it by permission rule such as `Bash(git status:*)`, is
evaluated against the translated tool name and input.

Other Claude Code hook events have no OpenCode counterpart and are skipped.

## Model names

Claude Code names models with short aliases — `fable`, `opus`, `sonnet`, `haiku` — or with a full model id. OpenCode needs a `provider/model` reference that names a model the user actually has.

An alias names a **tier**, and the tier names the model that serves it. The bridge resolves a tier by walking the tier's model families in order and taking the newest free model of the first family the machine has. Families, not versions, so a tier keeps up with the free inventory as it changes. A name that cannot be resolved, and `inherit`, leave the agent on the session's model.

The `effort:` frontmatter of an agent file is a floor on the tier's effort, and the effort selects the model's variant — the model's own effort level, taken as the weakest one that reaches the effort asked for.

The tiers the bridge ships with:

| Alias | Model families, strongest first | Effort |
| --- | --- | --- |
| `fable` | minimax, glm, beam | `max` |
| `opus` | minimax, glm, beam | `high` |
| `sonnet` | glm, beam, deepseek | `medium` |
| `haiku` | deepseek, glm, longcat | `low` |

Only free models are selected: a model with a price is never chosen, and a local model never serves a lane.

### The model policy

The policy is a file the human owns, at `~/.config/opencode/model-policy.json`. The bridge reads it and never writes it; a missing file is not an error, and the defaults above stand. The `modelPolicy` option points the bridge at a different file.

```json
{
  "providers": ["opencode", "openrouter"],
  "deny": ["exo", "mimo", "big-pickle", "ll-alpha", "nemotron"],
  "freeOnly": true,
  "tiers": {
    "sonnet": { "families": ["glm", "deepseek"], "effort": "medium" },
    "scout": { "families": ["deepseek"] }
  }
}
```

| Field | Effect |
| --- | --- |
| `providers` | The order providers are preferred in. A provider that is not listed comes last. |
| `deny` | Model families that need an explicit opt-in. Remove one to allow it. |
| `freeOnly` | Whether a selected model has to cost nothing. |
| `tiers` | The tier each alias resolves to. A tier names `families`, an optional `exclude`, and an optional `effort`. A tier the defaults do not have is added. |

## Development

```sh
bun install
bun test          # unit tests
bunx tsc --noEmit # typecheck
```

## Layout

```
index.ts                 plugin entry point
src/index.ts             registration of every asset kind
src/claude/paths.ts      locating the Claude Code configuration tree
src/claude/plugins.ts    discovering installed and enabled plugins
src/claude/assets.ts     scanning skills, commands, and agents
src/claude/frontmatter.ts frontmatter parsing and placeholder expansion
src/claude/hooks.ts      hook configuration parsing and matchers
src/claude/hook-runner.ts running a hook and reading its decision
src/claude/tools.ts      translating the tool model between the two tools
src/claude/models.ts     resolving Claude Code model names
src/claude/model-policy.ts  the model policy and the human's policy file
src/claude/rules.ts      path-scoped rules and their glob patterns
```

## Relationship to plugger

[`@sulesky/opencode-plugger`](https://github.com/kapelan/plugger-open-code)
does a related job: it installs Claude Code plugins from marketplaces and
materialises them into OpenCode's own directories.

The two differ in approach. Plugger is an installer — it clones plugins and
writes translated copies into `~/.config/opencode/`. This bridge is a reader: it
registers the Claude Code installation that is already on disk, at runtime.
There is no copy of the assets and no install step, so the Claude Code tree
stays the single source of truth and edits there take effect on reload.

Plugger also targets the OpenCode V1 plugin API, and its published release
does not load on OpenCode V2 — the server reports that the plugin must export a
default definition with an `id` and an `effect` or `setup` function. This
bridge targets the V2 API.
