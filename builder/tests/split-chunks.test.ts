import { describe, it, expect } from 'vitest'
import { splitChunks } from '../src/recipe-engine/split-chunks.js'
import type { AnalyzeDesignResult, SplitChunksInput, DocLayer } from '../src/types.js'

function makeAnalysis(overrides?: Partial<AnalyzeDesignResult>): AnalyzeDesignResult {
  return {
    project_name: 'TestProject',
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
    total_tokens: 0,
    ...overrides,
  }
}

function makeDoc(path: string, layer: DocLayer, tokens: number = 2000, refs: { to?: string[]; by?: string[] } = {}) {
  return {
    path,
    lines: Math.ceil(tokens / 5),
    estimated_tokens: tokens,
    layer,
    sections: ['概要', '詳細'],
    references_to: refs.to ?? [],
    referenced_by: refs.by ?? [],
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

    expect(result.chunks).toHaveLength(2)
    expect(result.chunks[0].name).toContain('BasicDesign')
    expect(result.chunks[1].name).toContain('ghost-policy-spec')
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

    expect(result.chunks).toHaveLength(1) // foundation のみ
    expect(result.chunks[0].name).toContain('BasicDesign')
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

    expect(result.chunks).toHaveLength(3)

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

    // Level 0: foundation, Level 1: specification (並列)
    expect(result.execution_order).toHaveLength(2)
    expect(result.execution_order[0]).toHaveLength(1) // foundation
    expect(result.execution_order[1]).toHaveLength(2) // 2つの specification
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
})
