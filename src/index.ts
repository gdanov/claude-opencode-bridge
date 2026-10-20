/**
 * OpenCode plugin that exposes Claude Code assets inside OpenCode.
 *
 * The bridge reads the Claude Code configuration tree and registers the
 * assets it finds with OpenCode's own registries, so that a Claude Code
 * skill, command, or agent behaves the same way in both tools.
 *
 * OpenCode already discovers `.claude/skills` and `~/.claude/skills` on its
 * own, so the bridge does not register those again; it fills in what
 * OpenCode does not cover: commands, agents, plugin assets, MCP servers,
 * hooks, and project instructions.
 */

import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { listField, scanAgents, scanCommands, scanSkills, stringField } from "./claude/assets.ts"
import {
  mergeHookConfigs,
  matchMatcher,
  parseHookConfig,
  readPluginHooks,
  type ClaudeHookConfig,
  type ClaudeHookGroup,
  type ClaudeHookHandler,
} from "./claude/hooks.ts"
import { expandHookArgs, expandHookPaths, runHook, type HookEvent } from "./claude/hook-runner.ts"
import { namedArguments, readFrontmatter, substitute } from "./claude/frontmatter.ts"
import { matchesAnyPath, readRulePaths as rulePaths, type Rule } from "./claude/rules.ts"
import { discoverPlugins, readSettings, type ClaudePlugin, type ClaudeSettings } from "./claude/plugins.ts"
import { resolveModel, type ModelRef } from "./claude/models.ts"
import { readModelPolicy, type ModelPolicy } from "./claude/model-policy.ts"
import type { Model } from "@opencode/plugin"
import { isDirectory, isFile, readJSON, resolveRoots, type ClaudeRoots } from "./claude/paths.ts"
import {
  matchPermissionRule,
  toClaudeTool,
  toClaudeToolInput,
  toOpenCodeTool,
} from "./claude/tools.ts"

export interface BridgeOptions {
  /** Register Claude Code commands. */
  readonly commands?: boolean
  /** Register Claude Code subagents. */
  readonly agents?: boolean
  /** Register skills that Claude Code plugins provide. */
  readonly pluginSkills?: boolean
  /** Import MCP servers that Claude Code plugins provide. */
  readonly mcp?: boolean
  /** Run Claude Code hooks. */
  readonly hooks?: boolean
  /** Load `CLAUDE.md` and `.claude/rules` into the session context. */
  readonly instructions?: boolean
  /** Plugin names to leave out, by plugin name. */
  readonly excludePlugins?: readonly string[]
  /** Path of the model policy file; the default path is used when unset. */
  readonly modelPolicy?: string
}

const DEFAULTS: Required<Omit<BridgeOptions, "excludePlugins" | "modelPolicy">> = {
  commands: true,
  agents: true,
  pluginSkills: true,
  mcp: true,
  hooks: true,
  instructions: true,
}

/** A source of Claude Code assets. */
interface Scope {
  /** Directory that holds `skills`, `commands`, and `agents`. */
  readonly root: string
  /** Plugin that provides the assets, when they come from one. */
  readonly plugin?: string
  /** Plugin root, used to resolve `${CLAUDE_PLUGIN_ROOT}`. */
  readonly pluginRoot?: string
  /** Plugin data directory, used to resolve `${CLAUDE_PLUGIN_DATA}`. */
  readonly pluginData?: string
}

/**
 * The plugin contract OpenCode expects.
 *
 * The published `@opencode/plugin` package types this as a namespace rather
 * than a plain type, so the shape is declared here to keep the bridge
 * independent of the package's export style.
 */
interface BridgePlugin {
  readonly id: string
  readonly setup: (ctx: any) => Promise<void> | void
}

