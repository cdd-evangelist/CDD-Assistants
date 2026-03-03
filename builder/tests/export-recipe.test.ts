import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exportRecipe } from '../src/recipe-engine/export-recipe.js'
import { extractSections } from '../src/recipe-engine/export-recipe.js'
import type { ExportRecipeInput, Recipe } from '../src/types.js'

let tmpDir: string
let docsDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'export-recipe-test-'))
  docsDir = join(tmpDir, 'docs')
  await mkdir(docsDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// --- extractSections のテスト ---

describe('extractSections', () => {
  it('指定セクションを見出しレベル基準で抽出する', () => {
    const md = [
      '# ドキュメント',
      '## 1. 概要',
      'ここは概要。',
      '## 2. 詳細',
      '### 2.1 サブセクション',
      'サブの内容。',
      '## 3. まとめ',
      'まとめの内容。',
    ].join('\n')

    const result = extractSections(md, ['2. 詳細'])
    expect(result).toContain('## 2. 詳細')
    expect(result).toContain('### 2.1 サブセクション')
    expect(result).toContain('サブの内容。')
    expect(result).not.toContain('## 3. まとめ')
    expect(result).not.toContain('## 1. 概要')
  })

  it('複数セクションを抽出する', () => {
    const md = [
      '## A',
      '内容A',
      '## B',
      '内容B',
      '## C',
      '内容C',
    ].join('\n')

    const result = extractSections(md, ['A', 'C'])
    expect(result).toContain('内容A')
    expect(result).toContain('内容C')
    expect(result).not.toContain('内容B')
  })

  it('存在しないセクションにはコメントを出力する', () => {
    const md = '## Existing\ncontent'
    const result = extractSections(md, ['Missing'])
    expect(result).toContain('<!-- セクション "Missing" が見つかりませんでした -->')
  })
})

// --- exportRecipe のテスト ---

describe('exportRecipe', () => {
  it('source_docs からコンテンツを解決してレシピを出力する', async () => {
    // 設計文書を作成
    await writeFile(join(docsDir, 'BasicDesign.md'), [
      '# 基本設計',
      '## 1. 概要',
      'システムの概要説明。',
      '## 2. アーキテクチャ',
      '### 2.1 構成図',
      '```',
      'Client → Server → DB',
      '```',
      '## 3. その他',
      '省略。',
    ].join('\n'))

    const input: ExportRecipeInput = {
      project: 'TestProject',
      tech_stack: { language: 'TypeScript', runtime: 'Node.js' },
      docs_dir: docsDir,
      output_path: join(tmpDir, 'recipe.json'),
      chunks: [
        {
          id: 'chunk-01',
          name: 'アーキテクチャ実装',
          description: 'サーバー構成の実装',
          depends_on: [],
          source_docs: [
            { path: 'BasicDesign.md', sections: ['2. アーキテクチャ'], include: 'partial' },
          ],
          implementation_prompt_template: '以下の設計に基づいて実装:\n\n{source_content}',
          expected_outputs: ['src/server.ts'],
          completion_criteria: ['サーバーが起動する'],
          estimated_input_tokens: 1000,
          estimated_output_tokens: 2000,
        },
      ],
    }

    const result = await exportRecipe(input)

    expect(result.total_chunks).toBe(1)
    expect(result.execution_order).toEqual([['chunk-01']])
    expect(result.warnings).toHaveLength(0)

    // 出力された recipe.json を検証
    const recipeRaw = await readFile(result.recipe_path, 'utf-8')
    const recipe: Recipe = JSON.parse(recipeRaw)

    expect(recipe.project).toBe('TestProject')
    expect(recipe.builder_version).toBe('0.1.0')
    expect(recipe.chunks).toHaveLength(1)

    const chunk = recipe.chunks[0]
    // source_content にセクション内容が埋め込まれている
    expect(chunk.source_content).toContain('## 2. アーキテクチャ')
    expect(chunk.source_content).toContain('Client → Server → DB')
    expect(chunk.source_content).not.toContain('## 3. その他')

    // implementation_prompt に source_content が展開されている
    expect(chunk.implementation_prompt).toContain('以下の設計に基づいて実装')
    expect(chunk.implementation_prompt).toContain('Client → Server → DB')
  })

  it('full include は文書全体を埋め込む', async () => {
    const fullContent = '# Full Doc\n全文を含める。\n## Detail\n詳細。'
    await writeFile(join(docsDir, 'spec.md'), fullContent)

    const input: ExportRecipeInput = {
      project: 'Test',
      tech_stack: { language: 'TypeScript' },
      docs_dir: docsDir,
      output_path: join(tmpDir, 'recipe.json'),
      chunks: [
        {
          id: 'chunk-01',
          name: 'テスト',
          description: 'テスト',
          depends_on: [],
          source_docs: [
            { path: 'spec.md', sections: ['全体'], include: 'full' },
          ],
          implementation_prompt_template: '{source_content}',
          expected_outputs: [],
          completion_criteria: [],
          estimated_input_tokens: 500,
          estimated_output_tokens: 500,
        },
      ],
    }

    const result = await exportRecipe(input)
    const recipe: Recipe = JSON.parse(await readFile(result.recipe_path, 'utf-8'))

    expect(recipe.chunks[0].source_content).toContain('# Full Doc')
    expect(recipe.chunks[0].source_content).toContain('詳細。')
  })

  it('存在しない文書は警告を出す', async () => {
    const input: ExportRecipeInput = {
      project: 'Test',
      tech_stack: { language: 'TypeScript' },
      docs_dir: docsDir,
      output_path: join(tmpDir, 'recipe.json'),
      chunks: [
        {
          id: 'chunk-01',
          name: 'テスト',
          description: 'テスト',
          depends_on: [],
          source_docs: [
            { path: 'nonexistent.md', sections: ['概要'], include: 'partial' },
          ],
          implementation_prompt_template: '{source_content}',
          expected_outputs: [],
          completion_criteria: [],
          estimated_input_tokens: 500,
          estimated_output_tokens: 500,
        },
      ],
    }

    const result = await exportRecipe(input)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('nonexistent.md')
  })

  it('依存関係から execution_order を正しく算出する', async () => {
    await writeFile(join(docsDir, 'a.md'), '# A')
    await writeFile(join(docsDir, 'b.md'), '# B')

    const input: ExportRecipeInput = {
      project: 'Test',
      tech_stack: { language: 'TypeScript' },
      docs_dir: docsDir,
      output_path: join(tmpDir, 'recipe.json'),
      chunks: [
        {
          id: 'chunk-01',
          name: 'ベース',
          description: 'ベースモジュール',
          depends_on: [],
          source_docs: [{ path: 'a.md', sections: ['全体'], include: 'full' }],
          implementation_prompt_template: '{source_content}',
          expected_outputs: [],
          completion_criteria: [],
          estimated_input_tokens: 500,
          estimated_output_tokens: 500,
        },
        {
          id: 'chunk-02',
          name: '応用A',
          description: 'ベースに依存',
          depends_on: ['chunk-01'],
          source_docs: [{ path: 'b.md', sections: ['全体'], include: 'full' }],
          implementation_prompt_template: '{source_content}',
          expected_outputs: [],
          completion_criteria: [],
          estimated_input_tokens: 500,
          estimated_output_tokens: 500,
        },
        {
          id: 'chunk-03',
          name: '応用B',
          description: 'ベースに依存',
          depends_on: ['chunk-01'],
          source_docs: [{ path: 'a.md', sections: ['全体'], include: 'full' }],
          implementation_prompt_template: '{source_content}',
          expected_outputs: [],
          completion_criteria: [],
          estimated_input_tokens: 500,
          estimated_output_tokens: 500,
        },
      ],
    }

    const result = await exportRecipe(input)
    expect(result.execution_order).toEqual([
      ['chunk-01'],
      ['chunk-02', 'chunk-03'],
    ])
  })

  it('{{file:path}} プレースホルダは解決せずに残す', async () => {
    await writeFile(join(docsDir, 'design.md'), '# Design\n設計内容。')

    const input: ExportRecipeInput = {
      project: 'Test',
      tech_stack: { language: 'TypeScript' },
      docs_dir: docsDir,
      output_path: join(tmpDir, 'recipe.json'),
      chunks: [
        {
          id: 'chunk-01',
          name: 'テスト',
          description: 'テスト',
          depends_on: [],
          source_docs: [{ path: 'design.md', sections: ['全体'], include: 'full' }],
          implementation_prompt_template: '{source_content}\n\n依存コード:\n{{file:src/db/connection.ts}}',
          expected_outputs: [],
          completion_criteria: [],
          estimated_input_tokens: 500,
          estimated_output_tokens: 500,
        },
      ],
    }

    const result = await exportRecipe(input)
    const recipe: Recipe = JSON.parse(await readFile(result.recipe_path, 'utf-8'))

    // {{file:}} は実行時に next_chunks が解決するので、ここでは残す
    expect(recipe.chunks[0].implementation_prompt).toContain('{{file:src/db/connection.ts}}')
  })

  it('include_source_content=false では参照のみ出力する', async () => {
    await writeFile(join(docsDir, 'big.md'), '# Big\n' + 'x'.repeat(10000))

    const input: ExportRecipeInput = {
      project: 'Test',
      tech_stack: { language: 'TypeScript' },
      docs_dir: docsDir,
      output_path: join(tmpDir, 'recipe.json'),
      include_source_content: false,
      chunks: [
        {
          id: 'chunk-01',
          name: 'テスト',
          description: 'テスト',
          depends_on: [],
          source_docs: [{ path: 'big.md', sections: ['概要'], include: 'partial' }],
          implementation_prompt_template: '{source_content}',
          expected_outputs: [],
          completion_criteria: [],
          estimated_input_tokens: 500,
          estimated_output_tokens: 500,
        },
      ],
    }

    const result = await exportRecipe(input)
    const recipe: Recipe = JSON.parse(await readFile(result.recipe_path, 'utf-8'))

    expect(recipe.chunks[0].source_content).toContain('（参照: big.md')
    expect(recipe.chunks[0].source_content).not.toContain('x'.repeat(100))
  })
})
