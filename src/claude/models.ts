/**
 * Resolution of Claude Code model names into OpenCode model references.
 *
 * Claude Code names models with short aliases (`opus`, `sonnet`, `haiku`,
 * `fable`) or with a full model id. OpenCode needs a `provider/model`
 * reference, and only accepts one that names a model the user actually has.
 *
 * An alias resolves through the model policy: the alias names a tier, the
 * tier names model families, and the bridge takes the newest free model that
 * offers the first family it can find.
 */

import type { Model } from "@opencode/plugin"
import { DEFAULT_POLICY, type ModelPolicy, type TierRule } from "./model-policy.ts"

/** The model reference OpenCode expects on an agent. */
export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/** The effort levels, weakest first. */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

/** Providers that run on the user's own machine and are never selected. */
const LOCAL_PROVIDERS = ["llama.cpp"]

/** What the caller knows about the asset the model is resolved for. */
export interface ResolveOptions {
  /** The effort the asset asks for; it is a floor on the tier's effort. */
  readonly effort?: string
  /** The policy that says what each alias means. */
  readonly policy?: ModelPolicy
}

/**
 * Resolve a Claude Code model name into an OpenCode model reference.
 *
 * `inherit` and an empty name mean "use whatever the session uses", which is
 * expressed by leaving the model unset. A name that cannot be resolved is
 * also left unset, so a missing model never breaks the agent.
 */
export function resolveModel(
  name: string | undefined,
  available: readonly Model.Info[],
  options: ResolveOptions = {},
): ModelRef | undefined {
  const policy = options.policy ?? DEFAULT_POLICY
  if (!name) return undefined
  const value = name.trim()
  if (!value || value === "inherit" || value === "default") return undefined

  // An explicit `provider/model` pair is used as written.
  if (value.includes("/")) {
    const [providerID, ...rest] = value.split("/")
    const id = rest.join("/")
    if (!providerID || !id) return undefined
    const named = readVariant(id)
    const found = available.find(
      (model) => model.id === named.id || `${model.providerID}/${model.id}` === id,
    )
    if (!found || !isAllowed(found, policy)) return undefined
    return withEffort(toRef(found), found, named.variant, effortFloor(undefined, options.effort))
  }

  const direct = available.find((model) => model.id === value)
  if (direct) {
    if (!isAllowed(direct, policy)) return undefined
    return withEffort(toRef(direct), direct, undefined, effortFloor(undefined, options.effort))
  }

  const tier = findTier(policy, value)
  if (!tier) return undefined
  const model = pickTierModel(available, tier.rule, policy)
  if (!model) return undefined
  return withEffort(toRef(model), model, undefined, effortFloor(tier.rule.effort, options.effort))
}

/**
 * The tier a name names.
 *
 * A name that is an alias names its tier outright, and a name that carries an
 * alias as one of its parts — `claude-opus-4-5` — names that tier.
 */
function findTier(policy: ModelPolicy, value: string): { rule: TierRule } | undefined {
  const exact = policy.tiers[value.toLowerCase()]
  if (exact) return { rule: exact }
  const parts = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const [alias, rule] of Object.entries(policy.tiers)) {
    if (parts.includes(alias.toLowerCase())) return { rule }
  }
  return undefined
}

/**
 * Find the model a tier runs on.
 *
 * The tier's families are walked in order, so the strongest family that the
 * machine actually has serves the tier. Inside a family the newest model
 * wins, which is what keeps a tier current as the free inventory changes.
 */
function pickTierModel(
  available: readonly Model.Info[],
  tier: TierRule,
  policy: ModelPolicy,
): Model.Info | undefined {
  for (const family of tier.families) {
    const candidates = available.filter(
      (model) =>
        matchesFamily(model, family) &&
        isAllowed(model, policy) &&
        !tier.exclude?.some((fragment) => matchesFragment(model, fragment)),
    )
    if (candidates.length === 0) continue
    return best(candidates, policy)
  }
  return undefined
}

/** The best candidate: the preferred provider first, then the newest model. */
function best(candidates: readonly Model.Info[], policy: ModelPolicy): Model.Info {
  return [...candidates].sort((left, right) => {
    const rank = providerRank(left, policy) - providerRank(right, policy)
    if (rank !== 0) return rank
    const released = (right.time?.released ?? 0) - (left.time?.released ?? 0)
    if (released !== 0) return released
    return left.id.localeCompare(right.id)
  })[0] as Model.Info
}