const bridge: BridgePlugin = {
  id: "claude-compat",
  async setup(ctx) {
    const options = { ...DEFAULTS, ...(ctx.options as BridgeOptions) }
    const exclude = new Set(options.excludePlugins ?? [])
    const projectDir = ctx.location.directory
    const roots = resolveRoots(projectDir)
    const settings = readSettings(roots)
    const plugins = discoverPlugins(roots, settings).filter((plugin) => !exclude.has(plugin.name))

    const scopes = collectScopes(roots, plugins)
    const models = await availableModels(ctx)
    const policy = readModelPolicy(options.modelPolicy)

    if (options.commands) {
      for (const scope of scopes) registerCommands(ctx, scope, models, policy)
    }
    if (options.agents) {
      for (const scope of scopes) registerAgents(ctx, scope, models, policy)
    }
    if (options.pluginSkills) {
      for (const plugin of plugins) registerPluginSkills(ctx, plugin)
    }
    if (options.mcp) {
      for (const plugin of plugins) await registerMcp(ctx, plugin, roots)
    }
    if (options.hooks) {
      const config = collectHooks(roots, settings, plugins)
      installHooks(ctx, config, roots, projectDir)
    }
    if (options.instructions) {
      installInstructions(ctx, roots, projectDir)
    }
  },
}

export default bridge

/**
 * Read the models the user can pick.
 *
 * A model that cannot be listed leaves Claude Code model names unresolved,
 * which leaves the affected agent on the session's model.
 */
async function availableModels(ctx: any): Promise<Model.Info[]> {
  try {
    const listed = await ctx.model.list()
    const data = listed?.data ?? listed
    return Array.isArray(data) ? (data as Model.Info[]) : []
  } catch {
    return []
  }
}

/**
 * Collect the asset scopes in the order Claude Code resolves them.
 *
 * Plugin assets come first, then the project tree, then the user tree, so
 * that a project asset replaces a user asset of the same name.
 */
function collectScopes(roots: ClaudeRoots, plugins: ClaudePlugin[]): Scope[] {
  const scopes: Scope[] = plugins.map((plugin) => ({
    root: plugin.root,
    plugin: plugin.name,
    pluginRoot: plugin.root,
    pluginData: path.join(roots.plugins, "data", `${plugin.name}-${plugin.marketplace}`),
  }))
  if (roots.project) scopes.push({ root: roots.project })
  scopes.push({ root: roots.user })
  return scopes
}

/**
 * Register Claude Code commands with OpenCode.
 *
 * Claude Code commands take arguments and expand placeholders in their body.
 * OpenCode uses the same conventions, so the body is carried over and
 * expanded when the command runs.
 */
function registerCommands(ctx: any, scope: Scope, models: Model.Info[], policy: ModelPolicy): void {
  const commands = scanCommands(path.join(scope.root, "commands"), scope.plugin)
  if (commands.length === 0) return
  void ctx.command.transform((editor: any) => {
    for (const command of commands) {
      const description = stringField(command.frontmatter.data, "description")
      const body = command.frontmatter.content
      const declared = namedArguments(command.frontmatter.data)
      const model = resolveModel(stringField(command.frontmatter.data, "model"), models, {
        effort: stringField(command.frontmatter.data, "effort"),
        policy,
      })
      editor.add({
        name: command.id,
        ...(description === undefined ? {} : { description }),
        execute: async (input: any) => {
          const args = splitArguments(input.prompt?.text ?? "")
          const named = resolveNamedArguments(declared, args)
          const text = substitute(body, {
            arguments: args.join(" "),
            named,
            skillDir: path.dirname(command.file),
            projectDir: ctx.location.directory,
            pluginRoot: scope.pluginRoot,
            pluginData: scope.pluginData,
            sessionID: input.sessionID,
          })
          if (model) await ctx.session.switchModel({ sessionID: input.sessionID, model })
          await ctx.session.prompt({
            ...input.prompt,
            sessionID: input.sessionID,
            text,
            delivery: input.delivery,
          })
        },
      })
    }
  })
}

/**
 * Register Claude Code subagents with OpenCode.
 *
 * Claude Code agents are subagents, so they are registered with the
 * `subagent` mode and their body becomes the system prompt.
 */
