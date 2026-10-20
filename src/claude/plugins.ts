/**
 * Discovery of Claude Code assets: plugins, their components, and their hooks.
 *
 * Claude Code stores plugin code in two places:
 *
 *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/   installed
 *   ~/.claude/plugins/marketplaces/<marketplace>/<plugin>/      checkout
 *
 * `installed_plugins.json` records the installed copies, `known_marketplaces.json`
 * records marketplace checkouts, and `settings.json` records which plugins the
 * user enabled. A plugin is the union of those three.
 */

import path from "node:path"
import { isDirectory, isFile, readJSON, type ClaudeRoots } from "./paths.ts"

export interface ClaudePlugin {
  /** Plugin name, without the marketplace suffix. */
  readonly name: string
  /** Marketplace that provides the plugin. */
  readonly marketplace: string
  /** Absolute path to the plugin root, holding `commands/`, `agents/`, and so on. */
  readonly root: string
  /** Plugin manifest, when the plugin ships one. */
  readonly manifest?: PluginManifest
}

export interface PluginManifest {
  readonly name?: string
  readonly description?: string
  readonly version?: string
  readonly defaultEnabled?: boolean
  readonly skills?: string | string[]
  readonly commands?: string | string[] | Record<string, unknown>
  readonly agents?: string | string[]
  readonly hooks?: string | Record<string, unknown> | Array<string | Record<string, unknown>>
  readonly mcpServers?: string | Record<string, unknown> | Array<string | Record<string, unknown>>
}

export interface InstalledPlugin {
  readonly scope?: string
  readonly projectPath?: string
  readonly installPath?: string
  readonly version?: string
}

export interface EnabledPlugins {
  readonly [key: string]: boolean | undefined
}

export interface ClaudeSettings {
  readonly hooks?: Record<string, unknown>
  readonly enabledPlugins?: EnabledPlugins
  readonly permissions?: {
    readonly allow?: string[]
    readonly deny?: string[]
    readonly ask?: string[]
    readonly defaultMode?: string
  }
  readonly [key: string]: unknown
}

/** Read `~/.claude/settings.json`. */
export function readSettings(roots: ClaudeRoots): ClaudeSettings {
  return readJSON<ClaudeSettings>(path.join(roots.user, "settings.json")) ?? {}
}

/** Read `~/.claude/plugins/installed_plugins.json`. */
function readInstalled(roots: ClaudeRoots): Record<string, InstalledPlugin[]> {
  const file = readJSON<{ plugins?: Record<string, InstalledPlugin[]> }>(
    path.join(roots.plugins, "installed_plugins.json"),
  )
  return file?.plugins ?? {}
}

/** Read `~/.claude/plugins/known_marketplaces.json`. */
function readMarketplaces(roots: ClaudeRoots): Record<string, { installLocation?: string }> {
  const file = readJSON<{ marketplaces?: Record<string, { installLocation?: string }> }>(
    path.join(roots.plugins, "known_marketplaces.json"),
  )
  return file?.marketplaces ?? {}
}

/**
 * Resolve the enabled Claude Code plugins.
 *
 * Installed copies win over marketplace checkouts, because the installed copy
 * is the version Claude Code actually runs. A plugin is enabled when
 * `settings.json` says so; plugins the settings file does not mention fall back
 * to the manifest's `defaultEnabled`.
 */
export function discoverPlugins(roots: ClaudeRoots, settings: ClaudeSettings): ClaudePlugin[] {
  const installed = readInstalled(roots)
  const marketplaces = readMarketplaces(roots)
  const enabled = settings.enabledPlugins ?? {}
  const found = new Map<string, ClaudePlugin>()

  for (const [key, records] of Object.entries(installed)) {
    const copy = pickInstall(records)
    if (!copy?.installPath) continue
    const plugin = buildPlugin(key, copy.installPath)
    if (plugin) found.set(key, plugin)
  }

  // Marketplace checkouts cover plugins Claude Code can run in place.
  for (const [marketplace, info] of Object.entries(marketplaces)) {
    if (!info.installLocation) continue
    for (const plugin of readMarketplacePlugins(path.join(info.installLocation), marketplace)) {
      const key = `${plugin.name}@${marketplace}`
      if (found.has(key)) continue
      found.set(key, plugin)
    }
  }

  return [...found.values()]
    .filter((plugin) => isPluginEnabled(plugin, enabled))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Prefer a user-scope install, then a project install, then any. */
function pickInstall(records: InstalledPlugin[]): InstalledPlugin | undefined {
  return (
    records.find((record) => record.scope === "user") ??
    records.find((record) => record.scope === "project") ??
    records.find((record) => record.scope === "local") ??
    records[0]
  )
}

/** Read the plugins a marketplace checkout provides. */
function readMarketplacePlugins(root: string, marketplace: string): ClaudePlugin[] {
  const manifestFile = path.join(root, ".claude-plugin", "marketplace.json")
  if (!isFile(manifestFile)) return []
  const manifest = readJSON<{ plugins?: Array<{ name?: string; source?: unknown }> }>(manifestFile)
  const plugins: ClaudePlugin[] = []
  for (const entry of manifest?.plugins ?? []) {
    if (!entry.name) continue
    const source = typeof entry.source === "string" ? entry.source : undefined
    if (!source) continue
    const pluginRoot = path.resolve(root, source)
    if (!isDirectory(pluginRoot)) continue
    const plugin = buildPlugin(`${entry.name}@${marketplace}`, pluginRoot)
    if (plugin) plugins.push(plugin)
  }
  return plugins
}

/** Assemble a plugin from its root directory. */
function buildPlugin(key: string, root: string): ClaudePlugin | undefined {
  if (!isDirectory(root)) return undefined
  const separator = key.lastIndexOf("@")
  const name = separator === -1 ? key : key.slice(0, separator)
  const marketplace = separator === -1 ? "" : key.slice(separator + 1)
  const manifestFile = path.join(root, ".claude-plugin", "plugin.json")
  const manifest = isFile(manifestFile) ? readJSON<PluginManifest>(manifestFile) : undefined
  return { name, marketplace, root, manifest }
}

/**
 * Decide whether a plugin is enabled.
 *
 * An explicit `false` in `enabledPlugins` always disables. An explicit `true`
 * always enables. Otherwise the manifest's `defaultEnabled` decides, and
 * plugins without a manifest are enabled by default.
 */
function isPluginEnabled(plugin: ClaudePlugin, enabled: EnabledPlugins): boolean {
  const key = `${plugin.name}@${plugin.marketplace}`
  const setting = enabled[key]
  if (setting !== undefined) return setting
  return plugin.manifest?.defaultEnabled !== false
}
