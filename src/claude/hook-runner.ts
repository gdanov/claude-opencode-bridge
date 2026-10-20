/**
 * Execution of Claude Code hook commands.
 *
 * Claude Code runs a hook as a child process, writes a JSON event to its
 * stdin, and reads the decision from its stdout and exit code:
 *
 *   exit 0  the action proceeds, unless stdout carries a decision
 *   exit 2  the action is blocked, and stderr explains why
 *   other   a non-blocking error, reported to the user
 *
 * stdout may hold one JSON object with `continue`, `stopReason`,
 * `systemMessage`, `decision`, `reason`, or `hookSpecificOutput`.
 */

import { spawn } from "node:child_process"

export interface HookEvent {
  readonly session_id?: string
  readonly transcript_path?: string
  readonly cwd?: string
  readonly permission_mode?: string
  readonly hook_event_name: string
  readonly tool_name?: string
  readonly tool_input?: unknown
  readonly tool_response?: unknown
  readonly [key: string]: unknown
}

export interface HookDecision {
  /** Whether the action should be blocked. */
  readonly block: boolean
  /** Why the action was blocked. */
  readonly reason?: string
  /** Context to inject into the model's conversation. */
  readonly additionalContext?: string
  /** Whether the hook decided to allow the action outright. */
  readonly allow?: boolean
  /** A message for the user. */
  readonly systemMessage?: string
  /** Whether the hook failed in a way that should block. */
  readonly failed: boolean
}

export interface HookOutcome {
  readonly decision: HookDecision
  /** Raw stdout, for diagnostics. */
  readonly stdout: string
  /** Raw stderr, for diagnostics. */
  readonly stderr: string
  readonly exitCode: number | undefined
}

export interface HookEnvironment {
  /** Environment variables to add to the hook process. */
  readonly env?: Record<string, string>
  /** Working directory for the hook process. */
  readonly cwd?: string
  /** Milliseconds before the hook is cancelled. */
  readonly timeout?: number
}

/**
 * Run a hook command and interpret its result.
 *
 * A hook that cannot start is reported as a non-blocking failure, unless the
 * configuration asked for failures to block.
 */
export async function runHook(
  command: string,
  args: string[] | undefined,
  event: HookEvent,
  environment: HookEnvironment = {},
): Promise<HookOutcome> {
  const payload = JSON.stringify(event)
  const timeout = environment.timeout ?? 60_000

  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | undefined }>((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (exitCode: number | undefined) => {
      if (settled) return
      settled = true
      resolve({ stdout, stderr, exitCode })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = args && args.length > 0
        ? spawn(command, args, { cwd: environment.cwd, env: { ...process.env, ...environment.env } })
        : spawn(command, { shell: true, cwd: environment.cwd, env: { ...process.env, ...environment.env } })
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error)
      finish(undefined)
      return
    }

    const timer = setTimeout(() => {
      stderr = stderr || "hook timed out"
      child.kill("SIGKILL")
      finish(undefined)
    }, timeout)

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", (error) => {
      stderr = stderr || (error instanceof Error ? error.message : String(error))
      clearTimeout(timer)
      finish(undefined)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      finish(code ?? undefined)
    })

    child.stdin?.on("error", () => {
      // The hook may close stdin without reading it; that is not an error.
    })
    child.stdin?.end(payload)
  })

  return interpret(result, event.hook_event_name)
}

/** Turn a hook's exit code and stdout into a decision. */
export function interpret(
  result: { stdout: string; stderr: string; exitCode: number | undefined },
  eventName: string,
): HookOutcome {
  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  const exitCode = result.exitCode

  let parsed: Record<string, unknown> | undefined
  if (stdout.startsWith("{") && stdout.endsWith("}")) {
    try {
      const value = JSON.parse(stdout)
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>
    } catch {
      parsed = undefined
    }
  }

  const specific = parsed?.hookSpecificOutput as Record<string, unknown> | undefined
  const decision = typeof parsed?.decision === "string" ? parsed.decision : undefined
  const reason = typeof parsed?.reason === "string" ? parsed.reason : undefined
  const systemMessage = typeof parsed?.systemMessage === "string" ? parsed.systemMessage : undefined
  const additionalContext =
    typeof specific?.additionalContext === "string" ? specific.additionalContext : undefined
  const permissionDecision =
    typeof specific?.permissionDecision === "string" ? specific.permissionDecision : undefined
  const permissionReason =
    typeof specific?.permissionDecisionReason === "string" ? specific.permissionDecisionReason : undefined
  const stopReason = typeof parsed?.stopReason === "string" ? parsed.stopReason : undefined
  const shouldContinue = typeof parsed?.continue === "boolean" ? parsed.continue : undefined

  // Exit code 2 blocks the action regardless of what stdout said.
  if (exitCode === 2) {
    return {
      decision: {
        block: true,
        reason: reason ?? permissionReason ?? stderr ?? "blocked by hook",
        additionalContext,
        systemMessage,
        failed: true,
      },
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
    }
  }

  if (exitCode !== 0 && exitCode !== undefined) {
    return {
      decision: { block: false, failed: true, systemMessage },
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
    }
  }

  if (shouldContinue === false) {
    return {
      decision: {
        block: true,
        reason: stopReason ?? reason ?? "stopped by hook",
        additionalContext,
        systemMessage,
        failed: false,
      },
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
    }
  }

  if (decision === "block") {
    return {
      decision: {
        block: true,
        reason: reason ?? permissionReason ?? "blocked by hook",
        additionalContext,
        systemMessage,
        failed: false,
      },
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
    }
  }

  if (permissionDecision === "deny") {
    return {
      decision: {
        block: true,
        reason: permissionReason ?? "denied by hook",
        additionalContext,
        systemMessage,
        failed: false,
      },
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
    }
  }

  return {
    decision: {
      block: false,
      allow: permissionDecision === "allow" || permissionDecision === "ask" ? permissionDecision === "allow" : undefined,
      reason: permissionReason,
      additionalContext,
      systemMessage,
      failed: false,
    },
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode,
  }
}

/**
 * Substitute the path placeholders Claude Code defines in hook commands.
 */
export function expandHookPaths(command: string, variables: Record<string, string | undefined>): string {
  return command.replace(/\$\{(CLAUDE_[A-Z_]+)\}/g, (match, name: string) => {
    const value = variables[name]
    return value === undefined ? match : value
  })
}

/** Substitute path placeholders in each element of an argument list. */
export function expandHookArgs(args: string[], variables: Record<string, string | undefined>): string[] {
  return args.map((arg) => expandHookPaths(arg, variables))
}
