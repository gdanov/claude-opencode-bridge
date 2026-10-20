# claude-opencode-bridge

An OpenCode plugin that makes Claude Code assets work inside OpenCode.

OpenCode and Claude Code are separate tools with separate asset formats. This
bridge reads the Claude Code configuration tree and registers what it finds
with OpenCode's own registries, so a Claude Code skill, command, agent,
plugin, hook, or MCP server keeps working after moving to OpenCode.

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
  "plugin": [
    {
      "package": "./plugins/claude-bridge",
      "options": {
        "commands": true,
        "agents": true,
        "pluginSkills": true,
        "mcp": true,
        "hooks": true,
        "instructions": true,
        "excludePlugins": []
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

Tool names are translated in both directions, because Claude Code calls the
shell tool `Bash` and OpenCode calls it `shell`. The `if` field on a hook
handler, which filters it by permission rule such as `Bash(git status:*)`, is
evaluated against the translated tool name and input.

Other Claude Code hook events have no OpenCode counterpart and are skipped.

## Model names

Claude Code names models with short aliases — `opus`, `sonnet`, `haiku` — or
with a full model id. OpenCode needs a `provider/model` reference that names a
model the user actually has. The bridge resolves an alias against the
available models, preferring an Anthropic model and then the newest match. A
name that cannot be resolved, and `inherit`, leave the agent on the session's
model.

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
