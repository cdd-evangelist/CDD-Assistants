import { describe, it, expect } from 'vitest'
import { splitChunks } from '../src/recipe-engine/split-chunks.js'
import type { AnalyzeDesignResult, SplitChunksInput, DocLayer, DocFrontmatter } from '../src/types.js'

function makeAnalysis(overrides?: Partial<AnalyzeDesignResult>): AnalyzeDesignResult {
  return {
    project_name: 'TestProject',
    drift_warnings: [],
    documents: [],
    dependency_graph: {},
    layers: {
      foundation: [],
      specification: [],
      usecase: [],
      interface: [],
      execution: [],
      context: [],
    },
    tech_stack: { language: 'TypeScript' },
    coding_standards: null,
    total_tokens: 0,
    ...overrides,
  }
}

function makeDoc(
  path: string,
  layer: DocLayer,
  tokens: number = 2000,
  refs: { to?: string[]; by?: string[] } = {},
  opts: { sections?: string[]; frontmatter?: DocFrontmatter } = {},
) {
  return {
    path,
    lines: Math.ceil(tokens / 5),
    estimated_tokens: tokens,
    layer,
    sections: opts.sections ?? ['概要', '詳細'],
    references_to: refs.to ?? [],
    referenced_by: refs.by ?? [],
    ...(opts.frontmatter ? { frontmatter: opts.frontmatter } : {}),
  }
}

