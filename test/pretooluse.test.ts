import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import bridge from "../src/index.ts"

/** The part of an OpenCode session the stub reports. */
interface StubSession {
  readonly parentID?: string
  readonly location: { readonly directory: string }
}

/**
 * Run the bridge over a project whose `PreToolUse` and `PostToolUse` hook
 * records its input, and return the tool handlers the bridge registers.
 *
 * The hook is a real shell script; only the OpenCode host is stubbed. A
 * session missing from `sessions` makes the session lookup fail.
 */
async function installHook(sessions: Record<string, StubSession>) {
  const root = mkdtempSync(path.join(tmpdir(), "claude-bridge-pretooluse-"))
  const claude = path.join(root, ".claude")
  mkdirSync(claude, { recursive: true })
  const record = path.join(root, "input.json")
  const script = path.join(root, "hook.sh")
  writeFileSync(
    script,
    `#!/bin/sh
input=$(cat)
printf '%s' "$input" > '${record}'
case "$input" in
  *DENYME*) echo "denied by the test hook" >&2; exit 2 ;;
  *JSONDENY*) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"denied by the test hook as JSON"}}'; exit 0 ;;
esac
`,
  )
  chmodSync(script, 0o755)
  const group = { matcher: "Bash", hooks: [{ type: "command", command: script }] }
  writeFileSync(
    path.join(claude, "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [group], PostToolUse: [group] } }),
  )

  const handlers = new Map<string, (event: any) => Promise<void>>()
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "home")
  try {
    await bridge.setup({
      options: { commands: false, agents: false, instructions: false, mcp: false, pluginSkills: false },
      location: { directory: root },
      tool: { hook: (name: string, handler: (event: any) => Promise<void>) => handlers.set(name, handler) },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          const session = sessions[sessionID]
          if (!session) throw new Error(`no session ${sessionID}`)
          return { id: sessionID, ...session }
        },
      },
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }

  const before = handlers.get("execute.before")
  const after = handlers.get("execute.after")
  if (!before || !after) throw new Error("the bridge did not register both tool hooks")
  return {
    root,
    before,
    after,
    recorded: () => JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>,
  }
}

/** An `execute.before` event for a shell call. */
function shellCall(sessionID: string, agent: string, command: string) {
  return { tool: "shell", sessionID, agent, messageID: "msg_1", id: "call_1", input: { command } }
}

describe("PreToolUse hook input", () => {
  test("carries no agent fields for a call from the primary session", async () => {
    const { before, recorded } = await installHook({ ses_root: { location: { directory: "/work/tree" } } })
    await before(shellCall("ses_root", "build", "ls"))
    const input = recorded()
    expect(input.tool_name).toBe("Bash")
    expect(input.session_id).toBe("ses_root")
    expect("agent_id" in input).toBe(false)
    expect("agent_type" in input).toBe(false)
  })

  test("carries the child session id and agent for a call from a subagent", async () => {
    const { before, recorded } = await installHook({
      ses_child: { parentID: "ses_root", location: { directory: "/work/tree" } },
    })
    await before(shellCall("ses_child", "general", "ls"))
    const input = recorded()
    expect(input.agent_id).toBe("ses_child")
    expect(input.agent_type).toBe("general")
  })

  test("sets cwd to the session's working directory", async () => {
    const { before, recorded } = await installHook({ ses_root: { location: { directory: "/work/tree/sub" } } })
    await before(shellCall("ses_root", "build", "ls"))
    expect(recorded().cwd).toBe("/work/tree/sub")
  })

  test("falls back to the project directory when the session cannot be read", async () => {
    const { root, before, recorded } = await installHook({})
    await before(shellCall("ses_unknown", "build", "ls"))
    const input = recorded()
    expect(input.cwd).toBe(root)
    expect("agent_id" in input).toBe(false)
  })

  test("gives a PostToolUse hook the same session fields", async () => {
    const { after, recorded } = await installHook({
      ses_child: { parentID: "ses_root", location: { directory: "/work/tree" } },
    })
    await after({ ...shellCall("ses_child", "general", "ls"), status: "completed", result: { output: "" } })
    const input = recorded()
    expect(input.hook_event_name).toBe("PostToolUse")
    expect(input.cwd).toBe("/work/tree")
    expect(input.agent_id).toBe("ses_child")
    expect(input.agent_type).toBe("general")
  })

  test("rejects the tool call when the hook exits with 2", async () => {
    const { before } = await installHook({ ses_root: { location: { directory: "/work/tree" } } })
    await expect(before(shellCall("ses_root", "build", "echo DENYME"))).rejects.toThrow("denied by the test hook")
  })

  test("rejects the tool call when the hook returns a deny decision", async () => {
    const { before } = await installHook({ ses_root: { location: { directory: "/work/tree" } } })
    await expect(before(shellCall("ses_root", "build", "echo JSONDENY"))).rejects.toThrow(
      "denied by the test hook as JSON",
    )
  })
})
