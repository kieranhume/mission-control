import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Hoist mock refs so vi.mock factories can close over them
const { mockAll, mockGet, mockRun, mockPrepare, mockTransaction, mockWarn, mockError } = vi.hoisted(() => {
  const mockRun = vi.fn(() => ({ lastInsertRowid: 42, changes: 1 }))
  const mockGet = vi.fn()
  const mockAll = vi.fn()
  const mockPrepare = vi.fn(() => ({ all: mockAll, get: mockGet, run: mockRun }))
  const mockTransaction = vi.fn((fn: () => void) => () => fn())
  const mockWarn = vi.fn()
  const mockError = vi.fn()
  return { mockAll, mockGet, mockRun, mockPrepare, mockTransaction, mockWarn, mockError }
})

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({
    prepare: mockPrepare,
    transaction: mockTransaction,
    exec: vi.fn(),
  })),
  db_helpers: { logActivity: vi.fn() },
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: mockWarn, error: mockError, debug: vi.fn() },
}))

vi.mock('@/lib/schedule-parser', () => ({
  isCronDue: vi.fn(() => true),
}))

import { isRecurringTemplate, spawnRecurringTasks } from '../recurring-tasks'

// ---------------------------------------------------------------------------
// isRecurringTemplate — pure predicate
// ---------------------------------------------------------------------------

describe('isRecurringTemplate', () => {
  it('returns true when recurrence.enabled is true', () => {
    expect(isRecurringTemplate({ metadata: { recurrence: { enabled: true } } })).toBe(true)
  })

  it('returns false for spawned child (has parent_task_id but no enabled flag)', () => {
    expect(isRecurringTemplate({ metadata: { recurrence: { parent_task_id: 7 } } })).toBe(false)
  })

  it('returns false for ad-hoc task with no recurrence', () => {
    expect(isRecurringTemplate({ metadata: {} })).toBe(false)
  })

  it('returns false for null metadata', () => {
    expect(isRecurringTemplate({ metadata: null })).toBe(false)
  })

  it('returns false for undefined metadata', () => {
    expect(isRecurringTemplate({})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// brief_path spawner integration
// ---------------------------------------------------------------------------

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: '[recurring] code-reviewer',
    description: 'inline fallback description',
    priority: 'medium',
    project_id: null,
    assigned_to: null,
    created_by: 'scheduler',
    tags: null,
    workspace_id: 1,
    metadata: JSON.stringify({
      recurrence: { cron_expr: '*/30 * * * *', enabled: true, last_spawned_at: null, spawn_count: 0 },
      ...overrides,
    }),
  }
}

let vaultDir: string

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'mc-vault-test-'))
  vi.stubEnv('OBSIDIAN_VAULT_PATH', vaultDir)
  vi.clearAllMocks()
  // Default: no existing duplicate
  mockGet.mockReturnValue(null)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('spawnRecurringTasks — brief_path behaviour', () => {
  it('uses template.description when brief_path is not set', async () => {
    mockAll.mockReturnValueOnce([makeTemplate()])

    const result = await spawnRecurringTasks()

    expect(result.ok).toBe(true)
    // childDescription passed to INSERT should be the inline description
    const calls = mockRun.mock.calls as unknown[][]
    expect(calls.find(args => typeof args[1] === 'string' && (args[1] as string).includes('fallback'))).toBeDefined()
  })

  it('reads vault file when brief_path is set and file exists', async () => {
    const briefFile = join(vaultDir, 'Reference/Agent Briefs/code-reviewer.md')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(vaultDir, 'Reference/Agent Briefs'), { recursive: true })
    writeFileSync(briefFile, 'vault brief content from file')

    mockAll.mockReturnValueOnce([makeTemplate({ brief_path: 'Reference/Agent Briefs/code-reviewer.md' })])

    const result = await spawnRecurringTasks()

    expect(result.ok).toBe(true)
    const calls = mockRun.mock.calls as unknown[][]
    expect(calls.find(args => args[1] === 'vault brief content from file')).toBeDefined()
    expect(mockError).not.toHaveBeenCalled()
  })

  it('falls back to template.description and logs error on path-traversal attempt', async () => {
    mockAll.mockReturnValueOnce([makeTemplate({ brief_path: '../../../etc/passwd' })])

    const result = await spawnRecurringTasks()

    expect(result.ok).toBe(true)
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 1, briefPath: '../../../etc/passwd' }),
      expect.stringContaining('brief_path read failed'),
    )
    const calls = mockRun.mock.calls as unknown[][]
    expect(calls.find(args => typeof args[1] === 'string' && (args[1] as string).includes('fallback'))).toBeDefined()
  })

  it('falls back to template.description and logs error when vault file is missing', async () => {
    mockAll.mockReturnValueOnce([makeTemplate({ brief_path: 'Reference/Agent Briefs/nonexistent.md' })])

    const result = await spawnRecurringTasks()

    expect(result.ok).toBe(true)
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 1, briefPath: 'Reference/Agent Briefs/nonexistent.md' }),
      expect.stringContaining('brief_path read failed'),
    )
    const calls = mockRun.mock.calls as unknown[][]
    expect(calls.find(args => typeof args[1] === 'string' && (args[1] as string).includes('fallback'))).toBeDefined()
  })

  it('logs a warning and falls back when OBSIDIAN_VAULT_PATH is unset', async () => {
    vi.unstubAllEnvs()
    delete process.env.OBSIDIAN_VAULT_PATH

    mockAll.mockReturnValueOnce([makeTemplate({ brief_path: 'Reference/Agent Briefs/code-reviewer.md' })])

    const result = await spawnRecurringTasks()

    expect(result.ok).toBe(true)
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 1 }),
      expect.stringContaining('OBSIDIAN_VAULT_PATH unset'),
    )
  })
})
