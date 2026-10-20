/**
 * The model policy: which model serves which Claude Code tier.
 *
 * Claude Code names models with aliases (`opus`, `sonnet`, `haiku`, `fable`).
 * The policy says what each alias means for this machine: a tier names model
 * families, strongest first, and the bridge resolves a family to the newest
 * free model that offers it. The free inventory changes, so the policy names
 * families rather than model versions — a new release of a family is picked up
 * without an edit.
 *
 * The defaults live here. A file the human owns overrides them, and the bridge
 * only ever reads that file.
 */

import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** What one Claude Code alias resolves to. */
export interface TierRule {
  /** Model families the tier accepts, strongest first. */
  readonly families: readonly string[]
  /** Model id fragments the tier refuses. */
  readonly exclude?: readonly string[]
  /** The effort the tier runs at, unless the agent file asks for more. */
  readonly effort?: string
}

/** The model policy for one machine. */
export interface ModelPolicy {
  /** Providers, in the order they are preferred. */
  readonly providers: readonly string[]
  /** Model families that need an explicit opt-in. */
  readonly deny: readonly string[]
  /** Whether a model has to cost nothing to run. */
  readonly freeOnly: boolean
  /** The tier each Claude Code alias resolves to. */
  readonly tiers: Readonly<Record<string, TierRule>>
}

/**
 * The policy the bridge ships with.
 *
 * The families are the open-weights lines that are free to run, ordered by
 * capability. `fable` and `opus` take the strongest line, `sonnet` a mid one,
 * `haiku` the lightest — the effort each tier runs at distinguishes them
 * further.
 */
export const DEFAULT_POLICY: ModelPolicy = {
  providers: ["opencode", "openrouter"],
  deny: ["exo", "mimo", "big-pickle", "ll-alpha", "nemotron"],
  freeOnly: true,
  tiers: {
    fable: { families: ["minimax", "glm", "beam"], effort: "max" },
    opus: { families: ["minimax", "glm", "beam"], effort: "high" },
    sonnet: { families: ["glm", "beam", "deepseek"], effort: "medium" },
    haiku: { families: ["deepseek", "glm", "longcat"], effort: "low" },
  },
}

/** The policy file the bridge reads when no other path is configured. */
export const DEFAULT_POLICY_PATH = path.join(os.homedir(), ".config", "opencode", "model-policy.json")

/**
 * Read the policy, with the human's file layered over the defaults.
 *
 * A missing file is not an error — the defaults stand. A file that cannot be
 * parsed is reported and the defaults stand, because refusing to load the
 * bridge would take every Claude Code asset out of OpenCode.
 */
export function readModelPolicy(file: string = DEFAULT_POLICY_PATH): ModelPolicy {
  const raw = readPolicyFile(file)
  if (!raw) return DEFAULT_POLICY
  return mergePolicy(DEFAULT_POLICY, raw)
}

/** Read and parse a policy file, returning undefined when it is unusable. */
function readPolicyFile(file: string): Record<string, unknown> | undefined {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the policy file does not hold an object")
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`claude-bridge: ignoring the model policy at ${file}: ${reason}`)
    return undefined
  }
}

/** Layer the human's policy over the defaults. */
export function mergePolicy(base: ModelPolicy, override: Record<string, unknown>): ModelPolicy {
  const providers = stringList(override.providers)
  const deny = stringList(override.deny)
  const tiers = mergeTiers(base.tiers, override.tiers)

  return {
    providers: providers ?? base.providers,
    deny: deny ?? base.deny,
    freeOnly: typeof override.freeOnly === "boolean" ? override.freeOnly : base.freeOnly,
    tiers,
  }
}

/** Layer the human's tiers over the default tiers. */
function mergeTiers(
  base: Readonly<Record<string, TierRule>>,
  override: unknown,
): Readonly<Record<string, TierRule>> {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base
  const merged: Record<string, TierRule> = { ...base }

  for (const [alias, value] of Object.entries(override as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const rule = value as Record<string, unknown>
    const families = stringList(rule.families)
    const exclude = stringList(rule.exclude)
    const effort = typeof rule.effort === "string" ? rule.effort : undefined
    const current = merged[alias]
    merged[alias] = {
      families: families ?? current?.families ?? [],
      ...(exclude ? { exclude } : current?.exclude ? { exclude: current.exclude } : {}),
      ...(effort !== undefined ? { effort } : current?.effort !== undefined ? { effort: current.effort } : {}),
    }
  }

  return merged
}

/** Read a field as a list of strings, or undefined when it is not one. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
}
