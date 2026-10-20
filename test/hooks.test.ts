import { describe, expect, test } from "bun:test"
import { matchMatcher, mergeHookConfigs, parseHookConfig } from "../src/claude/hooks.ts"

describe("parseHookConfig", () => {
  test("reads a bare event map", () => {
    const config = parseHookConfig({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "check.sh" }] }],
    })
    expect(config.PreToolUse?.[0]?.matcher).toBe("Bash")
    expect(config.PreToolUse?.[0]?.hooks[0]?.command).toBe("check.sh")
  })

  test("reads the wrapped shape a plugin uses", () => {
    const config = parseHookConfig({
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "after.sh" }] }] },
    })
    expect(config.PostToolUse?.[0]?.hooks[0]?.command).toBe("after.sh")
  })

  test("keeps the handler fields the bridge uses", () => {
    const config = parseHookConfig({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "c.sh", args: ["--x"], if: "Bash(git *)", timeout: 10 }],
        },
      ],
    })
    const handler = config.PreToolUse?.[0]?.hooks[0]
    expect(handler?.args).toEqual(["--x"])
    expect(handler?.if).toBe("Bash(git *)")
    expect(handler?.timeout).toBe(10)
  })

  test("drops a handler that is not a command", () => {
    const config = parseHookConfig({
      PreToolUse: [{ hooks: [{ type: "http", url: "https://example.com" }] }],
    })
    expect(config.PreToolUse).toBeUndefined()
  })

  test("returns nothing for a value that is not an object", () => {
    expect(parseHookConfig(undefined)).toEqual({})
    expect(parseHookConfig("nope")).toEqual({})
  })
})

describe("mergeHookConfigs", () => {
  test("merges handlers for the same matcher", () => {
    const merged = mergeHookConfigs(
      { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "a.sh" }] }] },
      { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "b.sh" }] }] },
    )
    expect(merged.PreToolUse?.[0]?.hooks.map((h) => h.command)).toEqual(["a.sh", "b.sh"])
  })

  test("keeps different matchers apart", () => {
    const merged = mergeHookConfigs(
      { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "a.sh" }] }] },
      { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "b.sh" }] }] },
    )
    expect(merged.PreToolUse).toHaveLength(2)
  })
})

describe("matchMatcher", () => {
  test("matches every tool for an empty or star matcher", () => {
    expect(matchMatcher(undefined, "Bash")).toBe(true)
    expect(matchMatcher("", "Bash")).toBe(true)
    expect(matchMatcher("*", "Bash")).toBe(true)
  })

  test("matches an exact name", () => {
    expect(matchMatcher("Bash", "Bash")).toBe(true)
    expect(matchMatcher("Bash", "Edit")).toBe(false)
  })

  test("matches a pipe-separated list", () => {
    expect(matchMatcher("Bash|Grep", "Grep")).toBe(true)
    expect(matchMatcher("Bash|Grep", "Edit")).toBe(false)
  })

  test("matches a comma-separated list", () => {
    expect(matchMatcher("Bash, Grep", "Grep")).toBe(true)
  })

  test("treats other characters as a regular expression", () => {
    expect(matchMatcher("mcp__.*", "mcp__memory__read")).toBe(true)
    expect(matchMatcher("mcp__.*", "Bash")).toBe(false)
  })

  test("does not match when the pattern is invalid", () => {
    expect(matchMatcher("([", "Bash")).toBe(false)
  })
})
