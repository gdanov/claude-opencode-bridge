/**
 * Claude Code rules.
 *
 * A rule is a Markdown file under `.claude/rules/`. A rule that carries a
 * `paths` frontmatter field applies only to files that match one of its
 * patterns; a rule without one applies everywhere.
 */

import { readFrontmatter } from "./frontmatter.ts"

/** A rule file, with the path patterns that scope it. */
export interface Rule {
  readonly file: string
  /** Patterns that scope the rule, when it is scoped. */
  readonly paths?: string[]
}

/**
 * Read the path patterns that scope a rule.
 *
 * A rule without patterns applies everywhere, so it has no scope.
 */
export function readRulePaths(file: string): string[] | undefined {
  const paths = readFrontmatter(file).data.paths
  if (typeof paths === "string") {
    const list = paths.split(",").map((item) => item.trim()).filter(Boolean)
    return list.length > 0 ? list : undefined
  }
  if (Array.isArray(paths)) {
    const list = paths.filter((item): item is string => typeof item === "string")
    return list.length > 0 ? list : undefined
  }
  return undefined
}

/**
 * Match a path against a glob pattern.
 *
 * A rule's patterns are relative to the project it belongs to, so the path
 * is matched as given, relative to the project directory, and with its
 * leading slash removed.
 */
export function matchesPath(pattern: string, file: string, projectDir?: string): boolean {
  const normalized = file.replaceAll("\\", "/")
  const expression = globToRegExp(pattern)
  if (expression.test(normalized)) return true

  const candidates = [normalized.replace(/^\/+/, "")]
  if (projectDir) {
    const root = projectDir.replaceAll("\\", "/").replace(/\/+$/, "")
    if (normalized.startsWith(`${root}/`)) {
      candidates.push(normalized.slice(root.length + 1))
    }
  }
  return candidates.some((candidate) => expression.test(candidate))
}

/** Whether any of the patterns matches any of the files. */
export function matchesAnyPath(
  patterns: readonly string[],
  files: ReadonlySet<string>,
  projectDir?: string,
): boolean {
  for (const pattern of patterns) {
    for (const file of files) {
      if (matchesPath(pattern, file, projectDir)) return true
    }
  }
  return false
}

/**
 * Turn a glob pattern into a regular expression.
 *
 * A `**` matches any number of path segments, including none, and a single
 * `*` matches within one segment.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = ""
  let index = 0

  while (index < pattern.length) {
    const char = pattern[index] as string
    if (char === "*") {
      const isDouble = pattern[index + 1] === "*"
      if (isDouble) {
        const followedBySlash = pattern[index + 2] === "/"
        if (followedBySlash) {
          // `**/` matches zero or more leading directories.
          source += "(?:[^/]+/)*"
          index += 3
          continue
        }
        source += ".*"
        index += 2
        continue
      }
      source += "[^/]*"
      index += 1
      continue
    }
    if (char === "?") {
      source += "[^/]"
      index += 1
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    index += 1
  }

  return new RegExp(`^${source}$`)
}