function registerAgents(ctx: any, scope: Scope, models: Model.Info[], policy: ModelPolicy): void {
  const agents = scanAgents(path.join(scope.root, "agents"), scope.plugin)
  if (agents.length === 0) return
  void ctx.agent.transform((editor: any) => {
    for (const agent of agents) {
      const description = stringField(agent.frontmatter.data, "description")
      const body = agent.frontmatter.content
      const model = resolveModel(stringField(agent.frontmatter.data, "model"), models, {
        effort: stringField(agent.frontmatter.data, "effort"),
        policy,
      })
      editor.update(agent.id, (info: any) => {
        info.name = stringField(agent.frontmatter.data, "name") ?? agent.name
        info.mode = "subagent"
        if (description !== undefined) info.description = description
        info.system = body
        if (model) info.model = model
        const tools = listField(agent.frontmatter.data, "tools")
        if (tools.length > 0) {
          info.permissions = [
            { action: "*", resource: "*", effect: "deny" },
            ...tools.map((tool) => ({
              action: toOpenCodeTool(tool),
              resource: "*",
              effect: "allow" as const,
            })),
          ]
        }
      })
    }
  })
}

/**
 * Register the skills a Claude Code plugin provides.
 *
 * OpenCode discovers `.claude/skills` on its own but does not look inside
 * plugins, so plugin skills are registered here under Claude Code's own
 * `plugin:skill` names.
 */
function registerPluginSkills(ctx: any, plugin: ClaudePlugin): void {
  const skills = scanSkills(path.join(plugin.root, "skills"), plugin.name)
  if (skills.length === 0) return
  void ctx.skill.transform((editor: any) => {
    for (const skill of skills) {
      const description = stringField(skill.frontmatter.data, "description")
      editor.add({
        id: skill.id,
        name: stringField(skill.frontmatter.data, "name") ?? skill.name,
        ...(description === undefined ? {} : { description }),
        path: skill.file,
        content: skill.frontmatter.content,
      })
    }
  })
}

/** Register the MCP servers a plugin declares. */
async function registerMcp(ctx: any, plugin: ClaudePlugin, roots: ClaudeRoots): Promise<void> {
  const servers = readMcpServers(plugin, roots)
  if (servers.size === 0) return
  await ctx.mcp.transform((editor: any) => {
    for (const [name, config] of servers) {
      editor.set(name, config)
    }
  })
}

/**
 * Read the MCP servers a plugin declares.
 *
 * Claude Code accepts both the wrapped `mcpServers` shape and a bare map of
 * servers, and each server is either a local command or a remote URL.
 */
function readMcpServers(
  plugin: ClaudePlugin,
  roots: ClaudeRoots,
): Map<string, Record<string, unknown>> {
  const servers = new Map<string, Record<string, unknown>>()
  const file = path.join(plugin.root, ".mcp.json")
  const raw = readJSON<Record<string, unknown>>(file)
  if (!raw) return servers

  const entries = (
    raw.mcpServers && typeof raw.mcpServers === "object"
      ? (raw.mcpServers as Record<string, unknown>)
      : raw
  ) as Record<string, unknown>

  const variables = {
    CLAUDE_PLUGIN_ROOT: plugin.root,
    CLAUDE_PLUGIN_DATA: path.join(roots.plugins, "data", `${plugin.name}-${plugin.marketplace}`),
  }

  for (const [name, value] of Object.entries(entries)) {
    if (!value || typeof value !== "object") continue
    const record = value as Record<string, unknown>
    const type = typeof record.type === "string" ? record.type : undefined

    if (type === "http" || type === "sse" || (type === undefined && typeof record.url === "string")) {
      servers.set(name, {
        type: "remote",
        url: expandHookPaths(String(record.url ?? ""), variables),
      })
      continue
    }

    if (typeof record.command === "string") {
      const command = expandHookPaths(record.command, variables)
      const args = Array.isArray(record.args)
        ? expandHookArgs(record.args.map(String), variables)
        : undefined
      const environment =
        record.env && typeof record.env === "object"
          ? Object.fromEntries(
              Object.entries(record.env as Record<string, unknown>)
                .filter(([, item]) => typeof item === "string")
                .map(([key, item]) => [key, expandHookPaths(String(item), variables)]),
            )
          : undefined
      servers.set(name, {
        type: "local",
        command: [command, ...(args ?? [])],
        ...(environment && Object.keys(environment).length > 0 ? { environment } : {}),
      })
    }
  }

  return servers
}

