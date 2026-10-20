/**
 * Parsing of Claude Code hook configuration.
 *
 * A hook configuration maps an event name to a list of matcher groups, and
 * each group holds one or more handlers:
 *
 *   { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", ... } ] } ] }
 *
 * Sources are `settings.json` in the user and project roots, plus the
 * `hooks/hooks.json` file that every plugin may ship.
 */

import path from "node:path"
import { isFile, readJSON } from "./paths.ts"

export interface ClaudeHookHandler {
  readonly type: string
  /** Shell command, either as a string or as an executable plus arguments. */
  readonly command?: string
  readonly args?: string[]
  /** Permission-rule filter that decides whether the handler runs. */
  readonly if?: string
  readonly timeout?: number
  readonly async?: boolean
  /** Whether a failure blocks the action. */
  readonly onFailure?: string
  readonly statusMessage?: string
}

export interface ClaudeHookGroup {
  /** Tool name, agent name, or event-specific selector. */
  readonly matcher?: string
  readonly hooks: ClaudeHookHandler[]
}

export interface ClaudeHookConfig {
  readonly [event: string]: ClaudeHookGroup[]
}

/**
 * Read hook configuration from a `hooks` value.
 *
 * Accepts both the wrapped shape plugins use (`{ "hooks": { ... } }`) and the
 * bare event map that `settings.json` uses.
 */
export function parseHookConfig(value: unknown): ClaudeHookConfig {
  if (!value || typeof value !== "object") return {}
  const source = value as Record<string, unknown>
  const events = source.hooks && typeof source.hooks === "object" ? (source.hooks as Record<string, unknown>) : source
  const result: Record<string, ClaudeHookGroup[]> = {}
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue
    const parsed: ClaudeHookGroup[] = []
    for (const group of groups) {
      if (!group || typeof group !== "object") continue
      const record = group as Record<string, unknown>
      const handlers = Array.isArray(record.hooks) ? record.hooks : []
      const list = handlers
        .filter((handler): handler is Record<string, unknown> => !!handler && typeof handler === "object")
        .map((handler) => ({
          type: typeof handler.type === "string" ? handler.type : "command",
          command: typeof handler.command === "string" ? handler.command : undefined,
          args: Array.isArray(handler.args)
            ? handler.args.filter((arg): arg is string => typeof arg === "string")
            : undefined,
          if: typeof handler.if === "string" ? handler.if : undefined,
          timeout: typeof handler.timeout === "number" ? handler.timeout : undefined,
          async: typeof handler.async === "boolean" ? handler.async : undefined,
          onFailure: typeof handler.onFailure === "string" ? handler.onFailure : undefined,
          statusMessage: typeof handler.statusMessage === "string" ? handler.statusMessage : undefined,
        }))
        .filter((handler) => handler.type === "command" && !!handler.command)
      if (list.length === 0) continue
      parsed.push({
        matcher: typeof record.matcher === "string" ? record.matcher : undefined,
        hooks: list,
      })
    }
    if (parsed.length > 0) result[event] = parsed
  }
  return result
}

/** Read a plugin's `hooks/hooks.json` file. */
export function readPluginHooks(pluginRoot: string): ClaudeHookConfig {
  const file = path.join(pluginRoot, "hooks", "hooks.json")
  if (!isFile(file)) return {}
  return parseHookConfig(readJSON(file))
}

/**
 * Merge hook configurations.
 *
 * Later sources take precedence for the same event and matcher, matching how
 * Claude Code lets project settings override user settings.
 */
export function mergeHookConfigs(...configs: ClaudeHookConfig[]): ClaudeHookConfig {
  const merged: Record<string, ClaudeHookGroup[]> = {}
  for (const config of configs) {
    for (const [event, groups] of Object.entries(config)) {
      const existing = merged[event] ?? []
      for (const group of groups) {
        const index = existing.findIndex((candidate) => candidate.matcher === group.matcher)
        if (index === -1) {
          existing.push(group)
          continue
        }
        const previous = existing[index]
        if (!previous) continue
        existing[index] = { matcher: previous.matcher, hooks: [...previous.hooks, ...group.hooks] }
      }
      merged[event] = existing
    }
  }
  return merged
}

/**
 * Test a matcher against a value.
 *
 * Claude Code treats a matcher made only of letters, digits, underscores,
 * dashes, spaces, and pipes as a list of exact names. Anything else is a
 * JavaScript regular expression.
 */
export function matchMatcher(matcher: string | undefined, value: string): boolean {
  if (!matcher || matcher === "" || matcher === "*") return true
  if (/^[A-Za-z0-9_\- ,|]*$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .includes(value)
  }
  try {
    return new RegExp(matcher).test(value)
  } catch {
    return false
  }
}
