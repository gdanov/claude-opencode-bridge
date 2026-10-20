/**
 * Frontmatter parsing and Claude Code content templates.
 *
 * Claude Code writes YAML frontmatter above Markdown bodies, and expands
 * placeholders inside the body when a skill, command, or agent is used.
 */

import { readFileSync } from "node:fs"
import path from "node:path"

export interface Frontmatter {
  readonly data: Record<string, unknown>
  readonly content: string
}

/**
 * Parse leading YAML frontmatter.
 *
 * The body is returned verbatim when there is no frontmatter block, which
 * matches Claude Code: it only reads frontmatter when `---` opens the file.
 */
export function parseFrontmatter(raw: string): Frontmatter {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match) return { data: {}, content: raw }
  return { data: parseYaml(match[1] ?? ""), content: raw.slice(match[0].length) }
}

/**
 * Parse the YAML subset that Claude Code frontmatter uses.
 *
 * Supports scalars, inline and block sequences, and nested maps, which covers
 * every field Claude Code documents. Keys may contain `/`, as in
 * `metadata.opencode/autoinvoke`. A value that holds an unquoted colon, which
 * strict YAML would reject but Claude Code accepts, is read as a plain scalar.
 */
export function parseYaml(source: string): Record<string, unknown> {
  const lines = source.split(/\r?\n/).map((raw) => ({
    indent: raw.length - raw.trimStart().length,
    text: raw.trim(),
    raw,
  }))

  const [value] = parseBlock(lines, 0, lines[0]?.indent ?? 0)
  return isRecord(value) ? value : {}
}

/** A source line with its indentation and original text kept. */
interface YamlLine {
  readonly indent: number
  readonly text: string
  readonly raw: string
}

/** Whether a line carries content rather than whitespace or a comment. */
function isContent(line: YamlLine): boolean {
  return line.text !== "" && !line.text.startsWith("#")
}

/**
 * Parse a run of lines that share an indentation level.
 *
 * Returns the parsed value and the index of the first line that belongs to
 * the next, less-indented block.
 */
function parseBlock(lines: YamlLine[], start: number, indent: number): [unknown, number] {
  const first = lines.slice(start).find(isContent)
  if (!first) return [null, lines.length]
  if (first.text.startsWith("- ") || first.text === "-") {
    return parseSequence(lines, start, indent)
  }
  return parseMapping(lines, start, indent)
}

/** Parse a mapping at the given indentation level. */
function parseMapping(lines: YamlLine[], start: number, indent: number): [Record<string, unknown>, number] {
  const map: Record<string, unknown> = {}
  let index = start

  while (index < lines.length) {
    const line = lines[index]
    if (!line || line.indent < indent) break
    if (line.indent > indent || !isContent(line)) {
      index++
      continue
    }
    const entry = parseEntry(line.text)
    if (!entry) {
      index++
      continue
    }
    const [key, rest] = entry
    index++
    if (rest !== "") {
      // A block scalar (`|` or `>`) opens an indented block of text.
      if (isBlockScalar(rest)) {
        const [value, consumed] = parseBlockScalar(lines, index, indent, rest)
        map[key] = value
        index = consumed
        continue
      }
      map[key] = parseScalar(rest)
      continue
    }
    // A key with no inline value opens a block that is more deeply indented.
    const next = lines.slice(index).find(isContent)
    if (next && next.indent > indent) {
      const [value, consumed] = parseBlock(lines, index, next.indent)
      map[key] = value
      index = consumed
      continue
    }
    map[key] = null
  }

  return [map, index]
}

/** Parse a sequence at the given indentation level. */
function parseSequence(lines: YamlLine[], start: number, indent: number): [unknown[], number] {
  const items: unknown[] = []
  let index = start

  while (index < lines.length) {
    const line = lines[index]
    if (!line || line.indent < indent) break
    if (line.indent > indent || !isContent(line)) {
      index++
      continue
    }
    if (!line.text.startsWith("-")) break

    const inline = line.text.slice(1).trim()
    index++
    if (inline !== "") {
      // `- key: value` starts a mapping whose first key sits on the dash line.
      const entry = parseEntry(inline)
      if (entry) {
        const [key, rest] = entry
        const item: Record<string, unknown> = {}
        if (rest !== "") {
          if (isBlockScalar(rest)) {
            const [value, consumed] = parseBlockScalar(lines, index, indent, rest)
            item[key] = value
            index = consumed
          } else {
            item[key] = parseScalar(rest)
          }
        } else {
          const next = lines.slice(index).find(isContent)
          if (next && next.indent > indent) {
            const [value, consumed] = parseBlock(lines, index, next.indent)
            item[key] = value
            index = consumed
          } else item[key] = null
        }
        const [rest2, consumed2] = parseMapping(lines, index, indent + 2)
        Object.assign(item, rest2)
        index = consumed2
        items.push(item)
        continue
      }
      items.push(parseScalar(inline))
      continue
    }
    const next = lines.slice(index).find(isContent)
    if (next && next.indent > indent) {
      const [value, consumed] = parseBlock(lines, index, next.indent)
      items.push(value)
      index = consumed
      continue
    }
    items.push(null)
  }

  return [items, index]
}

