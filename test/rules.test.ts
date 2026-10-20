import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const { readRulePaths, matchesPath } = await import("../src/claude/rules.ts")

function writeRule(frontmatter: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-rule-"))
  const file = path.join(dir, "rule.md")
  writeFileSync(file, `---\n${frontmatter}\n---\n\nBody.\n`)
  return file
}

describe("readRulePaths", () => {
  test("reads a list of patterns", () => {
    const file = writeRule('paths:\n  - "**/*.ts"\n  - "**/*.tsx"')
    expect(readRulePaths(file)).toEqual(["**/*.ts", "**/*.tsx"])
  })

  test("reads a comma-separated list", () => {
    const file = writeRule('paths: "**/*.ts, **/*.tsx"')
    expect(readRulePaths(file)).toEqual(["**/*.ts", "**/*.tsx"])
  })

  test("returns nothing for a rule that applies everywhere", () => {
    const file = writeRule("name: general")
    expect(readRulePaths(file)).toBeUndefined()
  })
})

describe("matchesPath", () => {
  const root = "/repo"

  test("matches a typescript file at any depth", () => {
    expect(matchesPath("**/*.ts", "/repo/src/a.ts", root)).toBe(true)
    expect(matchesPath("**/*.ts", "src/a.ts", root)).toBe(true)
  })

  test("does not match a different extension", () => {
    expect(matchesPath("**/*.ts", "/repo/src/a.md", root)).toBe(false)
  })

  test("matches a markdown file", () => {
    expect(matchesPath("**/*.md", "/repo/docs/a.md", root)).toBe(true)
  })

  test("matches a path anchored at the project root", () => {
    expect(matchesPath("src/**/*.ts", "/repo/src/a.ts", root)).toBe(true)
    expect(matchesPath("src/**/*.ts", "/repo/lib/a.ts", root)).toBe(false)
  })

  test("treats a single star as one path segment", () => {
    expect(matchesPath("src/*.ts", "/repo/src/a.ts", root)).toBe(true)
    expect(matchesPath("src/*.ts", "/repo/src/deep/a.ts", root)).toBe(false)
  })
})
