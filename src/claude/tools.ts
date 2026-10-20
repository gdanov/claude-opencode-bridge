/**
 * Mapping between Claude Code's tool model and OpenCode's.
 *
 * Claude Code names its tools `Bash`, `Read`, `Edit`, and so on, and gives
 * each tool its own input shape. OpenCode names tools `shell`, `read`, `edit`,
 * and uses camelCase input fields. Hooks written for Claude Code match on
 * Claude's names, so the bridge translates in both directions.
 */

/** Claude Code tool names, keyed by their OpenCode equivalents. */
const CLAUDE_TO_OPENCODE: Record<string, string> = {
  Bash: "shell",
  BashOutput: "shell",
  KillShell: "shell",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "write",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  Task: "subagent",
  Skill: "skill",
  TodoWrite: "todowrite",
  ExitPlanMode: "exitplanmode",
  AskUserQuestion: "question",
}

/**
 * The reverse mapping, resolved explicitly.
 *
 * Several Claude Code tools share one OpenCode tool, so the reverse direction
 * needs a preference. The first Claude tool listed for an OpenCode tool is the
 * one that names it.
 */
const OPENCODE_TO_CLAUDE: Record<string, string> = {
  shell: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  patch: "Edit",
  glob: "Glob",
  grep: "Grep",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  subagent: "Task",
  skill: "Skill",
  question: "AskUserQuestion",
  todowrite: "TodoWrite",
}

/** Translate a Claude Code tool name into the OpenCode equivalent. */
export function toOpenCodeTool(claude: string): string {
  return CLAUDE_TO_OPENCODE[claude] ?? claude
}

/** Translate an OpenCode tool name into the Claude Code equivalent. */
export function toClaudeTool(opencode: string): string {
  return OPENCODE_TO_CLAUDE[opencode] ?? opencode
}

/**
 * Translate an OpenCode tool input into the Claude Code shape.
 *
 * Claude Code expects `file_path` where OpenCode uses `path`, and snake_case
 * keys elsewhere. Keys Claude Code does not know about are passed through, so
 * a hook reading a field it does not recognise still sees it.
 */
export function toClaudeToolInput(tool: string, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const source = input as Record<string, unknown>
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(source)) {
    switch (key) {
      case "path":
        result.file_path = value
        break
      case "oldString":
        result.old_string = value
        break
      case "newString":
        result.new_string = value
        break
      case "replaceAll":
        result.replace_all = value
        break
      case "workdir":
        result.cwd = value
        break
      case "background":
        result.run_in_background = value
        break
      case "caseSensitive":
        result["-i"] = value === true ? true : undefined
        break
      case "include":
        result.glob = value
        break
      case "limit":
        result.limit = value
        break
      default:
        result[key] = value
    }
    if (result["-i"] === undefined) delete result["-i"]
  }

  if (tool === "shell" && typeof result.command === "string" && result.description === undefined) {
    // Claude Code describes the command separately; keep the shape minimal.
    delete result.description
  }

  return result
}

/**
 * Translate a Claude Code tool input into the OpenCode shape.
 *
 * This is the inverse of {@link toClaudeToolInput} and is used when a Claude
 * Code hook rewrites a tool's arguments.
 */
export function toOpenCodeToolInput(tool: string, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const source = input as Record<string, unknown>
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(source)) {
    switch (key) {
      case "file_path":
        result.path = value
        break
      case "old_string":
        result.oldString = value
        break
      case "new_string":
        result.newString = value
        break
      case "replace_all":
        result.replaceAll = value
        break
      case "cwd":
        result.workdir = value
        break
      case "run_in_background":
        result.background = value
        break
      case "glob":
        result.include = value
        break
      case "-i":
        if (value !== undefined) result.caseSensitive = value !== true
        break
      default:
        result[key] = value
    }
  }

  return result
}

/**
 * Test whether a Claude Code permission rule matches a tool call.
 *
 * Claude Code rules look like `Bash(git status:*)` or `Edit(*.ts)`. The rule
 * names a tool, an optional argument pattern, and an optional trailing `:`
 * that means "starts with".
 */
export function matchPermissionRule(rule: string, tool: string, input: unknown): boolean {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/.exec(rule.trim())
  if (!match) {
    // A bare rule names a tool and matches every call to it.
    return rule.trim() === tool
  }
  const [, ruleTool, pattern] = match
  if (ruleTool !== tool) return false
  if (!pattern) return true

  const subject = ruleSubject(tool, input)
  if (subject === undefined) return false

  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2)
    return subject.startsWith(prefix)
  }
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
    return new RegExp(`^${escaped}$`).test(subject)
  }
  return subject === pattern
}

/**
 * Pick the value a permission rule is matched against.
 *
 * File rules match the path, shell rules match the command, and search rules
 * match the pattern.
 */
function ruleSubject(tool: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const source = input as Record<string, unknown>
  switch (tool) {
    case "Bash":
      return typeof source.command === "string" ? source.command : undefined
    case "Read":
    case "Edit":
    case "Write":
      return typeof source.file_path === "string" ? source.file_path : undefined
    case "Grep":
    case "Glob":
      return typeof source.pattern === "string" ? source.pattern : undefined
    default:
      return undefined
  }
}
