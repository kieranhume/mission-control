/**
 * Performance regression test for /api/memory/health.
 * Runs runHealthDiagnostics against the Obsidian vault (516 .md files).
 * Skip if vault not present (CI) or SKIP_PERF_TEST env var set.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { runHealthDiagnostics } from '../memory-utils'

const VAULT = '/Users/kieranhume/Documents/Obsidian/kieran'
const TIMEOUT_MS = 8_000

describe('memory health perf', () => {
  it('completes against 500+ file vault in under 5s', { timeout: TIMEOUT_MS }, async () => {
    if (!existsSync(VAULT)) {
      console.log('SKIP: vault not found at', VAULT)
      return
    }

    const t0 = Date.now()
    const report = await runHealthDiagnostics(VAULT)
    const elapsed = Date.now() - t0

    console.log(`runHealthDiagnostics: ${elapsed}ms, overall=${report.overall} (${report.overallScore})`)
    report.categories.forEach((c) =>
      console.log(`  ${c.name}: ${c.score} (${c.status})`)
    )

    // Must complete in under 5s
    expect(elapsed).toBeLessThan(5_000)
    // Must return a valid report with all 8 categories
    expect(report.categories.length).toBe(8)
    expect(report.overall).toMatch(/healthy|warning|critical/)
  })
})
