/**
 * Discovery of Claude Code skills, commands, and agents.
 *
 * Claude Code keeps these in parallel trees:
 *
 *   <root>/skills/<name>/SKILL.md      a skill
 *   <root>/commands/<name>.md          a command
 *   <root>/agents/<name>.md            a subagent
 *
 * A plugin ships the same three trees under its own root, and namespaces
 * every component it provides as `<plugin>:<name>`.
 */

import { readdirSync } from "node:fs"
import path from "node:path"
import { isDirectory, isFile } from "./paths.ts"
import { readFrontmatter, type Frontmatter } from "./frontmatter.ts"

export interface ClaudeSkill {
  /** Skill identifier, namespaced with the plugin when the skill comes from one. */
  readonly id: string
  /** Unnamespaced identifier, as Claude Code derives it. */
  readonly name: string
  /** Path to the `SKILL.md` file. */
  readonly file: string
  /** Directory that holds the skill, used to resolve bundled files. */
  readonly dir: string
  readonly frontmatter: Frontmatter
  /** Plugin that provides the skill, when it comes from one. */
  readonly plugin?: string
}

export interface ClaudeCommand {
  readonly id: string
  readonly name: string
  readonly file: string
  readonly frontmatter: Frontmatter
  readonly plugin?: string
}

export interface ClaudeAgent {
  readonly id: string
  readonly name: string
  readonly file: string
  readonly frontmatter: Frontmatter
  readonly plugin?: string
}

/** Read the skills under a `skills` directory. */
export function scanSkills(root: string, plugin?: string): ClaudeSkill[] {
  const skills: ClaudeSkill[] = []
  if (!isDirectory(root)) return skills
  for (const entry of readEntries(root)) {
    const file = path.join(root, entry)
    if (!isDirectory(file)) continue
    const skillFile = path.join(file, "SKILL.md")
    if (!isFile(skillFile)) continue
    const frontmatter = readFrontmatter(skillFile)
    const name = stringField(frontmatter.data, "name") ?? entry
    skills.push({
      id: plugin ? `${plugin}:${name}` : name,
      name,
      file: skillFile,
      dir: file,
      frontmatter,
      plugin,
    })
  }
  return skills
}

/** Read the commands under a `commands` directory. */
export function scanCommands(root: string, plugin?: string): ClaudeCommand[] {
  const commands: ClaudeCommand[] = []
  if (!isDirectory(root)) return commands
  for (const file of walkMarkdown(root)) {
    const relative = path.relative(root, file).replaceAll("\\", "/")
    const name = relative.replace(/\.md$/, "")
    commands.push({
      id: plugin ? `${plugin}:${name}` : name,
      name,
      file,
      frontmatter: readFrontmatter(file),
      plugin,
    })
  }
  return commands
}

/** Read the agents under an `agents` directory. */
export function scanAgents(root: string, plugin?: string): ClaudeAgent[] {
  const agents: ClaudeAgent[] = []
  if (!isDirectory(root)) return agents
  for (const file of walkMarkdown(root)) {
    const relative = path.relative(root, file).replaceAll("\\", "/")
    const name = relative.replace(/\.md$/, "")
    const frontmatter = readFrontmatter(file)
    agents.push({
      id: plugin ? `${plugin}:${name}` : name,
      name: stringField(frontmatter.data, "name") ?? name,
      file,
      frontmatter,
      plugin,
    })
  }
  return agents
}

/** List the immediate entries of a directory, sorted by name. */
function readEntries(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** List every Markdown file under a directory, recursively, sorted by path. */
function walkMarkdown(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string) => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(full)
    }
  }
  visit(root)
  return files
}

/** Read a frontmatter field as a string. */
export function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === "string" ? value : undefined
}

/** Read a frontmatter field as a list of strings. */
export function listField(data: Record<string, unknown>, key: string): string[] {
  const value = data[key]
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string")
  }
  return []
}