describe('splitChunks', () => {
  it('基本的なチャンク分割ができる', async () => {
    const analysis = makeAnalysis({
      documents: [
        makeDoc('BasicDesign.md', 'foundation', 3000),
        makeDoc('ghost-policy-spec.md', 'specification', 4000),
      ],
      layers: {
        foundation: ['BasicDesign.md'],
        specification: ['ghost-policy-spec.md'],
        usecase: [],
        interface: [],
        execution: [],
        context: [],
      },
    })

    const result = await splitChunks({
      analysis,
      docs_dir: '/tmp',
    })

    const realChunks = result.chunks.filter(c => !c.is_integration_test)
    expect(realChunks).toHaveLength(2)
    expect(realChunks[0].name).toContain('BasicDesign')
    expect(realChunks[1].name).toContain('ghost-policy-spec')
  })

  it('usecase と context の文書はスキップする', async () => {
    const analysis = makeAnalysis({
      documents: [
        makeDoc('BasicDesign.md', 'foundation', 3000),
        makeDoc('usecases.md', 'usecase', 2000),
        makeDoc('todo.md', 'context', 500),
      ],
      layers: {
        foundation: ['BasicDesign.md'],
        specification: [],
        usecase: ['usecases.md'],
        interface: [],
        execution: [],
        context: ['todo.md'],
      },
    })

    const result = await splitChunks({
      analysis,
      docs_dir: '/tmp',
    })

    const realChunks = result.chunks.filter(c => !c.is_integration_test)
    expect(realChunks).toHaveLength(1) // foundation のみ
    expect(realChunks[0].name).toContain('BasicDesign')
  })

  it('レイヤー間の依存関係を設定する（data → logic → interface）', async () => {
    const analysis = makeAnalysis({
      documents: [
        makeDoc('BasicDesign.md', 'foundation', 3000),
        makeDoc('spec.md', 'specification', 4000),
        makeDoc('cli.md', 'interface', 2000),
      ],
      dependency_graph: {
        'BasicDesign.md': [],
        'spec.md': ['BasicDesign.md'],
        'cli.md': ['spec.md'],
      },
      layers: {
        foundation: ['BasicDesign.md'],
        specification: ['spec.md'],
        usecase: [],
        interface: ['cli.md'],
        execution: [],
        context: [],
      },
    })

    const result = await splitChunks({
      analysis,
      docs_dir: '/tmp',
    })

    const realChunks = result.chunks.filter(c => !c.is_integration_test)
    expect(realChunks).toHaveLength(3)

    // chunk-01 (data/foundation) は依存なし
    const chunk01 = result.chunks.find(c => c.id === 'chunk-01')!
    expect(chunk01.depends_on).toHaveLength(0)

    // chunk-02 (logic/specification) は data に依存
    const chunk02 = result.chunks.find(c => c.id === 'chunk-02')!
    expect(chunk02.depends_on).toContain('chunk-01')

    // chunk-03 (interface) は logic に依存
    const chunk03 = result.chunks.find(c => c.id === 'chunk-03')!
    expect(chunk03.depends_on).toContain('chunk-02')
  })

  it('execution_order がDAGのレベル順になる', async () => {
    const analysis = makeAnalysis({
      documents: [
        makeDoc('design.md', 'foundation', 3000),
        makeDoc('spec-a.md', 'specification', 2000),
        makeDoc('spec-b.md', 'specification', 2000),
      ],
      layers: {
        foundation: ['design.md'],
        specification: ['spec-a.md', 'spec-b.md'],
        usecase: [],
        interface: [],
        execution: [],
        context: [],
      },
    })

    const result = await splitChunks({
      analysis,
      docs_dir: '/tmp',
    })

    // Level 0: foundation, Level 1: specification (並列), Level 2+: 統合テスト
    // 実装チャンクのレベルだけ確認: foundation → 2つの specification
    const realLevels = result.execution_order.filter(level =>
      level.some(id => !result.chunks.find(c => c.id === id)!.is_integration_test),
    )
    expect(realLevels).toHaveLength(2)
    expect(realLevels[0].filter(id => !result.chunks.find(c => c.id === id)!.is_integration_test)).toHaveLength(1)
    expect(realLevels[1].filter(id => !result.chunks.find(c => c.id === id)!.is_integration_test)).toHaveLength(2)
  })

  it('トークン上限超過で警告を出す', async () => {
    const analysis = makeAnalysis({
      documents: [
        makeDoc('huge.md', 'foundation', 15000), // 8000 超過
      ],
      layers: {
        foundation: ['huge.md'],
        specification: [],
        usecase: [],
        interface: [],
        execution: [],
        context: [],
      },
    })

    const result = await splitChunks({
      analysis,
      docs_dir: '/tmp',
      constraints: { max_input_tokens: 8000 },
    })

    expect(result.review_notes.some(n => n.includes('超過'))).toBe(true)
  })

  it('常に needs_review=true で要レビュー項目を返す', async () => {
    const analysis = makeAnalysis({
      documents: [
        makeDoc('a.md', 'foundation', 2000),
      ],
      layers: {
        foundation: ['a.md'],
        specification: [],
        usecase: [],
        interface: [],
        execution: [],
        context: [],
      },
    })

    const result = await splitChunks({
      analysis,
      docs_dir: '/tmp',
    })

    expect(result.needs_review).toBe(true)
    expect(result.review_notes).toContain('各チャンクの expected_outputs を設定してください')
  })

  it('関連ユースケースを validation_context に設定する', async () => {
    const analysis = makeAnalysis({
      documents: [
        makeDoc('BasicDesign.md', 'foundation', 3000, { by: ['usecases.md'] }),
        makeDoc('usecases.md', 'usecase', 2000, { to: ['BasicDesign.md'] }),
      ],
      layers: {
        foundation: ['BasicDesign.md'],
        specification: [],
        usecase: ['usecases.md'],
        interface: [],
        execution: [],
        context: [],
      },
    })

    const result = await splitChunks({
      analysis,
      docs_dir: '/tmp',
    })

    // foundation のチャンクに usecase が validation_context として紐付く
    const chunk = result.chunks.find(c => c.name.includes('BasicDesign'))!
    expect(chunk.validation_context).toContain('usecases.md')
  })

  it('実装対象がない場合、空のチャンクと要レビューを返す', async () => {
    const analysis = makeAnalysis({
      documents: [
        makeDoc('todo.md', 'context', 500),
        makeDoc('usecases.md', 'usecase', 1000),
      ],
      layers: {
        foundation: [],
        specification: [],
        usecase: ['usecases.md'],
        interface: [],
        execution: [],
        context: ['todo.md'],
      },
    })

    const result = await splitChunks({
      analysis,
      docs_dir: '/tmp',
    })

    expect(result.chunks).toHaveLength(0)
    expect(result.needs_review).toBe(true)
    expect(result.review_notes.some(n => n.includes('実装対象の文書が見つかりません'))).toBe(true)
  })

  it('implementation_prompt_template にチャンク名が含まれる', async () => {
    const analysis = makeAnalysis({
      documents: [
        makeDoc('BasicDesign.md', 'foundation', 3000),
      ],
      layers: {
        foundation: ['BasicDesign.md'],
        specification: [],
        usecase: [],
        interface: [],
        execution: [],
        context: [],
      },
    })

    const result = await splitChunks({
      analysis,
      docs_dir: '/tmp',
    })

    expect(result.chunks[0].implementation_prompt_template).toContain('BasicDesign')
    expect(result.chunks[0].implementation_prompt_template).toContain('{source_content}')
  })

  // --- Part A: status フィルタ（Step 0） ---

  describe('status による入力選別', () => {
    it('status: draft の文書は除外され、警告される', async () => {
      const analysis = makeAnalysis({
        documents: [
          makeDoc('ready.md', 'foundation', 2000, {}, { frontmatter: { status: 'complete' } }),
          makeDoc('wip.md', 'foundation', 2000, {}, { frontmatter: { status: 'draft' } }),
        ],
        layers: {
          foundation: ['ready.md', 'wip.md'],
          specification: [],
          usecase: [],
          interface: [],
          execution: [],
          context: [],
        },
      })

      const result = await splitChunks({ analysis, docs_dir: '/tmp' })

      expect(result.chunks.map(c => c.name)).not.toContain(expect.stringContaining('wip'))
      expect(result.chunks.some(c => c.name.includes('ready'))).toBe(true)
      expect(result.review_notes.some(n => n.includes('draft') && n.includes('wip.md'))).toBe(true)
    })

    it('status: archived の文書は警告なしで除外される', async () => {
      const analysis = makeAnalysis({
        documents: [
          makeDoc('active.md', 'foundation', 2000),
          makeDoc('old.md', 'foundation', 2000, {}, { frontmatter: { status: 'archived' } }),
        ],
        layers: {
          foundation: ['active.md', 'old.md'],
          specification: [],
          usecase: [],
          interface: [],
          execution: [],
          context: [],
        },
      })

      const result = await splitChunks({ analysis, docs_dir: '/tmp' })

      expect(result.chunks.some(c => c.name.includes('old'))).toBe(false)
      expect(result.review_notes.some(n => n.includes('old.md'))).toBe(false)
    })

    it('status: in_review / complete / 未設定 の文書は含められる', async () => {
      const analysis = makeAnalysis({
        documents: [
          makeDoc('a.md', 'foundation', 2000, {}, { frontmatter: { status: 'in_review' } }),
          makeDoc('b.md', 'foundation', 2000, {}, { frontmatter: { status: 'complete' } }),
          makeDoc('c.md', 'foundation', 2000), // frontmatter 未設定
        ],
        layers: {
          foundation: ['a.md', 'b.md', 'c.md'],
          specification: [],
          usecase: [],
          interface: [],
          execution: [],
          context: [],
        },
      })

      const result = await splitChunks({ analysis, docs_dir: '/tmp' })

      const realChunks = result.chunks.filter(c => !c.is_integration_test)
      expect(realChunks).toHaveLength(3)
    })
  })

  // --- Part B: test_requirements 抽出 ---

  describe('test_requirements 抽出', () => {
    it('インターフェース系セクションを interface_tests に抽出する', async () => {
      const analysis = makeAnalysis({
        documents: [
          makeDoc('api.md', 'interface', 2000, {}, {
            sections: ['概要', '公開 API', 'メソッド一覧', 'エラー処理'],
          }),
        ],
        layers: {
          foundation: [],
          specification: [],
          usecase: [],
          interface: ['api.md'],
          execution: [],
          context: [],
        },
      })

      const result = await splitChunks({ analysis, docs_dir: '/tmp' })

      expect(result.chunks[0].test_requirements.interface_tests).toEqual(
        expect.arrayContaining([expect.stringContaining('公開 API')]),
      )
      expect(result.chunks[0].test_requirements.interface_tests).toEqual(
        expect.arrayContaining([expect.stringContaining('メソッド一覧')]),
      )
    })

    it('エラー系セクションを boundary_tests に抽出する', async () => {
      const analysis = makeAnalysis({
        documents: [
          makeDoc('spec.md', 'specification', 2000, {}, {
            sections: ['概要', '異常系', 'エラー処理', '境界値', '詳細'],
          }),
        ],
        layers: {
          foundation: [],
          specification: ['spec.md'],
          usecase: [],
          interface: [],
          execution: [],
          context: [],
        },
      })

      const result = await splitChunks({ analysis, docs_dir: '/tmp' })

      const bt = result.chunks[0].test_requirements.boundary_tests
      expect(bt.some(t => t.includes('異常系'))).toBe(true)
      expect(bt.some(t => t.includes('エラー処理'))).toBe(true)
      expect(bt.some(t => t.includes('境界値'))).toBe(true)
    })

    it('depends_on のチャンク名を integration_refs に設定する', async () => {
      const analysis = makeAnalysis({
        documents: [
          makeDoc('data.md', 'foundation', 2000),
          makeDoc('logic.md', 'specification', 2000),
        ],
        layers: {
          foundation: ['data.md'],
          specification: ['logic.md'],
          usecase: [],
          interface: [],
          execution: [],
          context: [],
        },
      })

      const result = await splitChunks({ analysis, docs_dir: '/tmp' })

      const logic = result.chunks.find(c => c.name.includes('logic'))!
      expect(logic.test_requirements.integration_refs.length).toBeGreaterThan(0)
      expect(logic.test_requirements.integration_refs.some(r => r.includes('data'))).toBe(true)
    })
  })

  // --- Part C: 統合テストチャンクの自動挿入 ---

  describe('統合テストチャンクの自動挿入', () => {
    it('レイヤー境界（data → logic）で統合テストチャンクを挿入する', async () => {
      const analysis = makeAnalysis({
        documents: [
          makeDoc('data.md', 'foundation', 2000),
          makeDoc('logic.md', 'specification', 2000),
        ],
        layers: {
          foundation: ['data.md'],
          specification: ['logic.md'],
          usecase: [],
          interface: [],
          execution: [],
          context: [],
        },
      })

      const result = await splitChunks({ analysis, docs_dir: '/tmp' })

      const integrationChunks = result.chunks.filter(c => c.is_integration_test)
      expect(integrationChunks.length).toBeGreaterThan(0)
      // 境界統合テストは data レイヤーのチャンクに依存する
      expect(integrationChunks.some(c => c.depends_on.length > 0)).toBe(true)
    })

    it('依存合流点（3チャンク以上が合流）で統合テストチャンクを挿入する', async () => {
      const analysis = makeAnalysis({
        documents: [
          makeDoc('base1.md', 'foundation', 1500),
          makeDoc('base2.md', 'foundation', 1500),
          makeDoc('base3.md', 'foundation', 1500),
          makeDoc('merge.md', 'specification', 2000, { to: ['base1.md', 'base2.md', 'base3.md'] }),
        ],
        dependency_graph: {
          'base1.md': [],
          'base2.md': [],
          'base3.md': [],
          'merge.md': ['base1.md', 'base2.md', 'base3.md'],
        },
        layers: {
          foundation: ['base1.md', 'base2.md', 'base3.md'],
          specification: ['merge.md'],
          usecase: [],
          interface: [],
          execution: [],
          context: [],
        },
      })

      const result = await splitChunks({ analysis, docs_dir: '/tmp' })

      // 合流ノード（merge.md）の統合テストチャンクが生成される
      const integrationChunks = result.chunks.filter(c => c.is_integration_test)
      expect(integrationChunks.length).toBeGreaterThan(0)
    })

    it('最終位置に E2E テストチャンクを挿入する', async () => {
      const analysis = makeAnalysis({
        documents: [
          makeDoc('a.md', 'foundation', 2000),
          makeDoc('b.md', 'specification', 2000),
        ],
        layers: {
          foundation: ['a.md'],
          specification: ['b.md'],
          usecase: [],
          interface: [],
          execution: [],
          context: [],
        },
      })

      const result = await splitChunks({ analysis, docs_dir: '/tmp' })

      // execution_order の最終レベルに統合テストチャンクが含まれる
      const lastLevel = result.execution_order[result.execution_order.length - 1]
      const lastLevelChunks = lastLevel.map(id => result.chunks.find(c => c.id === id)!)
      expect(lastLevelChunks.some(c => c.is_integration_test)).toBe(true)
    })

    it('統合テストチャンクには implementation_prompt_template がプレースホルダで入る', async () => {
      const analysis = makeAnalysis({
        documents: [
          makeDoc('a.md', 'foundation', 2000),
          makeDoc('b.md', 'specification', 2000),
        ],
        layers: {
          foundation: ['a.md'],
          specification: ['b.md'],
          usecase: [],
          interface: [],
          execution: [],
          context: [],
        },
      })

      const result = await splitChunks({ analysis, docs_dir: '/tmp' })

      const integrationChunk = result.chunks.find(c => c.is_integration_test)!
      expect(integrationChunk.implementation_prompt_template).toContain('統合テスト')
      expect(integrationChunk.expected_outputs).toHaveLength(0)
    })
  })
})
