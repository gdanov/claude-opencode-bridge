import { describe, expect, test } from "bun:test"
import { resolveModel } from "../src/claude/models.ts"

const models = [
  { id: "claude-opus-5.5", providerID: "anthropic", name: "Opus 5.5", time: { released: 300 } },
  { id: "claude-sonnet-5.5", providerID: "anthropic", name: "Sonnet 5.5", time: { released: 200 } },
  { id: "claude-haiku-4.5", providerID: "anthropic", name: "Haiku 4.5", time: { released: 100 } },
  { id: "some-opus", providerID: "other", name: "Other Opus", time: { released: 400 } },
] as never

describe("resolveModel", () => {
  test("leaves an unset model alone", () => {
    expect(resolveModel(undefined, models)).toBeUndefined()
  })

  test("treats inherit as no model", () => {
    expect(resolveModel("inherit", models)).toBeUndefined()
    expect(resolveModel("default", models)).toBeUndefined()
  })

  test("resolves an alias to an Anthropic model", () => {
    expect(resolveModel("opus", models)).toEqual({ providerID: "anthropic", id: "claude-opus-5.5" })
    expect(resolveModel("sonnet", models)).toEqual({ providerID: "anthropic", id: "claude-sonnet-5.5" })
    expect(resolveModel("haiku", models)).toEqual({ providerID: "anthropic", id: "claude-haiku-4.5" })
  })

  test("is case insensitive about the alias", () => {
    expect(resolveModel("Opus", models)).toEqual({ providerID: "anthropic", id: "claude-opus-5.5" })
  })

  test("resolves a full model id", () => {
    expect(resolveModel("claude-sonnet-5.5", models)).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-5.5",
    })
  })

  test("resolves an explicit provider and model pair", () => {
    expect(resolveModel("other/some-opus", models)).toEqual({ providerID: "other", id: "some-opus" })
  })

  test("keeps a variant suffix", () => {
    expect(resolveModel("other/some-opus#fast", models)).toEqual({
      providerID: "other",
      id: "some-opus",
      variant: "fast",
    })
  })

  test("leaves an unknown name unresolved", () => {
    expect(resolveModel("mystery", models)).toBeUndefined()
  })

  test("leaves an alias unresolved when no model matches", () => {
    expect(resolveModel("opus", [])).toBeUndefined()
  })
})
