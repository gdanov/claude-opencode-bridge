import { describe, expect, test } from "bun:test"
import { resolveModel } from "../src/claude/models.ts"
import { DEFAULT_POLICY, type ModelPolicy } from "../src/claude/model-policy.ts"

/** A model in the shape OpenCode reports it. */
const model = (
  id: string,
  providerID: string,
  options: { released?: number; variants?: string[]; cost?: number; name?: string } = {},
) => ({
  id,
  providerID,
  name: options.name ?? id,
  variants: (options.variants ?? []).map((variant) => ({ id: variant })),
  time: { released: options.released ?? 0 },
  cost: [{ input: options.cost ?? 0, output: options.cost ?? 0 }],
  status: "active",
  enabled: true,
})

const inventory = [
  model("minimax-m3.1-flash-free", "opencode", { released: 300, variants: ["low", "medium", "high", "xhigh", "max"] }),
  model("glm-5.3-flash-free", "opencode", { released: 200, variants: ["low", "high", "max"] }),
  model("deepseek-v4.1-flash-free", "opencode", { released: 100, variants: ["low", "high", "max"] }),
  model("mimo-v2.6-flash-free", "opencode", { released: 400 }),
  model("minimax-m3.2-flash-free", "opencode", { released: 500, variants: ["low", "medium", "high", "max"] }),
] as never

describe("resolveModel", () => {
  test("leaves an unset model alone", () => {
    expect(resolveModel(undefined, inventory)).toBeUndefined()
  })

  test("treats inherit as no model", () => {
    expect(resolveModel("inherit", inventory)).toBeUndefined()
    expect(resolveModel("default", inventory)).toBeUndefined()
  })

  test("maps an alias onto the tier's family", () => {
    expect(resolveModel("sonnet", inventory)).toEqual({
      providerID: "opencode",
      id: "glm-5.3-flash-free",
      variant: "high",
    })
    expect(resolveModel("haiku", inventory)).toEqual({
      providerID: "opencode",
      id: "deepseek-v4.1-flash-free",
      variant: "low",
    })
  })

  test("takes the newest model of the tier's family", () => {
    expect(resolveModel("opus", inventory)).toEqual({
      providerID: "opencode",
      id: "minimax-m3.2-flash-free",
      variant: "high",
    })
  })

  test("is case insensitive about the alias", () => {
    expect(resolveModel("Opus", inventory)?.id).toBe("minimax-m3.2-flash-free")
  })

  test("reads a tier out of a versioned name", () => {
    expect(resolveModel("claude-opus-4-5", inventory)?.id).toBe("minimax-m3.2-flash-free")
  })

  test("resolves a full model id", () => {
    expect(resolveModel("glm-5.3-flash-free", inventory)).toEqual({
      providerID: "opencode",
      id: "glm-5.3-flash-free",
    })
  })

  test("resolves an explicit provider and model pair", () => {
    expect(resolveModel("opencode/deepseek-v4.1-flash-free", inventory)).toEqual({
      providerID: "opencode",
      id: "deepseek-v4.1-flash-free",
    })
  })

  test("keeps a variant suffix", () => {
    expect(resolveModel("opencode/deepseek-v4.1-flash-free#high", inventory)).toEqual({
      providerID: "opencode",
      id: "deepseek-v4.1-flash-free",
      variant: "high",
    })
  })

  test("leaves an unknown name unresolved", () => {
    expect(resolveModel("mystery", inventory)).toBeUndefined()
  })

  test("leaves an alias unresolved when no model matches", () => {
    expect(resolveModel("opus", [])).toBeUndefined()
  })
})

describe("the effort floor", () => {
  test("uses the tier's effort when the asset asks for none", () => {
    expect(resolveModel("sonnet", inventory)?.variant).toBe("high")
  })

  test("raises the effort the asset asks for", () => {
    expect(resolveModel("sonnet", inventory, { effort: "max" })?.variant).toBe("max")
  })

  test("keeps the tier's effort when the asset asks for less", () => {
    expect(resolveModel("sonnet", inventory, { effort: "low" })?.variant).toBe("high")
  })

  test("takes the weakest variant that reaches the effort", () => {
    const pool = [model("glm-5.3-flash-free", "opencode", { variants: ["low", "medium", "high"] })] as never
    expect(resolveModel("sonnet", pool, { effort: "medium" })?.variant).toBe("medium")
  })

  test("takes the strongest variant there is when the effort is out of reach", () => {
    const pool = [model("glm-5.3-flash-free", "opencode", { variants: ["low", "medium"] })] as never
    expect(resolveModel("sonnet", pool, { effort: "xhigh" })?.variant).toBe("medium")
  })

  test("runs a model without effort variants without one", () => {
    const pool = [model("longcat-2.5-preview-free", "opencode")] as never
    expect(resolveModel("haiku", pool)).toEqual({
      providerID: "opencode",
      id: "longcat-2.5-preview-free",
    })
  })
})

describe("the free pool", () => {
  const paid = [model("glm-5.3-flash-free", "openrouter", { cost: 2, variants: ["low", "high"] })] as never

  test("leaves a paid model unresolved", () => {
    expect(resolveModel("sonnet", paid)).toBeUndefined()
  })

  test("leaves a paid model unresolved when it is named outright", () => {
    expect(resolveModel("glm-5.3-flash-free", paid)).toBeUndefined()
  })

  test("selects a paid model when the policy allows it", () => {
    const policy: ModelPolicy = { ...DEFAULT_POLICY, freeOnly: false }
    expect(resolveModel("glm-5.3-flash-free", paid, { policy })?.id).toBe("glm-5.3-flash-free")
  })

  test("never selects a local model", () => {
    const pool = [model("Qwen3.5-9B-GGUF:UD-Q4_K_XL", "llama.cpp", { cost: 0 })] as never
    const policy: ModelPolicy = {
      ...DEFAULT_POLICY,
      tiers: { haiku: { families: ["qwen"] } },
    }
    expect(resolveModel("haiku", pool, { policy })).toBeUndefined()
  })

  test("never selects a denied family", () => {
    const pool = [model("mimo-v2.6-flash-free", "opencode")] as never
    const policy: ModelPolicy = {
      ...DEFAULT_POLICY,
      tiers: { haiku: { families: ["mimo"] } },
    }
    expect(resolveModel("haiku", pool, { policy })).toBeUndefined()
  })

  test("selects a denied family once the policy opts in", () => {
    const pool = [model("mimo-v2.6-flash-free", "opencode")] as never
    const policy: ModelPolicy = {
      ...DEFAULT_POLICY,
      deny: [],
      tiers: { haiku: { families: ["mimo"] } },
    }
    expect(resolveModel("haiku", pool, { policy })?.id).toBe("mimo-v2.6-flash-free")
  })
})

describe("the provider order", () => {
  const both = [
    model("glm-5.3-flash-free", "openrouter", { released: 900, variants: ["low", "high"] }),
    model("glm-5.3-flash-free", "opencode", { released: 200, variants: ["low", "high"] }),
  ] as never

  test("prefers the provider the policy names first", () => {
    expect(resolveModel("sonnet", both)?.providerID).toBe("opencode")
  })

  test("follows the policy's own order", () => {
    const policy: ModelPolicy = { ...DEFAULT_POLICY, providers: ["openrouter", "opencode"] }
    expect(resolveModel("sonnet", both, { policy })?.providerID).toBe("openrouter")
  })
})
