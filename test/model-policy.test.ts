import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_POLICY, mergePolicy, readModelPolicy } from "../src/claude/model-policy.ts"

const policyFile = (contents: string): string => {
  const directory = mkdtempSync(path.join(tmpdir(), "claude-bridge-policy-"))
  const file = path.join(directory, "model-policy.json")
  writeFileSync(file, contents)
  return file
}

describe("readModelPolicy", () => {
  test("falls back to the defaults when the file is missing", () => {
    expect(readModelPolicy(path.join(tmpdir(), "claude-bridge-missing-policy.json"))).toEqual(
      DEFAULT_POLICY,
    )
  })

  test("reads the tiers the human wrote", () => {
    const file = policyFile(
      JSON.stringify({ tiers: { sonnet: { families: ["deepseek"], effort: "low" } } }),
    )
    const policy = readModelPolicy(file)
    expect(policy.tiers.sonnet).toEqual({ families: ["deepseek"], effort: "low" })
  })

  test("keeps the default tiers the human did not mention", () => {
    const file = policyFile(JSON.stringify({ tiers: { sonnet: { families: ["deepseek"] } } }))
    const policy = readModelPolicy(file)
    expect(policy.tiers.haiku).toEqual(DEFAULT_POLICY.tiers.haiku)
  })

  test("overrides the provider order", () => {
    const file = policyFile(JSON.stringify({ providers: ["openrouter", "opencode"] }))
    expect(readModelPolicy(file).providers).toEqual(["openrouter", "opencode"])
  })

  test("overrides the denied families", () => {
    const file = policyFile(JSON.stringify({ deny: [] }))
    expect(readModelPolicy(file).deny).toEqual([])
  })

  test("adds a tier the defaults do not have", () => {
    const file = policyFile(JSON.stringify({ tiers: { scout: { families: ["deepseek"] } } }))
    expect(readModelPolicy(file).tiers.scout?.families).toEqual(["deepseek"])
  })

  test("falls back to the defaults when the file cannot be parsed", () => {
    const file = policyFile("{ not json")
    expect(readModelPolicy(file)).toEqual(DEFAULT_POLICY)
  })
})

describe("mergePolicy", () => {
  test("leaves the defaults alone when the override is empty", () => {
    expect(mergePolicy(DEFAULT_POLICY, {})).toEqual(DEFAULT_POLICY)
  })

  test("keeps a tier's default effort when the override names no effort", () => {
    const merged = mergePolicy(DEFAULT_POLICY, { tiers: { sonnet: { families: ["deepseek"] } } })
    expect(merged.tiers.sonnet?.effort).toBe(DEFAULT_POLICY.tiers.sonnet?.effort)
  })

  test("ignores a tier that is not an object", () => {
    const merged = mergePolicy(DEFAULT_POLICY, { tiers: { sonnet: "deepseek" } })
    expect(merged.tiers.sonnet).toEqual(DEFAULT_POLICY.tiers.sonnet)
  })
})
