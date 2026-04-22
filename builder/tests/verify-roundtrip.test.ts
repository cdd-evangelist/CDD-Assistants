import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  formatVerificationReport,
  recordVerificationResult,
  computeVerdict,
} from '../src/execution-engine/verify-roundtrip.js'
import { loadRecipe } from '../src/execution-engine/load-recipe.js'
import type { Recipe, DivergenceReport } from '../src/types.js'

let tmpDir: string
let recipePath: string
let statePath: string

function createTestRecipe(): Recipe {
  return {
    project: 'test-project',
    created_at: '2026-04-23T00:00:00Z',
    builder_version: '0.1.0',
    tech_stack: { language: 'TypeScript' },
    coding_standards: null,
    chunks: [
      {
        id: 'chunk-01',
        name: 'DB スキーマ',
        description: 'テーブル定義',
        depends_on: [],
        source_docs: [{ path: 'BasicDesign.md', sections: ['§3'], include: 'partial' }],
        source_content: '## テーブル定義\nusers テーブルを作成',
        implementation_prompt: '実装してください',
        expected_outputs: ['src/schema.sql'],
        completion_criteria: ['テーブル作成'],
        test_requirements: { interface_tests: [], boundary_tests: [], integration_refs: [] },
        reference_doc: 'docs/ref/chunk-01-db-schema.md',
        estimated_input_tokens: 500,
        estimated_output_tokens: 300,
        is_integration_test: false,
      },
    ],
    execution_order: [['chunk-01']],
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'verify-roundtrip-test-'))
  recipePath = join(tmpDir, 'recipe.json')
  statePath = join(tmpDir, 'recipe-state.json')
  await writeFile(recipePath, JSON.stringify(createTestRecipe(), null, 2))
  await loadRecipe(recipePath)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('computeVerdict', () => {
  it('致命的乖離があれば NG', () => {
    const report: DivergenceReport = {
      items: [{ severity: 'critical', category: '機能の欠落', description: 'X が実装にない' }],
    }
    expect(computeVerdict(report)).toBe('NG')
  })

  it('要更新があれば 要更新', () => {
    const report: DivergenceReport = {
      items: [{ severity: 'update_needed', category: '設計の進化', description: '実装が拡張されている' }],
    }
    expect(computeVerdict(report)).toBe('要更新')
  })

  it('軽微のみなら OK', () => {
    const report: DivergenceReport = {
      items: [{ severity: 'minor', category: '命名の揺れ', description: '変数名が微妙に異なる' }],
    }
    expect(computeVerdict(report)).toBe('OK')
  })

  it('乖離なしなら OK', () => {
    const report: DivergenceReport = { items: [] }
    expect(computeVerdict(report)).toBe('OK')
  })

  it('致命的が混ざっていれば 要更新より優先される', () => {
    const report: DivergenceReport = {
      items: [
        { severity: 'update_needed', category: '設計の進化', description: '...' },
        { severity: 'critical', category: '型の不一致', description: '...' },
      ],
    }
    expect(computeVerdict(report)).toBe('NG')
  })
})

describe('formatVerificationReport', () => {
  it('判定とサマリーがマークダウンに含まれる', () => {
    const report: DivergenceReport = {
      items: [
        { severity: 'critical', category: '機能の欠落', description: 'X 関数がない' },
        { severity: 'minor', category: '命名の揺れ', description: '変数名差異' },
      ],
    }

    const md = formatVerificationReport({
      chunkName: 'DB スキーマ',
      sourceDocPaths: ['BasicDesign.md'],
      referenceDocPath: 'docs/ref/chunk-01.md',
      timestamp: '2026-04-23T01:00:00Z',
      divergence: report,
    })

    expect(md).toContain('# ラウンドトリップ検証結果: DB スキーマ')
    expect(md).toContain('## 判定: NG')
    expect(md).toContain('BasicDesign.md')
    expect(md).toContain('docs/ref/chunk-01.md')
    expect(md).toContain('機能の欠落')
    expect(md).toContain('X 関数がない')
    expect(md).toContain('命名の揺れ')
    expect(md).toContain('致命的: 1件')
    expect(md).toContain('軽微: 1件')
  })

  it('乖離が空でも整形される', () => {
    const md = formatVerificationReport({
      chunkName: 'チャンク',
      sourceDocPaths: ['design.md'],
      referenceDocPath: 'docs/ref/chunk-01.md',
      timestamp: '2026-04-23T01:00:00Z',
      divergence: { items: [] },
    })

    expect(md).toContain('## 判定: OK')
    expect(md).toContain('致命的: 0件')
  })
})

describe('recordVerificationResult', () => {
  it('verification-{chunk_id}.md を docs/ref/ に書き出す', async () => {
    const report: DivergenceReport = {
      items: [{ severity: 'minor', category: '命名の揺れ', description: 'foo vs bar' }],
    }

    const result = await recordVerificationResult(statePath, 'chunk-01', report)

    expect(result.verdict).toBe('OK')
    expect(result.verification_path).toContain('verification-chunk-01.md')

    const content = await readFile(result.verification_path, 'utf-8')
    expect(content).toContain('# ラウンドトリップ検証結果: DB スキーマ')
    expect(content).toContain('OK')
  })

  it('working_dir 配下の docs/ref/ に出力する', async () => {
    const report: DivergenceReport = { items: [] }
    const result = await recordVerificationResult(statePath, 'chunk-01', report)

    // load_recipe では working_dir が recipe と同じディレクトリ
    expect(result.verification_path).toContain(tmpDir)
    expect(result.verification_path).toMatch(/docs[/\\]ref[/\\]verification-chunk-01\.md$/)
  })

  it('存在しないチャンク ID ならエラー', async () => {
    const report: DivergenceReport = { items: [] }
    await expect(recordVerificationResult(statePath, 'chunk-99', report)).rejects.toThrow(/見つかりません/)
  })

  it('致命的乖離があれば verdict が NG になる', async () => {
    const report: DivergenceReport = {
      items: [{ severity: 'critical', category: '型の不一致', description: '...' }],
    }
    const result = await recordVerificationResult(statePath, 'chunk-01', report)
    expect(result.verdict).toBe('NG')
  })
})
