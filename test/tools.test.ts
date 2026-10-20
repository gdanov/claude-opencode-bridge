import { describe, expect, test } from "bun:test"
import {
  matchPermissionRule,
  toClaudeTool,
  toClaudeToolInput,
  toOpenCodeTool,
} from "../src/claude/tools.ts"

describe("tool names", () => {
  test("maps Claude Code names to OpenCode names", () => {
    expect(toOpenCodeTool("Bash")).toBe("shell")
    expect(toOpenCodeTool("Read")).toBe("read")
    expect(toOpenCodeTool("Edit")).toBe("edit")
    expect(toOpenCodeTool("Grep")).toBe("grep")
    expect(toOpenCodeTool("Glob")).toBe("glob")
    expect(toOpenCodeTool("WebFetch")).toBe("webfetch")
    expect(toOpenCodeTool("Task")).toBe("subagent")
  })

  test("maps OpenCode names back to Claude Code names", () => {
    expect(toClaudeTool("shell")).toBe("Bash")
    expect(toClaudeTool("edit")).toBe("Edit")
    expect(toClaudeTool("subagent")).toBe("Task")
  })

  test("leaves an unknown name alone", () => {
    expect(toOpenCodeTool("Custom")).toBe("Custom")
    expect(toClaudeTool("custom")).toBe("custom")
  })
})

describe("toClaudeToolInput", () => {
  test("renames path to file_path", () => {
    expect(toClaudeToolInput("read", { path: "/tmp/a.txt" })).toEqual({ file_path: "/tmp/a.txt" })
  })

  test("renames the edit fields", () => {
    expect(
      toClaudeToolInput("edit", { path: "/tmp/a.txt", oldString: "a", newString: "b", replaceAll: true }),
    ).toEqual({ file_path: "/tmp/a.txt", old_string: "a", new_string: "b", replace_all: true })
  })

  test("keeps the shell command", () => {
    expect(toClaudeToolInput("shell", { command: "ls -la" })).toEqual({ command: "ls -la" })
  })

  test("passes unknown fields through", () => {
    expect(toClaudeToolInput("shell", { command: "ls", extra: 1 })).toEqual({ command: "ls", extra: 1 })
  })

  test("returns an empty object for a non-object input", () => {
    expect(toClaudeToolInput("shell", "ls")).toEqual({})
  })
})

describe("matchPermissionRule", () => {
  test("matches a bare tool name", () => {
    expect(matchPermissionRule("Bash", "Bash", { command: "ls" })).toBe(true)
    expect(matchPermissionRule("Bash", "Read", { file_path: "/a" })).toBe(false)
  })

  test("matches a command prefix", () => {
    expect(matchPermissionRule("Bash(git status:*)", "Bash", { command: "git status --short" })).toBe(true)
    expect(matchPermissionRule("Bash(git status:*)", "Bash", { command: "git push" })).toBe(false)
  })

  test("matches a file glob", () => {
    expect(matchPermissionRule("Edit(*.ts)", "Edit", { file_path: "/a/b.ts" })).toBe(true)
    expect(matchPermissionRule("Edit(*.ts)", "Edit", { file_path: "/a/b.md" })).toBe(false)
  })

  test("matches an exact command", () => {
    expect(matchPermissionRule("Bash(npm test)", "Bash", { command: "npm test" })).toBe(true)
    expect(matchPermissionRule("Bash(npm test)", "Bash", { command: "npm test --watch" })).toBe(false)
  })

  test("matches a search pattern", () => {
    expect(matchPermissionRule("Grep(*.ts)", "Grep", { pattern: "*.ts" })).toBe(true)
  })
})