/**
 * Collect the hook configuration from every source.
 *
 * Claude Code merges user, project, and plugin hooks, with project hooks
 * taking precedence over user hooks for the same matcher.
 */
function collectHooks(
  roots: ClaudeRoots,
  settings: ClaudeSettings,
  plugins: ClaudePlugin[],
): ClaudeHookConfig {
  const user = parseHookConfig(settings.hooks ?? {})
  const project = roots.project ? parseHookConfig(readProjectHooks(roots.project)) : {}
  const pluginHooks = plugins.map((plugin) => readPluginHooks(plugin.root))
  return mergeHookConfigs(user, project, ...pluginHooks)
}

/** Read the `hooks` object from a project's `settings.json`. */
function readProjectHooks(projectRoot: string): unknown {
  const settings = readJSON<{ hooks?: unknown }>(path.join(projectRoot, "settings.json"))
  return settings?.hooks ?? {}
}

/**
 * Install the Claude Code hooks as OpenCode hooks.
 *
 * `PreToolUse` maps onto OpenCode's `tool.execute.before`, which rejects a
 * single tool call without ending the session. `PostToolUse` maps onto
 * `execute.after`. `UserPromptSubmit` maps onto the session prompt hook, and
 * `PermissionRequest` onto the permission evaluation hook.
 */
function installHooks(
  ctx: any,
  config: ClaudeHookConfig,
  roots: ClaudeRoots,
  projectDir: string,
): void {
  const preToolUse = config.PreToolUse ?? []
  const postToolUse = config.PostToolUse ?? []
  const promptSubmit = config.UserPromptSubmit ?? []
  const permissionRequest = config.PermissionRequest ?? []

  if (preToolUse.length > 0) {
    void ctx.tool.hook("execute.before", async (event: any) => {
      const outcome = await runPreToolUse(preToolUse, event, roots, projectDir)
      if (outcome.block) throw new Error(outcome.reason ?? "blocked by Claude Code hook")
    })
  }

  if (postToolUse.length > 0) {
    void ctx.tool.hook("execute.after", async (event: any) => {
      await runPostToolUse(postToolUse, event, roots, projectDir)
    })
  }

  if (promptSubmit.length > 0) {
    void ctx.session.hook("prompt", async (event: any) => {
      const outcome = await runPromptSubmit(promptSubmit, event, roots, projectDir)
      if (outcome.additionalContext) {
        event.prompt.text = `${event.prompt.text}\n\n${outcome.additionalContext}`
      }
      if (outcome.block) {
        event.prompt.text = `${event.prompt.text}\n\n${outcome.reason ?? "blocked by Claude Code hook"}`
      }
    })
  }

  if (permissionRequest.length > 0) {
    void ctx.permission.hook("evaluate", async (event: any) => {
      const outcome = await runPermissionRequest(permissionRequest, event, roots, projectDir)
      if (outcome.block) {
        event.effect = "deny"
        event.message = outcome.reason
      }
    })
  }
}

/** Run the `PreToolUse` hooks for a tool call. */
async function runPreToolUse(
  groups: ClaudeHookGroup[],
  event: any,
  roots: ClaudeRoots,
  projectDir: string,
): Promise<{ block: boolean; reason?: string }> {
  const tool = toClaudeTool(event.tool)
  const input = toClaudeToolInput(event.tool, event.input)
  for (const group of groups) {
    if (!matchMatcher(group.matcher, tool)) continue
    for (const hook of group.hooks) {
      if (hook.if && !matchPermissionRule(hook.if, tool, input)) continue
      const outcome = await runHookCommand(
        hook,
        buildToolEvent("PreToolUse", event, tool, input),
        roots,
        projectDir,
      )
      if (outcome.decision.block) return { block: true, reason: outcome.decision.reason }
    }
  }
  return { block: false }
}

