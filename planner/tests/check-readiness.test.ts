import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkReadiness } from '../src/tools/check-readiness.js'
import type { ReadinessDeps } from '../src/tools/check-readiness.js'
import type { DesignContextResult, CheckConsistencyResult } from '../src/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'check-readiness-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// DI 用ヘルパー
function makeDeps(
  ctx: Partial<DesignContextResult> = {},
  consistency: Partial<CheckConsistencyResult> = {},
): ReadinessDeps {
  const defaultCtx: DesignContextResult = {
    project: 'test',
    documents: [],
    overall_progress: { complete: 0, in_progress: 0, draft: 0, total: 0, readiness: 'not_ready' },
    unresolved_questions: [],
    dependency_graph: {},
    total_tokens: 0,
    ...ctx,
  }
  const defaultConsistency: CheckConsistencyResult = {
    status: 'ok',
    issues: [],
    summary: { errors: 0, warnings: 0, info: 0 },
    ...consistency,
  }
  return {
    getDesignContext: async () => defaultCtx,
    getConsistency: async () => defaultConsistency,
  }
}

describe('checkReadiness', () => {
  it('全文書 complete かつ問題なしなら ready', async () => {
    const deps = makeDeps({
      documents: [
        { path: 'a.md', status: 'complete', layer: 'foundation', estimated_tokens: 100, sections: ['概要'], decisions: [], open_questions: [], references_to: [], referenced_by: [] },
        { path: 'b.md', status: 'complete', layer: 'interface', estimated_tokens: 100, sections: ['API'], decisions: [], open_questions: [], references_to: [], referenced_by: [] },
      ],
      overall_progress: { complete: 2, in_progress: 0, draft: 0, total: 2, readiness: 'ready' },
    })

    const result = await checkReadiness({ project_dir: tmpDir }, deps)

    expect(result.ready).toBe(true)
    expect(result.blockers).toHaveLength(0)
  })

  it('未完了文書があれば blocker', async () => {
    const deps = makeDeps({
      documents: [
        { path: 'a.md', status: 'complete', layer: 'foundation', estimated_tokens: 100, sections: [], decisions: [], open_questions: [], references_to: [], referenced_by: [] },
        { path: 'b.md', status: 'draft', layer: 'interface', estimated_tokens: 100, sections: [], decisions: [], open_questions: [], references_to: [], referenced_by: [] },
      ],
      overall_progress: { complete: 1, in_progress: 0, draft: 1, total: 2, readiness: 'not_ready' },
    })

    const result = await checkReadiness({ project_dir: tmpDir }, deps)

    expect(result.ready).toBe(false)
    const blocker = result.blockers.find(b => b.type === 'incomplete_documents')
    expect(blocker).toBeDefined()
    expect(blocker!.message).toContain('b.md')
  })

  it('ブロッキングな未決事項があれば blocker', async () => {
    const deps = makeDeps({
      documents: [
        { path: 'a.md', status: 'complete', layer: 'foundation', estimated_tokens: 100, sections: [], decisions: [], open_questions: [], references_to: [], referenced_by: [] },
      ],
      overall_progress: { complete: 1, in_progress: 0, draft: 0, total: 1, readiness: 'ready' },
      unresolved_questions: [
        { source: 'a.md', question: '重要な質問', blocking: true },
      ],
    })

    const result = await checkReadiness({ project_dir: tmpDir }, deps)

    expect(result.ready).toBe(false)
    const blocker = result.blockers.find(b => b.type === 'blocking_questions')
    expect(blocker).toBeDefined()
  })

  it('整合性エラーがあれば blocker', async () => {
    const deps = makeDeps(
      {
        documents: [
          { path: 'a.md', status: 'complete', layer: 'foundation', estimated_tokens: 100, sections: [], decisions: [], open_questions: [], references_to: [], referenced_by: [] },
        ],
        overall_progress: { complete: 1, in_progress: 0, draft: 0, total: 1, readiness: 'ready' },
      },
      {
        status: 'error',
        issues: [
          { category: 'references', severity: 'error', message: 'エラーあり' },
        ],
        summary: { errors: 1, warnings: 0, info: 0 },
      },
    )

    const result = await checkReadiness({ project_dir: tmpDir }, deps)

    expect(result.ready).toBe(false)
    const blocker = result.blockers.find(b => b.type === 'consistency_errors')
    expect(blocker).toBeDefined()
  })

  it('整合性の warning は blocker ではなく warning', async () => {
    const deps = makeDeps(
      {
        documents: [
          { path: 'a.md', status: 'complete', layer: 'foundation', estimated_tokens: 100, sections: [], decisions: [], open_questions: [], references_to: [], referenced_by: [] },
        ],
        overall_progress: { complete: 1, in_progress: 0, draft: 0, total: 1, readiness: 'ready' },
      },
      {
        status: 'warn',
        issues: [
          { category: 'terminology', severity: 'warn', message: '用語の揺れ' },
        ],
        summary: { errors: 0, warnings: 1, info: 0 },
      },
    )

    const result = await checkReadiness({ project_dir: tmpDir }, deps)

    expect(result.ready).toBe(true)
    expect(result.warnings.some(w => w.type === 'consistency')).toBe(true)
  })

  it('required_coverage で不足分を検出する', async () => {
    const deps = makeDeps({
      documents: [
        { path: 'BasicDesign.md', status: 'complete', layer: 'foundation', estimated_tokens: 100, sections: ['概要'], decisions: [], open_questions: [], references_to: [], referenced_by: [] },
      ],
      overall_progress: { complete: 1, in_progress: 0, draft: 0, total: 1, readiness: 'ready' },
    })

    const result = await checkReadiness(
      { project_dir: tmpDir, required_coverage: ['usecase', 'interface'] },
      deps,
    )

    expect(result.ready).toBe(false)
    const missing = result.blockers.filter(b => b.type === 'missing_coverage')
    expect(missing.length).toBeGreaterThanOrEqual(1)
  })

  it('handoff_summary が生成される', async () => {
    const deps = makeDeps({
      documents: [
        { path: 'a.md', status: 'complete', layer: 'foundation', estimated_tokens: 100, sections: [], decisions: [], open_questions: [], references_to: [], referenced_by: [] },
      ],
      overall_progress: { complete: 1, in_progress: 0, draft: 0, total: 1, readiness: 'ready' },
    })

    const result = await checkReadiness({ project_dir: tmpDir }, deps)

    expect(result.handoff_summary).toBeTruthy()
    expect(result.handoff_summary).toContain('Builder')
  })

  it('実際のファイルシステムで動作する（DI なし）', async () => {
    await writeFile(join(tmpDir, 'a.md'), [
      '---',
      'status: complete',
      'layer: foundation',
      '---',
      '# 基本設計',
      '## 概要',
      'TypeScript で実装する。',
    ].join('\n'))

    const result = await checkReadiness({ project_dir: tmpDir })

    expect(result.ready).toBe(true)
    expect(result.handoff_summary).toContain('Builder')
  })

  it('sample-project fixtures で動作する', async () => {
    const fixturesDir = join(import.meta.dirname, 'fixtures', 'sample-project')
    const result = await checkReadiness({ project_dir: fixturesDir })

    // ai-usecases.md が draft なので not ready
    expect(result.ready).toBe(false)
    expect(result.blockers.length).toBeGreaterThan(0)
  })
})
