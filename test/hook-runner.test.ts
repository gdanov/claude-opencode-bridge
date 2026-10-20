import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { interpret, runHook } from "../src/claude/hook-runner.ts"

function scriptDir(): string {
  return mkdtempSync(path.join(tmpdir(), "claude-hook-"))
}

function writeScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name)
  writeFileSync(file, body)
  chmodSync(file, 0o755)
  return file
}

describe("interpret", () => {
  test("treats exit 0 with no output as no decision", () => {
    const result = interpret({ stdout: "", stderr: "", exitCode: 0 }, "PreToolUse")
    expect(result.decision.block).toBe(false)
  })

  test("treats exit 2 as a block with the stderr reason", () => {
    const result = interpret({ stdout: "", stderr: "not allowed", exitCode: 2 }, "PreToolUse")
    expect(result.decision.block).toBe(true)
    expect(result.decision.reason).toBe("not allowed")
  })

  test("reads a deny decision from JSON output", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "writes are blocked",
      },
    })
    const result = interpret({ stdout, stderr: "", exitCode: 0 }, "PreToolUse")
    expect(result.decision.block).toBe(true)
    expect(result.decision.reason).toBe("writes are blocked")
  })

  test("reads a block decision from JSON output", () => {
    const stdout = JSON.stringify({ decision: "block", reason: "not yet" })
    const result = interpret({ stdout, stderr: "", exitCode: 0 }, "UserPromptSubmit")
    expect(result.decision.block).toBe(true)
    expect(result.decision.reason).toBe("not yet")
  })

  test("reads additional context from JSON output", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "the file is generated" },
    })
    const result = interpret({ stdout, stderr: "", exitCode: 0 }, "PostToolUse")
    expect(result.decision.additionalContext).toBe("the file is generated")
    expect(result.decision.block).toBe(false)
  })

  test("honours continue false", () => {
    const stdout = JSON.stringify({ continue: false, stopReason: "stop now" })
    const result = interpret({ stdout, stderr: "", exitCode: 0 }, "PreToolUse")
    expect(result.decision.block).toBe(true)
    expect(result.decision.reason).toBe("stop now")
  })

  test("treats another exit code as a non-blocking failure", () => {
    const result = interpret({ stdout: "", stderr: "boom", exitCode: 1 }, "PreToolUse")
    expect(result.decision.block).toBe(false)
    expect(result.decision.failed).toBe(true)
  })

  test("ignores output that is not a JSON object", () => {
    const result = interpret({ stdout: "not json", stderr: "", exitCode: 0 }, "PreToolUse")
    expect(result.decision.block).toBe(false)
  })
})

describe("runHook", () => {
  test("passes the event as JSON on stdin", async () => {
    const dir = scriptDir()
    const file = writeScript(dir, "echo.sh", "#!/bin/sh\ncat > \"$1.json\"\nprintf '%s' '{\"decision\":\"block\",\"reason\":\"seen\"}'\n")
    const outcome = await runHook(file, ["$1"], { hook_event_name: "PreToolUse", tool_name: "Bash" }, { cwd: dir })
    expect(outcome.decision.block).toBe(true)
    expect(outcome.decision.reason).toBe("seen")
  })

  test("blocks when the script exits 2", async () => {
    const dir = scriptDir()
    const file = writeScript(dir, "deny.sh", "#!/bin/sh\ncat > /dev/null\necho 'denied by policy' >&2\nexit 2\n")
    const outcome = await runHook(file, undefined, { hook_event_name: "PreToolUse" }, { cwd: dir })
    expect(outcome.decision.block).toBe(true)
    expect(outcome.decision.reason).toBe("denied by policy")
  })

  test("runs a shell-form command", async () => {
    const dir = scriptDir()
    const file = writeScript(dir, "emit.sh", "#!/bin/sh\ncat > /dev/null\nprintf '%s' '{\"systemMessage\":\"hello\"}'\n")
    const outcome = await runHook(`sh ${file}`, undefined, { hook_event_name: "SessionStart" }, { cwd: dir })
    expect(outcome.decision.systemMessage).toBe("hello")
  })

  test("reports a script that cannot start", async () => {
    const outcome = await runHook("/nonexistent/hook.sh", undefined, { hook_event_name: "PreToolUse" }, {})
    expect(outcome.decision.failed).toBe(true)
    expect(outcome.decision.block).toBe(false)
  })
})