/** Run the `PostToolUse` hooks for a completed tool call. */
async function runPostToolUse(
  groups: ClaudeHookGroup[],
  event: any,
  roots: ClaudeRoots,
  projectDir: string,
): Promise<void> {
  const tool = toClaudeTool(event.tool)
  const input = toClaudeToolInput(event.tool, event.input)
  const response = event.status === "completed" ? event.result : { error: event.error }
  for (const group of groups) {
    if (!matchMatcher(group.matcher, tool)) continue
    for (const hook of group.hooks) {
      if (hook.if && !matchPermissionRule(hook.if, tool, input)) continue
      await runHookCommand(
        hook,
        buildToolEvent("PostToolUse", event, tool, input, response),
        roots,
        projectDir,
      )
    }
  }
}

/** Run the `UserPromptSubmit` hooks for a submitted prompt. */
async function runPromptSubmit(
  groups: ClaudeHookGroup[],
  event: any,
  roots: ClaudeRoots,
  projectDir: string,
): Promise<{ block: boolean; reason?: string; additionalContext?: string }> {
  let additionalContext: string | undefined
  for (const group of groups) {
    for (const hook of group.hooks) {
      const outcome = await runHookCommand(
        hook,
        {
          hook_event_name: "UserPromptSubmit",
          session_id: event.sessionID,
          cwd: projectDir,
          prompt: event.prompt?.text ?? "",
        },
        roots,
        projectDir,
      )
      if (outcome.decision.additionalContext) {
        additionalContext = [additionalContext, outcome.decision.additionalContext]
          .filter(Boolean)
          .join("\n\n")
      }
      if (outcome.decision.block) return { block: true, reason: outcome.decision.reason, additionalContext }
    }
  }
  return { block: false, additionalContext }
}

/** Run the `PermissionRequest` hooks for a permission prompt. */
async function runPermissionRequest(
  groups: ClaudeHookGroup[],
  event: any,
  roots: ClaudeRoots,
  projectDir: string,
): Promise<{ block: boolean; reason?: string }> {
  const tool = toClaudeTool(event.action)
  const input = toClaudeToolInput(event.action, { command: event.resources?.[0] })
  for (const group of groups) {
    if (!matchMatcher(group.matcher, tool)) continue
    for (const hook of group.hooks) {
      if (hook.if && !matchPermissionRule(hook.if, tool, input)) continue
      const outcome = await runHookCommand(
        hook,
        {
          hook_event_name: "PermissionRequest",
          session_id: event.sessionID,
          cwd: projectDir,
          tool_name: tool,
          tool_input: input,
        },
        roots,
        projectDir,
      )
      if (outcome.decision.block) return { block: true, reason: outcome.decision.reason }
    }
  }
  return { block: false }
}

/** Build the JSON payload a Claude Code hook receives for a tool event. */
function buildToolEvent(
  name: string,
  event: any,
  tool: string,
  input: Record<string, unknown>,
  response?: unknown,
): HookEvent {
  return {
    hook_event_name: name,
    session_id: event.sessionID,
    cwd: event.cwd,
    tool_name: tool,
    tool_input: input,
    ...(response === undefined ? {} : { tool_response: response }),
  }
}

/** Run one hook command with the environment Claude Code provides. */
async function runHookCommand(
  hook: ClaudeHookHandler,
  event: HookEvent,
  roots: ClaudeRoots,
  projectDir: string,
): Promise<{ decision: { block: boolean; reason?: string; additionalContext?: string } }> {
  if (!hook.command) return { decision: { block: false } }
  const variables = { CLAUDE_PROJECT_DIR: projectDir }
  const command = expandHookPaths(hook.command, variables)
  const args = hook.args ? expandHookArgs(hook.args, variables) : undefined
  const outcome = await runHook(command, args, event, {
    cwd: projectDir,
    timeout: hook.timeout === undefined ? undefined : hook.timeout * 1000,
    env: {
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_CONFIG_DIR: roots.user,
    },
  })
  return { decision: outcome.decision }
}

/**
 * Load Claude Code instructions into the session context.
 *
 * `CLAUDE.md` files and `.claude/rules` entries are project-level guidance
 * that Claude Code reads directly. OpenCode only reads `AGENTS.md`, so the
 * bridge adds the Claude Code files to the system prompt instead.
 *
 * A rule that carries a `paths` frontmatter field is scoped to files that
 * match it, and Claude Code only loads such a rule once a matching file is
 * touched. The bridge keeps that behaviour by tracking the files a session
 * touches and adding the matching rules once one of them appears.
 */
