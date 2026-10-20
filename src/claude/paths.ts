/**
 * Resolution of the Claude Code configuration tree.
 *
 * Claude Code keeps its assets in several roots, each with a different scope:
 *
 *   ~/.claude                              user scope
 *   <project>/.claude                      project scope
 *   ~/.claude/plugins/cache/<mkt>/<p>/<v>  installed plugin version
 *   ~/.claude/plugins/marketplaces/<mkt>   marketplace checkout
 *
 * `CLAUDE_CONFIG_DIR` overrides the user root, mirroring Claude Code itself.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export interface ClaudeRoots {
  /** User-scope Claude directory (`~/.claude` or `$CLAUDE_CONFIG_DIR`). */
  readonly user: string
  /** Project-scope Claude directory (`<project>/.claude`), when present. */
  readonly project?: string
  /** Directory holding installed plugins and marketplace checkouts. */
  readonly plugins: string
}

/** Read a JSON file, returning undefined when it is missing or unparsable. */
export function readJSON<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

/** The user-scope Claude Code directory. */
export function claudeUserDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR
  if (override && override.trim()) return path.resolve(override.trim())
  return path.join(homedir(), ".claude")
}

/**
 * Resolve the Claude Code roots relevant to a project directory.
 *
 * The project root is walked upwards so that a session launched from a
 * subdirectory still sees the repository-level `.claude` directory, matching
 * how Claude Code discovers project configuration.
 */
export function resolveRoots(projectDirectory: string, env: NodeJS.ProcessEnv = process.env): ClaudeRoots {
  const user = claudeUserDir(env)
  const plugins = path.join(user, "plugins")
  const project = findProjectClaudeDir(projectDirectory)
  return { user, project, plugins }
}

/**
 * Walk upwards from `start` looking for a `.claude` directory.
 *
 * The walk stops at the first `.git` boundary or the filesystem root, so a
 * session inside a nested repository never picks up an unrelated parent's
 * configuration.
 */
export function findProjectClaudeDir(start: string): string | undefined {
  let current = path.resolve(start)
  for (;;) {
    const candidate = path.join(current, ".claude")
    if (isDirectory(candidate)) return candidate
    if (isDirectory(path.join(current, ".git"))) return undefined
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** True when the path exists and is a directory. */
export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** True when the path exists and is a regular file. */
export function isFile(target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

/** True when the path exists at all. */
export function exists(target: string): boolean {
  return existsSync(target)
}