/** Where a provider sits in the policy's order. */
function providerRank(model: Model.Info, policy: ModelPolicy): number {
  const index = policy.providers.indexOf(model.providerID)
  return index === -1 ? policy.providers.length : index
}

/**
 * Whether a model may be selected.
 *
 * A denied family needs an explicit opt-in, a local model never serves a
 * lane, and — unless the policy says otherwise — only models that cost
 * nothing are selected.
 */
function isAllowed(model: Model.Info, policy: ModelPolicy): boolean {
  if (model.enabled === false) return false
  if (LOCAL_PROVIDERS.includes(model.providerID)) return false
  if (policy.deny.some((fragment) => matchesFragment(model, fragment))) return false
  if (policy.freeOnly && !isFree(model)) return false
  return true
}

/** Whether a model costs nothing to run. */
function isFree(model: Model.Info): boolean {
  const cost = model.cost ?? []
  if (cost.length === 0) return false
  return cost.every((entry) => (entry.input ?? 0) === 0 && (entry.output ?? 0) === 0)
}

/** Whether a model belongs to a family. */
function matchesFamily(model: Model.Info, family: string): boolean {
  return matchesFragment(model, family.toLowerCase())
}

/** Whether a model's id or name carries a fragment. */
function matchesFragment(model: Model.Info, fragment: string): boolean {
  const needle = fragment.toLowerCase()
  return (
    model.id.toLowerCase().includes(needle) || (model.name ?? "").toLowerCase().includes(needle)
  )
}

/**
 * The effort a run must reach.
 *
 * The tier's own effort is the baseline and the asset's effort is a floor on
 * it, so a file may ask for more than its tier and never for less.
 */
function effortFloor(tierEffort: string | undefined, assetEffort: string | undefined): string | undefined {
  const tier = effortRank(tierEffort)
  const asset = effortRank(assetEffort)
  if (tier === undefined && asset === undefined) return undefined
  if (tier === undefined) return assetEffort
  if (asset === undefined) return tierEffort
  return asset > tier ? assetEffort : tierEffort
}

/** The rank of an effort level, or undefined when it is not one. */
function effortRank(effort: string | undefined): number | undefined {
  if (!effort) return undefined
  const index = EFFORT_LEVELS.indexOf(effort.toLowerCase() as (typeof EFFORT_LEVELS)[number])
  return index === -1 ? undefined : index
}

/**
 * Attach the variant an effort selects.
 *
 * The variant is the model's own effort level, so the bridge takes the
 * weakest variant that reaches the effort asked for. A model that offers no
 * effort variants runs without one.
 */
function withEffort(
  ref: ModelRef,
  model: Model.Info,
  named: string | undefined,
  floor: string | undefined,
): ModelRef {
  const variants = (model.variants ?? []).map((variant) => variant.id)
  const namedRank = effortRank(named)
  // A variant that names no effort — a thinking mode, say — is kept as written.
  if (named !== undefined && namedRank === undefined) return { ...ref, variant: named }
  const wanted = Math.max(namedRank ?? -1, effortRank(floor) ?? -1)
  if (wanted < 0) return ref
  const variant = pickVariant(variants, wanted)
  return variant ? { ...ref, variant } : ref
}

/** The weakest variant that reaches an effort, or the strongest one there is. */
function pickVariant(variants: readonly string[], wanted: number): string | undefined {
  const efforts = variants
    .map((id) => ({ id, rank: effortRank(id) }))
    .filter((entry): entry is { id: string; rank: number } => entry.rank !== undefined)
    .sort((left, right) => left.rank - right.rank)
  if (efforts.length === 0) return undefined
  const reaching = efforts.filter((entry) => entry.rank >= wanted)
  return (reaching[0] ?? efforts[efforts.length - 1])?.id
}

/** Read a `#variant` suffix from a model id. */
function readVariant(id: string): { id: string; variant?: string } {
  const hash = id.indexOf("#")
  if (hash === -1) return { id }
  return { id: id.slice(0, hash), variant: id.slice(hash + 1) }
}

/** Convert a model into a reference. */
function toRef(model: Model.Info): ModelRef {
  return { providerID: model.providerID, id: model.id }
}
