import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  checkReadiness,
  defaultValidateFolderStructure,
} from '../src/tools/check-readiness.js'
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
    standard_doc_path: null,
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
    // フォルダ構成検証は既存テストでは無関心な観点なので空を返す
    validateFolderStructure: async () => ({ blockers: [], warnings: [] }),
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
    await writeFile(join(tmpDir, 'basic-design.md'), [
      '---',
      'status: complete',
      'layer: foundation',
      '---',
      '# 基本設計',
      '## 概要',
      'TypeScript で実装する。',
    ].join('\n'))
    await mkdir(join(tmpDir, '3-details'), { recursive: true })

    const result = await checkReadiness({ project_dir: tmpDir })

    expect(result.ready).toBe(true)
    expect(result.handoff_summary).toContain('Builder')
  })

  it('sample-project fixtures で動作する', async () => {
    const fixturesDir = join(import.meta.dirname, 'fixtures', 'sample-project')
    const result = await checkReadiness({ project_dir: fixturesDir })

    // ai-usecases.md が draft + フォルダ構成違反のため not ready
    expect(result.ready).toBe(false)
    expect(result.blockers.length).toBeGreaterThan(0)
  })

  describe('defaultValidateFolderStructure', () => {
    it('basic-design.md と 3-details/ が揃っていれば blocker なし', async () => {
      await writeFile(join(tmpDir, 'basic-design.md'), '# 基本')
      await mkdir(join(tmpDir, '3-details'), { recursive: true })
      await mkdir(join(tmpDir, '1-usecases'), { recursive: true })
      await mkdir(join(tmpDir, '2-features'), { recursive: true })

      const result = await defaultValidateFolderStructure(tmpDir)

      expect(result.blockers).toHaveLength(0)
      expect(result.warnings).toHaveLength(0)
    })

    it('basic-design.md が無いと missing_basic_design blocker', async () => {
      const result = await defaultValidateFolderStructure(tmpDir)
      expect(result.blockers.some(b => b.type === 'missing_basic_design')).toBe(true)
    })

    it('3-details/ が無いと missing_details_dir blocker', async () => {
      await writeFile(join(tmpDir, 'basic-design.md'), '# 基本')

      const result = await defaultValidateFolderStructure(tmpDir)
      expect(result.blockers.some(b => b.type === 'missing_details_dir')).toBe(true)
    })

    it('1-usecases/ が無いと missing_usecases_dir warning', async () => {
      await writeFile(join(tmpDir, 'basic-design.md'), '# 基本')
      await mkdir(join(tmpDir, '3-details'), { recursive: true })
      await mkdir(join(tmpDir, '2-features'), { recursive: true })

      const result = await defaultValidateFolderStructure(tmpDir)
      expect(result.blockers).toHaveLength(0)
      expect(result.warnings.some(w => w.type === 'missing_usecases_dir')).toBe(true)
    })

    it('2-features/ が無いと missing_features_dir warning', async () => {
      await writeFile(join(tmpDir, 'basic-design.md'), '# 基本')
      await mkdir(join(tmpDir, '3-details'), { recursive: true })
      await mkdir(join(tmpDir, '1-usecases'), { recursive: true })

      const result = await defaultValidateFolderStructure(tmpDir)
      expect(result.blockers).toHaveLength(0)
      expect(result.warnings.some(w => w.type === 'missing_features_dir')).toBe(true)
    })

    it('複数コンポーネント構成で各コンポーネントを検証する', async () => {
      // planner: 完備、builder: 3-details/ 欠落
      await mkdir(join(tmpDir, 'planner', '3-details'), { recursive: true })
      await mkdir(join(tmpDir, 'planner', '1-usecases'), { recursive: true })
      await mkdir(join(tmpDir, 'planner', '2-features'), { recursive: true })
      await writeFile(join(tmpDir, 'planner', 'basic-design.md'), '# planner')

      await mkdir(join(tmpDir, 'builder'), { recursive: true })
      await writeFile(join(tmpDir, 'builder', 'basic-design.md'), '# builder')

      const result = await defaultValidateFolderStructure(tmpDir)

      // builder の 3-details/ 欠落のみ blocker
      const detailsBlockers = result.blockers.filter(b => b.type === 'missing_details_dir')
      expect(detailsBlockers).toHaveLength(1)
      expect(detailsBlockers[0].message).toContain('builder')

      // builder の usecases/features 欠落は warning
      const builderWarnings = result.warnings.filter(w => w.message.includes('builder'))
      expect(builderWarnings.length).toBeGreaterThanOrEqual(2)
    })

    it('basic-design.md がどこにも無ければ missing_basic_design blocker のみ返す', async () => {
      await mkdir(join(tmpDir, 'planner'), { recursive: true })
      // basic-design.md は無い

      const result = await defaultValidateFolderStructure(tmpDir)
      expect(result.blockers).toHaveLength(1)
      expect(result.blockers[0].type).toBe('missing_basic_design')
    })
  })
})
