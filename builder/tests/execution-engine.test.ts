import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRecipe } from '../src/execution-engine/load-recipe.js'
import { nextChunks } from '../src/execution-engine/next-chunks.js'
import { completeChunk } from '../src/execution-engine/complete-chunk.js'
import { executionStatus } from '../src/execution-engine/execution-status.js'
import type { Recipe } from '../src/types.js'

// テスト用のミニレシピ
function createTestRecipe(): Recipe {
  return {
    project: 'test-project',
    created_at: '2026-03-03T00:00:00Z',
    builder_version: '0.1.0',
    tech_stack: {
      language: 'TypeScript',
      runtime: 'Node.js',
      test: 'vitest',
    },
    chunks: [
      {
        id: 'chunk-01',
        name: 'DB スキーマ',
        description: 'テーブル作成',
        depends_on: [],
        source_docs: [{ path: 'BasicDesign.md', sections: ['§3'], include: 'partial' }],
        source_content: '## テーブル定義\nCREATE TABLE users (id INTEGER PRIMARY KEY);',
        implementation_prompt: '以下の設計に基づきスキーマを実装:\n\n{source_content}',
        expected_outputs: ['src/schema.sql'],
        completion_criteria: ['テーブルが作成される'],
        reference_doc: 'docs/ref/chunk-01-db-schema.md',
        estimated_input_tokens: 500,
        estimated_output_tokens: 300,
      },
      {
        id: 'chunk-02',
        name: 'API 層',
        description: 'REST API',
        depends_on: ['chunk-01'],
        source_docs: [{ path: 'api-spec.md', sections: ['全体'], include: 'full' }],
        source_content: '{{file:src/schema.sql}}\n\n## API 仕様\nGET /users',
        implementation_prompt: '以下の設計に基づき API を実装:\n\n{source_content}',
        expected_outputs: ['src/api.ts'],
        completion_criteria: ['GET /users が動く'],
        reference_doc: 'docs/ref/chunk-02-api.md',
        estimated_input_tokens: 800,
        estimated_output_tokens: 600,
      },
      {
        id: 'chunk-03',
        name: 'CLI',
        description: 'コマンドライン',
        depends_on: ['chunk-01'],
        source_docs: [{ path: 'cli-spec.md', sections: ['全体'], include: 'full' }],
        source_content: '## CLI 仕様\nuser list コマンド',
        implementation_prompt: '以下の設計に基づき CLI を実装:\n\n{source_content}',
        expected_outputs: ['src/cli.ts'],
        completion_criteria: ['user list が動く'],
        reference_doc: 'docs/ref/chunk-03-cli.md',
        estimated_input_tokens: 600,
        estimated_output_tokens: 400,
      },
    ],
    execution_order: [['chunk-01'], ['chunk-02', 'chunk-03']],
  }
}

let tmpDir: string
let recipePath: string
let statePath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cdd-builder-test-'))
  recipePath = join(tmpDir, 'recipe.json')
  statePath = join(tmpDir, 'recipe-state.json')
  await writeFile(recipePath, JSON.stringify(createTestRecipe(), null, 2))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('load_recipe', () => {
  it('レシピを読み込んで実行状態を初期化する', async () => {
    const result = await loadRecipe(recipePath)

    expect(result.project).toBe('test-project')
    expect(result.total_chunks).toBe(3)
    expect(result.ready_chunks).toEqual(['chunk-01'])
    expect(result.execution_state_path).toBe(statePath)

    // 状態ファイルが作成されているか
    const state = JSON.parse(await readFile(statePath, 'utf-8'))
    expect(Object.keys(state.chunks)).toHaveLength(3)
    expect(state.chunks['chunk-01'].status).toBe('pending')
  })
})

describe('next_chunks', () => {
  it('依存なしのチャンクを返す（初期状態）', async () => {
    await loadRecipe(recipePath)

    const result = await nextChunks(statePath)

    expect(result.ready).toHaveLength(1)
    expect(result.ready[0].id).toBe('chunk-01')
    expect(result.ready[0].implementation_prompt).toContain('CREATE TABLE users')
    expect(result.blocked).toContain('chunk-02')
    expect(result.blocked).toContain('chunk-03')
    expect(result.progress).toBe('0/3 完了')
  })

  it('chunk-01 完了後に chunk-02, chunk-03 がアンロックされる', async () => {
    await loadRecipe(recipePath)

    // chunk-01 のファイルを作成して完了させる
    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users (id INTEGER PRIMARY KEY);')
    await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    const result = await nextChunks(statePath)

    expect(result.ready).toHaveLength(2)
    const readyIds = result.ready.map(c => c.id).sort()
    expect(readyIds).toEqual(['chunk-02', 'chunk-03'])
    expect(result.done).toContain('chunk-01')
    expect(result.progress).toBe('1/3 完了')
  })

  it('プレースホルダが解決される', async () => {
    await loadRecipe(recipePath)

    // chunk-01 完了
    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users (id INTEGER PRIMARY KEY);')
    await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    const result = await nextChunks(statePath)
    const chunk02 = result.ready.find(c => c.id === 'chunk-02')

    // {{file:src/schema.sql}} が実際の内容に置換されている
    expect(chunk02?.implementation_prompt).toContain('CREATE TABLE users')
    expect(chunk02?.implementation_prompt).not.toContain('{{file:')
  })
})

describe('complete_chunk', () => {
  it('ファイルが存在すれば done になる', async () => {
    await loadRecipe(recipePath)

    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users;')

    const result = await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    expect(result.status).toBe('done')
    expect(result.verification.files_exist).toBe(true)
    expect(result.newly_unblocked.sort()).toEqual(['chunk-02', 'chunk-03'])
  })

  it('ファイルが不足していれば failed になる', async () => {
    await loadRecipe(recipePath)

    const result = await completeChunk(statePath, 'chunk-01', [])

    expect(result.status).toBe('failed')
    expect(result.verification.files_exist).toBe(false)
    expect(result.verification.missing_files).toContain('src/schema.sql')
  })
})

describe('execution_status', () => {
  it('初期状態の進捗を返す', async () => {
    await loadRecipe(recipePath)

    const result = await executionStatus(statePath)

    expect(result.progress.total).toBe(3)
    expect(result.progress.pending).toBe(1)    // chunk-01
    expect(result.progress.blocked).toBe(2)    // chunk-02, chunk-03
    expect(result.progress.done).toBe(0)
    expect(result.current_level).toBe(0)
    expect(result.estimated_remaining).toBe('3 chunks')
  })

  it('chunk-01 完了後の進捗', async () => {
    await loadRecipe(recipePath)

    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users;')
    await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    const result = await executionStatus(statePath)

    expect(result.progress.done).toBe(1)
    expect(result.progress.pending).toBe(2)    // chunk-02, chunk-03 がアンロック
    expect(result.progress.blocked).toBe(0)
    expect(result.current_level).toBe(1)       // Lv.0 完了
    expect(result.estimated_remaining).toBe('2 chunks')
  })
})
