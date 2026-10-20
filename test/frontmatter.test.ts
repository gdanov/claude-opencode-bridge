import { describe, expect, test } from "bun:test"
import {
  namedArguments,
  parseArguments,
  parseFrontmatter,
  parseYaml,
  substitute,
} from "../src/claude/frontmatter.ts"

describe("parseYaml", () => {
  test("reads scalars", () => {
    expect(parseYaml("name: deploy\ncount: 3\nenabled: true")).toEqual({
      name: "deploy",
      count: 3,
      enabled: true,
    })
  })

  test("reads block sequences", () => {
    expect(parseYaml("tools:\n  - Read\n  - Grep")).toEqual({ tools: ["Read", "Grep"] })
  })

  test("reads inline sequences", () => {
    expect(parseYaml("tools: [Read, Grep]")).toEqual({ tools: ["Read", "Grep"] })
  })

  test("reads nested maps", () => {
    expect(parseYaml("metadata:\n  opencode/autoinvoke: false")).toEqual({
      metadata: { "opencode/autoinvoke": false },
    })
  })

  test("keeps a colon inside an unquoted value", () => {
    expect(parseYaml("description: Use when: the user asks")).toEqual({
      description: "Use when: the user asks",
    })
  })

  test("unwraps quoted values", () => {
    expect(parseYaml('description: "hello: world"')).toEqual({ description: "hello: world" })
  })

  test("ignores comments and blank lines", () => {
    expect(parseYaml("# a comment\n\nname: deploy\n")).toEqual({ name: "deploy" })
  })

  test("reads a literal block scalar", () => {
    expect(parseYaml("description: |\n  First line.\n  Second line.\n")).toEqual({
      description: "First line.\nSecond line.",
    })
  })

  test("reads a folded block scalar", () => {
    expect(parseYaml("description: >\n  First line.\n  Second line.\n")).toEqual({
      description: "First line. Second line.",
    })
  })

  test("keeps a blank line inside a block scalar", () => {
    expect(parseYaml("description: |\n  First.\n\n  Second.\n")).toEqual({
      description: "First.\n\nSecond.",
    })
  })

  test("reads a nested map under a key with a slash", () => {
    expect(parseYaml("metadata:\n  opencode/autoinvoke: false")).toEqual({
      metadata: { "opencode/autoinvoke": false },
    })
  })

  test("reads a sequence of mappings", () => {
    expect(parseYaml("hooks:\n  - matcher: Bash\n    type: command\n")).toEqual({
      hooks: [{ matcher: "Bash", type: "command" }],
    })
  })
})

describe("parseFrontmatter", () => {
  test("splits frontmatter from the body", () => {
    const result = parseFrontmatter("---\nname: deploy\n---\n\nBody text\n")
    expect(result.data).toEqual({ name: "deploy" })
    expect(result.content.trim()).toBe("Body text")
  })

  test("treats a file without frontmatter as all body", () => {
    const result = parseFrontmatter("Just body\n")
    expect(result.data).toEqual({})
    expect(result.content).toBe("Just body\n")
  })

  test("only reads frontmatter when it opens the file", () => {
    const result = parseFrontmatter("Intro\n---\nname: deploy\n---\n")
    expect(result.data).toEqual({})
    expect(result.content).toBe("Intro\n---\nname: deploy\n---\n")
  })
})

describe("parseArguments", () => {
  test("splits on whitespace", () => {
    expect(parseArguments("one two three")).toEqual(["one", "two", "three"])
  })

  test("keeps quoted spans together", () => {
    expect(parseArguments('one "two three" four')).toEqual(["one", "two three", "four"])
  })

  test("returns nothing for empty input", () => {
    expect(parseArguments("   ")).toEqual([])
  })
})

describe("substitute", () => {
  test("expands $ARGUMENTS", () => {
    expect(substitute("Do $ARGUMENTS now", { arguments: "the thing" })).toBe("Do the thing now")
  })

  test("expands indexed arguments", () => {
    expect(substitute("First $0 second $1", { arguments: "a b" })).toBe("First a second b")
  })

  test("expands indexed arguments with brackets", () => {
    expect(substitute("First $ARGUMENTS[0]", { arguments: "a b" })).toBe("First a")
  })

  test("leaves an indexed placeholder without a value alone", () => {
    expect(substitute("Value $2", { arguments: "a b" })).toBe("Value $2")
  })

  test("expands named arguments", () => {
    expect(substitute("Issue $number", { named: { number: "42" } })).toBe("Issue 42")
  })

  test("honours a backslash escape", () => {
    expect(substitute("Cost \\$1.00", { arguments: "5" })).toBe("Cost $1.00")
  })

  test("does not expand a value that contains a placeholder", () => {
    expect(substitute("Value $0", { arguments: "$ARGUMENTS" })).toBe("Value $ARGUMENTS")
  })

  test("expands the Claude Code variables", () => {
    expect(substitute("Run ${CLAUDE_SKILL_DIR}/x.sh", { skillDir: "/skills/deploy" })).toBe(
      "Run /skills/deploy/x.sh",
    )
  })

  test("leaves an unknown variable alone", () => {
    expect(substitute("Run ${CLAUDE_PLUGIN_ROOT}/x.sh", {})).toBe("Run ${CLAUDE_PLUGIN_ROOT}/x.sh")
  })
})

describe("namedArguments", () => {
  test("reads a list of names", () => {
    expect(namedArguments({ arguments: ["issue", "branch"] })).toEqual(["issue", "branch"])
  })

  test("reads a space-separated string", () => {
    expect(namedArguments({ arguments: "issue branch" })).toEqual(["issue", "branch"])
  })

  test("returns nothing when absent", () => {
    expect(namedArguments({})).toEqual([])
  })
})
