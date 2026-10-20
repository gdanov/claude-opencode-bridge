import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import bridge from "../src/index.ts"

/** The free inventory the stub reports. */
const models = [
  {
    id: "glm-5.3-flash-free",
    providerID: "opencode",
    name: "GLM-5.3-Flash Free",
    variants: [{ id: "low" }, { id: "high" }, { id: "max" }],
    time: { released: 200 },
    cost: [{ input: 0, output: 0 }],
    status: "active",
    enabled: true,
  },
  {
    id: "deepseek-v4.1-flash-free",
    providerID: "opencode",
    name: "DeepSeek V4.1 Flash Free",
    variants: [{ id: "low" }, { id: "high" }, { id: "max" }],
    time: { released: 100 },
    cost: [{ input: 0, output: 0 }],
    status: "active",
    enabled: true,
  },
]

/** Run the bridge over a tree that holds one agent, and return what it registered. */
async function registerAgent(frontmatter: string): Promise<Record<string, any>> {
  const root = mkdtempSync(path.join(tmpdir(), "claude-bridge-agents-"))
  const agents = path.join(root, ".claude", "agents")
  mkdirSync(agents, { recursive: true })
  writeFileSync(path.join(agents, "lane.md"), `---\n${frontmatter}\n---\n\nThe lane.\n`)

  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  const registered = new Map<string, any>()

  try {
    await bridge.setup({
      options: { commands: false, hooks: false, instructions: false, mcp: false, pluginSkills: false },
      location: { directory: root },
      model: { list: async () => ({ data: models }) },
      agent: {
        transform: (apply: any) =>
          apply({
            update: (id: string, change: (info: any) => void) => {
              const info: any = { id }
              change(info)
              registered.set(id, info)
            },
          }),
      },
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }

  const info = registered.get("lane")
  if (!info) throw new Error("the agent was not registered")
  return info
}

describe("the bridge", () => {
  test("gives an agent the model its alias names", async () => {
    const info = await registerAgent("name: lane\ndescription: a lane\nmodel: sonnet")
    expect(info.model).toEqual({
      providerID: "opencode",
      id: "glm-5.3-flash-free",
      variant: "high",
    })
  })

  test("gives an agent the effort its file asks for", async () => {
    const info = await registerAgent("name: lane\ndescription: a lane\nmodel: haiku\neffort: high")
    expect(info.model).toEqual({
      providerID: "opencode",
      id: "deepseek-v4.1-flash-free",
      variant: "high",
    })
  })

  test("leaves an agent that inherits on the session's model", async () => {
    const info = await registerAgent("name: lane\ndescription: a lane\nmodel: inherit")
    expect(info.model).toBeUndefined()
  })
})
