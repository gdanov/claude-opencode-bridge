/**
 * Resolution of Claude Code model names into OpenCode model references.
 *
 * Claude Code names models with short aliases (`opus`, `sonnet`, `haiku`) or
 * with a full model id. OpenCode needs a `provider/model` reference, and only
 * accepts one that names a model the user actually has.
 */

import type { Model } from "@opencode/plugin"

/** The model reference OpenCode expects on an agent. */
export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}
/**
 * The Claude Code model aliases, mapped to the model family they name.
 *
 * The family is matched against the model id, so `claude-opus-4-5` and
 * `opus` both resolve to an Opus model.
 */
const ALIAS_FAMILIES: Record<string, string[]> = {
  opus: ["opus"],
  sonnet: ["sonnet"],
  haiku: ["haiku"],
  fable: ["fable"],
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
): ModelRef | undefined {  if (!name) return undefined
  const value = name.trim()
  if (!value || value === "inherit" || value === "default") return undefined

  // An explicit `provider/model` pair is used as written.
  if (value.includes("/")) {
    const [providerID, ...rest] = value.split("/")
    const id = rest.join("/")
    if (!providerID || !id) return undefined
    const variant = readVariant(id)
    return { providerID, id: variant.id, ...(variant.variant ? { variant: variant.variant } : {}) }
  }

  const direct = findById(available, value)
  if (direct) return toRef(direct)

  const families = ALIAS_FAMILIES[value.toLowerCase()]
  if (!families) return undefined
  return findByFamily(available, families)
}

/**
 * Find the model that best matches a family.
 *
 * Anthropic models are preferred, because a Claude Code alias names a Claude
 * model, and the newest matching model wins.
 */
function findByFamily(available: readonly Model.Info[], families: string[]): ModelRef | undefined {
  const matches = available.filter((model) => {
    const id = model.id.toLowerCase()
    return families.some((family) => id.includes(family))
  })
  if (matches.length === 0) return undefined

  const anthropic = matches.filter((model) => model.providerID === "anthropic")
  const pool = anthropic.length > 0 ? anthropic : matches
  const best = pool.reduce((left, right) => (isNewer(right, left) ? right : left))
  return toRef(best)
}

/** Find a model by its exact id, across every provider. */
function findById(available: readonly Model.Info[], id: string): Model.Info | undefined {
  const variant = readVariant(id)
  return available.find(
    (model) => model.id === variant.id || `${model.providerID}/${model.id}` === id,
  )
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

/**
 * Whether one model is newer than another.
 *
 * Release timestamps are compared when both are known, and the model order
 * stands in for the rest.
 */
function isNewer(candidate: Model.Info, current: Model.Info): boolean {
  const candidateTime = candidate.time?.released
  const currentTime = current.time?.released
  if (typeof candidateTime === "number" && typeof currentTime === "number") {
    return candidateTime > currentTime
  }
  return false
}
