/**
 * Entry point for the Claude Code bridge plugin.
 *
 * The implementation lives in `src/`; this file exists so the plugin can be
 * loaded as a plain directory, which is how OpenCode discovers local plugins.
 */

export { default } from "./src/index.ts"
export type { BridgeOptions } from "./src/index.ts"
