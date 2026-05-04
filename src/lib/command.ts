import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config'
import { logger } from './logger'

/**
 * Cache the openclaw-availability lookup at module load. The MC server
 * spawns runOpenClaw on the scheduler's 60s tick from two flows; without
 * caching the lookup we'd hit the FS for every tick.
 *
 * Resolves config.openclawBin against PATH (when bare) or checks the
 * absolute path (when fully qualified).
 */
let _openClawCheckedAt: number | null = null
let _openClawAvailable = false
function _resolveOpenClaw(bin: string): string | null {
  if (bin.includes('/')) return existsSync(bin) ? bin : null
  const pathDirs = (process.env.PATH || '').split(':').filter(Boolean)
  for (const dir of pathDirs) {
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  return null
}
export function isOpenClawAvailable(): boolean {
  // Re-check at most once per 5 minutes — handles the case where
  // openclaw gets installed without an MC restart.
  const now = Date.now()
  if (_openClawCheckedAt !== null && now - _openClawCheckedAt < 5 * 60 * 1000) {
    return _openClawAvailable
  }
  const resolved = _resolveOpenClaw(config.openclawBin)
  const wasAvailable = _openClawAvailable
  _openClawAvailable = resolved !== null
  _openClawCheckedAt = now
  if (_openClawCheckedAt !== null && wasAvailable !== _openClawAvailable) {
    logger.info({ openclawBin: config.openclawBin, resolved, available: _openClawAvailable }, 'OpenClaw availability changed')
  }
  return _openClawAvailable
}

interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  input?: string
}

interface CommandResult {
  stdout: string
  stderr: string
  code: number | null
}

export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false
    })

    let stdout = ''
    let stderr = ''
    let timeoutId: NodeJS.Timeout | undefined

    if (options.timeoutMs) {
      timeoutId = setTimeout(() => {
        child.kill('SIGKILL')
      }, options.timeoutMs)
    }

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId)
      reject(error)
    })

    child.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId)
      if (code === 0) {
        resolve({ stdout, stderr, code })
        return
      }
      const error = new Error(
        `Command failed (${command} ${args.join(' ')}): ${stderr || stdout}`
      )
      ;(error as any).stdout = stdout
      ;(error as any).stderr = stderr
      ;(error as any).code = code
      reject(error)
    })

    if (options.input) {
      child.stdin.write(options.input)
      child.stdin.end()
    }
  })
}

export function runOpenClaw(args: string[], options: CommandOptions = {}) {
  return runCommand(config.openclawBin, args, {
    ...options,
    cwd: options.cwd || config.openclawStateDir || process.cwd()
  })
}

export function runClawdbot(args: string[], options: CommandOptions = {}) {
  return runCommand(config.clawdbotBin, args, {
    ...options,
    cwd: options.cwd || config.openclawStateDir || process.cwd()
  })
}