/**
 * Split a mapping line into its key and the rest of the line.
 *
 * The key ends at the first colon that is followed by a space or the end of
 * the line, so a value may itself contain a colon.
 */
function parseEntry(text: string): [string, string] | undefined {
  const match = /^([^:]+?)\s*:\s*(.*)$/.exec(text)
  if (!match || match[1] === undefined) return undefined
  return [match[1].trim(), (match[2] ?? "").trim()]
}

/** Whether a value opens a YAML block scalar. */
function isBlockScalar(value: string): boolean {
  return value === "|" || value === ">" || value === "|-" || value === ">-" || value === "|+" || value === ">+"
}

/**
 * Read the body of a block scalar.
 *
 * A literal block (`|`) keeps its line breaks, and a folded block (`>`)
 * joins its lines with spaces. The base indentation of the block is
 * stripped from every line, and blank lines inside the block are kept.
 */
function parseBlockScalar(
  lines: YamlLine[],
  start: number,
  indent: number,
  marker: string,
): [string, number] {
  const body: YamlLine[] = []
  let cursor = start
  let base = Number.POSITIVE_INFINITY

  while (cursor < lines.length) {
    const line = lines[cursor]
    if (!line) break
    if (line.text !== "" && line.indent <= indent) break
    if (line.text !== "") base = Math.min(base, line.indent)
    body.push(line)
    cursor++
  }

  const strip = Number.isFinite(base) ? base : indent + 2
  const text = body
    .map((line) => (line.text === "" ? "" : line.raw.slice(strip).replace(/\s+$/, "")))
    .join("\n")

  const folded = marker.startsWith(">")
  const trimmed = marker.endsWith("-")
  let value = folded ? foldLines(text) : text
  if (!trimmed) value = value.replace(/\n+$/, "")
  return [value, cursor]
}

/** Join the lines of a folded block scalar with spaces. */
function foldLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) => line !== "" || lines[index - 1] === "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Read a YAML scalar, unwrapping quotes and inline sequences. */
function parseScalar(raw: string): unknown {
  const value = raw.trim()
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return splitTopLevel(inner).map((item) => parseScalar(item))
  }
  if (value.startsWith("{") && value.endsWith("}")) return parseYaml(value.slice(1, -1))
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    const inner = value.slice(1, -1)
    return value[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner
  }
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null" || value === "~") return null
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value)
  return value
}

/** Split a comma-separated inline sequence, respecting quotes. */
function splitTopLevel(source: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote: string | undefined
  for (const char of source) {
    if (quote) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ",") {
      parts.push(current)
      current = ""
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current)
  return parts
}

/** Read a file and split it into frontmatter and body. */
export function readFrontmatter(file: string): Frontmatter {
  return parseFrontmatter(readFileSync(file, "utf8"))
}

/** A Claude Code string substitution context. */
export interface SubstitutionContext {
  /** Arguments the user passed to the command. */
  readonly arguments?: string
  /** Named arguments declared in frontmatter, mapped to their values. */
  readonly named?: Record<string, string>
  /** Directory holding the skill or command file. */
  readonly skillDir?: string
  /** Project root directory. */
  readonly projectDir?: string
  /** Plugin root, for plugin-provided assets. */
  readonly pluginRoot?: string
  /** Plugin data directory. */
  readonly pluginData?: string
  /** Current session identifier. */
  readonly sessionID?: string
}

/**
 * Expand Claude Code placeholders in a body.
 *
 * Argument values are inserted literally, so an argument that itself contains
 * `$1` is not expanded again. A backslash escapes a placeholder.
 */
export function substitute(template: string, context: SubstitutionContext): string {
  const args = parseArguments(context.arguments ?? "")
  const named = context.named ?? {}

  let result = ""
  for (let index = 0; index < template.length; index++) {
    const char = template[index]
    if (char === "\\" && isPlaceholderStart(template, index + 1, named)) {
      result += template[index + 1]
      // The loop increments again, so stop one character short of whatever
      // follows the escaped placeholder.
      index += 1
      continue
    }
    if (char === "$") {
      const replaced = expandPlaceholder(template, index, args, named)
      if (replaced !== undefined) {
        result += replaced.value
        index = replaced.next - 1
        continue
      }
    }
    result += char
  }

  return expandClaudeVariables(result, context)
}

