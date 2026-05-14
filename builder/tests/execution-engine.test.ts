import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadRecipe } from '../src/execution-engine/load-recipe.js'
import { nextChunks, resolveChunkPrompt } from '../src/execution-engine/next-chunks.js'
import { completeChunk } from '../src/execution-engine/complete-chunk.js'
import { executionStatus } from '../src/execution-engine/execution-status.js'
import type { Recipe, Chunk } from '../src/types.js'

const exec = promisify(execFile)

// テスト用のミニレシピ
function createTestRecipe(overrides?: Partial<Recipe>): Recipe {
  return {
    project: 'test-project',
    created_at: '2026-03-03T00:00:00Z',
    builder_version: '0.1.0',
    tech_stack: {
      language: 'TypeScript',
      runtime: 'Node.js',
      test: 'vitest',
    },
    coding_standards: null,
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
        reference_doc: 'docs/4-ref/chunk-01-db-schema.md',
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
        reference_doc: 'docs/4-ref/chunk-02-api.md',
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
        reference_doc: 'docs/4-ref/chunk-03-cli.md',
        estimated_input_tokens: 600,
        estimated_output_tokens: 400,
      },
    ],
    execution_order: [['chunk-01'], ['chunk-02', 'chunk-03']],
    ...overrides,
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
    expect(result.total_ready).toBe(1)
    expect(result.ready[0].id).toBe('chunk-01')
    expect(result.ready[0].implementation_prompt).toContain('CREATE TABLE users')
    expect(result.blocked).toContain('chunk-02')
    expect(result.blocked).toContain('chunk-03')
    expect(result.progress).toBe('0/3 完了')
  })

  it('chunk-01 完了後: デフォルト(limit=1)では 1 件のみ返し total_ready=2 になる', async () => {
    await loadRecipe(recipePath)

    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users (id INTEGER PRIMARY KEY);')
    await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    const result = await nextChunks(statePath)

    expect(result.ready).toHaveLength(1)
    expect(result.total_ready).toBe(2)
    expect(result.done).toContain('chunk-01')
    expect(result.progress).toBe('1/3 完了')
  })

  it('chunk-01 完了後: limit=2 を指定すると chunk-02, chunk-03 が両方返る', async () => {
    await loadRecipe(recipePath)

    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users (id INTEGER PRIMARY KEY);')
    await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    const result = await nextChunks(statePath, 2)

    expect(result.ready).toHaveLength(2)
    expect(result.total_ready).toBe(2)
    const readyIds = result.ready.map(c => c.id).sort()
    expect(readyIds).toEqual(['chunk-02', 'chunk-03'])
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

describe('complete_chunk の規約適合性検証', () => {
  it('coding_standards.scripts.lint が pass すれば done になる', async () => {
    const recipe = createTestRecipe({
      coding_standards: {
        docs: ['AGENTS.md'],
        linters: [],
        scripts: { lint: 'true' },  // 常に成功
      },
    })
    await writeFile(recipePath, JSON.stringify(recipe, null, 2))
    await loadRecipe(recipePath)

    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users;')

    const result = await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    expect(result.status).toBe('done')
    expect(result.verification.lint_passed).toBe(true)
  })

  it('coding_standards.scripts.lint が fail すれば failed になる', async () => {
    const recipe = createTestRecipe({
      coding_standards: {
        docs: [],
        linters: [],
        scripts: { lint: 'false' },  // 常に失敗
      },
    })
    await writeFile(recipePath, JSON.stringify(recipe, null, 2))
    await loadRecipe(recipePath)

    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users;')

    const result = await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    expect(result.status).toBe('failed')
    expect(result.verification.lint_passed).toBe(false)
    expect(result.verification.lint_errors).toBeDefined()
  })

  it('coding_standards.scripts.format も同様に検証される', async () => {
    const recipe = createTestRecipe({
      coding_standards: {
        docs: [],
        linters: [],
        scripts: { format: 'false' },
      },
    })
    await writeFile(recipePath, JSON.stringify(recipe, null, 2))
    await loadRecipe(recipePath)

    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users;')

    const result = await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    expect(result.status).toBe('failed')
    expect(result.verification.format_passed).toBe(false)
  })

  it('coding_standards が null なら規約適合性の検証はスキップする', async () => {
    // デフォルトの recipe は coding_standards: null
    await loadRecipe(recipePath)

    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users;')

    const result = await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    expect(result.status).toBe('done')
    expect(result.verification.lint_passed).toBeUndefined()
    expect(result.verification.format_passed).toBeUndefined()
  })

  it('lint も format も定義されていなければ verification には現れない', async () => {
    const recipe = createTestRecipe({
      coding_standards: {
        docs: ['AGENTS.md'],
        linters: [],
        scripts: {},  // lint も format もなし
      },
    })
    await writeFile(recipePath, JSON.stringify(recipe, null, 2))
    await loadRecipe(recipePath)

    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users;')

    const result = await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    expect(result.status).toBe('done')
    expect(result.verification.lint_passed).toBeUndefined()
  })
})

describe('coding_standards_digest の注入', () => {
  it('coding_standards が null のとき言語慣例フォールバックをプロンプトに付加する', async () => {
    await loadRecipe(recipePath)
    const result = await nextChunks(statePath)
    const chunk = result.ready[0]
    expect(chunk.implementation_prompt).toContain('コード規約')
    expect(chunk.implementation_prompt).toContain('TypeScript')
    expect(chunk.coding_standards_digest).toBeTruthy()
  })

  it('coding_standards が設定されているとき規約ファイル名とスクリプトをプロンプトに付加する', async () => {
    const recipeWithStandards = createTestRecipe({
      coding_standards: {
        docs: ['AGENTS.md'],
        linters: ['.editorconfig', 'eslint.config.js'],
        scripts: { lint: 'npm run lint', format: 'npm run format' },
      },
    })
    await writeFile(recipePath, JSON.stringify(recipeWithStandards, null, 2))
    await loadRecipe(recipePath)

    const result = await nextChunks(statePath)
    const chunk = result.ready[0]
    expect(chunk.implementation_prompt).toContain('AGENTS.md')
    expect(chunk.implementation_prompt).toContain('npm run lint')
    expect(chunk.coding_standards_digest).toContain('AGENTS.md')
  })

  it('coding_standards に test スクリプトしかない場合は言語慣例フォールバックする', async () => {
    // docs/linters/lint/format が全て空で test だけある = 実質的に規約情報なし
    const recipe = createTestRecipe({
      coding_standards: {
        docs: [],
        linters: [],
        scripts: { test: 'vitest run' },
      },
    })
    await writeFile(recipePath, JSON.stringify(recipe, null, 2))
    await loadRecipe(recipePath)

    const result = await nextChunks(statePath)
    const chunk = result.ready[0]
    // ヘッダーだけで中身が空にならず、言語慣例フォールバックが入る
    expect(chunk.coding_standards_digest).toContain('TypeScript')
    expect(chunk.coding_standards_digest!.split('\n').length).toBeGreaterThan(1)
  })

  it('coding_standards_digest が PreparedChunk フィールドに格納される', async () => {
    await loadRecipe(recipePath)
    const result = await nextChunks(statePath)
    expect(result.ready[0].coding_standards_digest).toBeDefined()
    expect(typeof result.ready[0].coding_standards_digest).toBe('string')
  })
})

describe('resolveChunkPrompt（実行時のプレースホルダ解決 / Issue #31）', () => {
  function makeChunk(overrides?: Partial<Chunk>): Chunk {
    return {
      id: 'chunk-01',
      name: 'テスト',
      description: 'テスト',
      depends_on: [],
      source_docs: [],
      source_content: '## 設計\nCREATE TABLE users (id INTEGER);',
      implementation_prompt: '以下を実装:\n\n{source_content}',
      expected_outputs: [],
      completion_criteria: [],
      test_requirements: { interface_tests: [], boundary_tests: [], integration_refs: [] },
      reference_doc: 'docs/4-ref/chunk-01-ref.md',
      estimated_input_tokens: 500,
      estimated_output_tokens: 500,
      is_integration_test: false,
      ...overrides,
    }
  }

  it('未解決テンプレートの {source_content} を source_content で置換する', async () => {
    const chunk = makeChunk()
    const prompt = await resolveChunkPrompt(chunk, tmpDir, 'DIGEST')

    expect(prompt).toContain('以下を実装:')
    expect(prompt).toContain('CREATE TABLE users (id INTEGER);')
    expect(prompt).not.toContain('{source_content}')
  })

  it('source_content 内の {{file:path}} を実ファイル内容で解決する', async () => {
    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/dep.ts'), 'export const dep = 1;')
    const chunk = makeChunk({
      source_content: '依存コード:\n{{file:src/dep.ts}}',
    })

    const prompt = await resolveChunkPrompt(chunk, tmpDir, 'DIGEST')

    expect(prompt).toContain('export const dep = 1;')
    expect(prompt).not.toContain('{{file:')
  })

  it('コード規約ダイジェストを末尾に注入する', async () => {
    const prompt = await resolveChunkPrompt(makeChunk(), tmpDir, 'DIGEST-本文')
    expect(prompt.endsWith('DIGEST-本文')).toBe(true)
  })

  it('統合テストチャンクにはダイジェストを注入しない', async () => {
    const chunk = makeChunk({ is_integration_test: true })
    const prompt = await resolveChunkPrompt(chunk, tmpDir, 'DIGEST-本文')
    expect(prompt).not.toContain('DIGEST-本文')
  })

  it('解決済みの旧レシピを渡しても no-op で壊れない（後方互換）', async () => {
    // export 時に resolve 済み = {source_content} プレースホルダが残っていない
    const chunk = makeChunk({
      implementation_prompt: '以下を実装:\n\n## 設計\nCREATE TABLE users (id INTEGER);',
      source_content: '## 設計\nCREATE TABLE users (id INTEGER);',
    })
    const prompt = await resolveChunkPrompt(chunk, tmpDir, 'DIGEST')

    expect(prompt).toContain('CREATE TABLE users (id INTEGER);')
    expect(prompt).not.toContain('{source_content}')
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

describe('complete_chunk の commit_hint', () => {
  async function git(...args: string[]) {
    return exec('git', args, { cwd: tmpDir })
  }

  it('git リポジトリでなければ commit_hint は null（成功時）', async () => {
    await loadRecipe(recipePath)
    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users;')

    const result = await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    expect(result.status).toBe('done')
    expect(result.commit_hint).toBeNull()
  })

  it('成功 + 未コミット変更があれば chunk_completed の commit_hint を返す', async () => {
    await git('init')
    await git('config', 'user.email', 'test@test.com')
    await git('config', 'user.name', 'Test')
    // recipe.json と state.json を初期コミット（後の chunk 成果物だけが未コミットになるように）
    await git('add', '.')
    await git('commit', '-m', 'init')

    await loadRecipe(recipePath)
    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/schema.sql'), 'CREATE TABLE users;')

    const result = await completeChunk(statePath, 'chunk-01', ['src/schema.sql'])

    expect(result.status).toBe('done')
    expect(result.commit_hint).not.toBeNull()
    expect(result.commit_hint!.reason).toBe('chunk_completed')
    expect(result.commit_hint!.suggested_message).toContain('chunk-01')
    expect(result.commit_hint!.suggested_message).toContain('DB スキーマ')
    expect(result.commit_hint!.uncommitted_files).toBeGreaterThan(0)
    expect(result.commit_hint!.changed_paths.some(p => p.includes('schema.sql'))).toBe(true)
  })

  it('失敗時は commit_hint を null にする（再試行サイクルなのでコミット候補にしない）', async () => {
    await git('init')
    await git('config', 'user.email', 'test@test.com')
    await git('config', 'user.name', 'Test')
    await git('add', '.')
    await git('commit', '-m', 'init')

    await loadRecipe(recipePath)
    // 期待ファイルを作らずに完了申告 → failed
    const result = await completeChunk(statePath, 'chunk-01', [])

    expect(result.status).toBe('failed')
    expect(result.commit_hint).toBeNull()
  })
})