function installInstructions(ctx: any, roots: ClaudeRoots, projectDir: string): void {
  const always = collectInstructionFiles(roots, projectDir, false)
  const scoped = collectInstructionFiles(roots, projectDir, true)
  if (always.length === 0 && scoped.length === 0) return

  const touched = new Map<string, Set<string>>()

  void ctx.tool.hook("execute.before", async (event: any) => {
    const file = touchedPath(event.tool, event.input)
    if (!file) return
    const seen = touched.get(event.sessionID) ?? new Set<string>()
    seen.add(file)
    touched.set(event.sessionID, seen)
  })

  void ctx.session.hook("context", async (event: any) => {
    const parts: string[] = []
    for (const item of always) {
      const text = readTextFile(item.file)
      if (text) parts.push(formatInstruction(item.file, text))
    }
    const seen = touched.get(event.sessionID)
    if (seen) {
      for (const rule of scoped) {
        if (!rule.paths?.some((pattern) => matchesAnyPath([pattern], seen, projectDir))) continue
        const text = readTextFile(rule.file)
        if (text) parts.push(formatInstruction(rule.file, text))
      }
    }
    if (parts.length === 0) return
    event.system.push({ type: "text", text: parts.join("\n\n") })
  })
}

/**
 * Collect the instruction files that apply to a project directory.
 *
 * The search walks up from the project directory, so a repository-level
 * `CLAUDE.md` is found from a subdirectory, as Claude Code does.
 */
function collectInstructionFiles(
  roots: ClaudeRoots,
  projectDir: string,
  scoped: boolean,
): Rule[] {
  const files: Rule[] = []
  const seen = new Set<string>()

  const add = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const paths = scoped ? readRulePaths(file) : undefined
    if (scoped && !paths) return
    files.push({ file, ...(paths ? { paths } : {}) })
  }

  for (const root of [roots.user, roots.project]) {
    if (!root) continue
    const rules = path.join(root, "rules")
    if (isDirectory(rules)) {
      for (const entry of readDirectoryFiles(rules)) {
        if (entry.endsWith(".md")) add(entry)
      }
    }
  }

  let current = path.resolve(projectDir)
  for (;;) {
    const candidate = path.join(current, "CLAUDE.md")
    if (isFile(candidate) && !scoped) add(candidate)
    const rules = path.join(current, ".claude", "rules")
    if (isDirectory(rules)) {
      for (const entry of readDirectoryFiles(rules)) {
        if (entry.endsWith(".md")) add(entry)
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return files
}

/**
 * Read the path patterns that scope a rule.
 *
 * A rule without patterns applies everywhere, so it is not a scoped rule.
 */
function readRulePaths(file: string): string[] | undefined {
  return rulePaths(file)
}

/** The file a tool call touches, when it touches one. */
function touchedPath(tool: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const source = input as Record<string, unknown>
  const path = source.path ?? source.filePath
  if (typeof path !== "string") return undefined
  if (tool !== "read" && tool !== "edit" && tool !== "write" && tool !== "patch") return undefined
  return path
}

/** Format an instruction file for the system prompt. */
function formatInstruction(file: string, text: string): string {
  return `<claude_md path="${file}">\n${text}\n</claude_md>`
}

/** Read a file as text, returning undefined when it cannot be read. */
function readTextFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** List the files in a directory, sorted by name. */
function readDirectoryFiles(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((entry) => !isDirectory(path.join(directory, entry)))
      .sort()
      .map((entry) => path.join(directory, entry))
  } catch {
    return []
  }
}

/** Split the argument text of a command into arguments. */
function splitArguments(input: string): string[] {
  const args: string[] = []
  let current = ""
  let quote: string | undefined
  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = undefined
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) args.push(current)
  return args
}

/** Map declared argument names onto the arguments the user passed. */
function resolveNamedArguments(declared: string[], args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  declared.forEach((name, index) => {
    result[name] = args[index] ?? ""
  })
  return result
}