/** Decide whether a `$` at `index` starts a placeholder, and expand it. */
function expandPlaceholder(
  template: string,
  index: number,
  args: string[],
  named: Record<string, string>,
): { value: string; next: number } | undefined {
  if (template.startsWith("${", index)) {
    const end = template.indexOf("}", index + 2)
    if (end === -1) return undefined
    const name = template.slice(index + 2, end)
    if (name === "ARGUMENTS") return { value: args.join(" "), next: end + 1 }
    // The `${CLAUDE_*}` variables are expanded after the arguments are
    // inserted, so they must survive this step untouched.
    if (name.startsWith("CLAUDE_")) return undefined
    if (!Object.hasOwn(named, name)) return undefined
    return { value: named[name] ?? "", next: end + 1 }
  }
  if (template.startsWith("$ARGUMENTS[", index)) {
    const end = template.indexOf("]", index)
    if (end === -1) return undefined
    const position = Number(template.slice(index + "$ARGUMENTS[".length, end))
    if (!Number.isInteger(position)) return undefined
    const value = args[position]
    return { value: value ?? "", next: end + 1 }
  }
  if (template.startsWith("$ARGUMENTS", index)) {
    return { value: args.join(" "), next: index + "$ARGUMENTS".length }
  }
  const digit = /^\$([0-9]+)/.exec(template.slice(index))
  if (digit) {
    const position = Number(digit[1])
    const value = args[position]
    if (value === undefined) return undefined
    return { value, next: index + digit[0].length }
  }
  const namedMatch = /^\$([A-Za-z_][A-Za-z0-9_-]*)/.exec(template.slice(index))
  const namedName = namedMatch?.[1]
  if (namedMatch && namedName !== undefined && Object.hasOwn(named, namedName)) {
    return { value: named[namedName] ?? "", next: index + namedMatch[0].length }
  }
  return undefined
}

/**
 * Whether a `$` at `index` starts a placeholder, and expand it.
 *
 * A backslash escapes the `$` that follows it, but only for placeholders that
 * consume arguments. The `${CLAUDE_*}` variables are expanded separately, so
 * a backslash does not shield them.
 */
function isPlaceholderStart(template: string, index: number, named: Record<string, string>): boolean {
  const rest = template.slice(index)
  if (rest.startsWith("${CLAUDE_")) return false
  if (rest.startsWith("${ARGUMENTS}")) return true
  if (rest.startsWith("$ARGUMENTS")) return true
  if (/^\$\d/.test(rest)) return true
  const namedMatch = /^\$([A-Za-z_][A-Za-z0-9_-]*)/.exec(rest)
  const name = namedMatch?.[1]
  return name !== undefined && Object.hasOwn(named, name)
}

/** Expand the `${CLAUDE_*}` variables that Claude Code defines. */
function expandClaudeVariables(template: string, context: SubstitutionContext): string {
  const variables: Record<string, string | undefined> = {
    CLAUDE_SKILL_DIR: context.skillDir,
    CLAUDE_PROJECT_DIR: context.projectDir,
    CLAUDE_PLUGIN_ROOT: context.pluginRoot,
    CLAUDE_PLUGIN_DATA: context.pluginData,
    CLAUDE_SESSION_ID: context.sessionID,
  }
  return template.replace(/\$\{CLAUDE_[A-Z_]+\}/g, (match) => {
    const name = match.slice(2, -1)
    const value = variables[name]
    return value === undefined ? match : value
  })
}

/**
 * Split an argument string into arguments.
 *
 * Quoted spans stay together, matching Claude Code's shell-style quoting.
 */
export function parseArguments(input: string): string[] {
  const args: string[] = []
  let current = ""
  let quote: string | undefined
  let started = false
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
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current) {
        args.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += char
  }
  if (started || current) args.push(current)
  return args
}

/**
 * Resolve the `arguments` frontmatter field into the names it declares.
 *
 * The field is either a list of names or a space-separated string of names.
 */
export function namedArguments(frontmatter: Record<string, unknown>): string[] {
  const declared = frontmatter.arguments
  if (typeof declared === "string") {
    return declared.split(/\s+/).filter(Boolean)
  }
  if (Array.isArray(declared)) {
    return declared.filter((name): name is string => typeof name === "string")
  }
  return []
}

/** The directory that holds a skill or command file. */
export function directoryOf(file: string): string {
  return path.dirname(file)
}

/** Whether a value is a plain object rather than an array or a scalar. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
