import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { completeChunk } from '../../src/execution-engine/complete-chunk.js'
import type { ExecutionState, Recipe, ChunkState } from '../../src/types.js'

// rule-store と rule-extractor をモック
vi.mock('../../src/test-rules/rule-store.js', () => ({
  appendRule: vi.fn().mockResolvedValue(undefined),
  loadRules: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/test-rules/rule-extractor.js', () => ({
  matchErrorToTemplate: vi.fn(),
  instantiateRule: vi.fn(),
}))

import { appendRule } from '../../src/test-rules/rule-store.js'
import { matchErrorToTemplate, instantiateRule } from '../../src/test-rules/rule-extractor.js'
const mockAppendRule = vi.mocked(appendRule)
const mockMatch = vi.mocked(matchErrorToTemplate)
const mockInstantiate = vi.mocked(instantiateRule)

let tmpDir: string

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    project: 'test',
    created_at: '2026-01-01T00:00:00Z',
    builder_version: '0.1.0',
    tech_stack: { language: 'TypeScript', test: 'vitest' },
    coding_standards: null,
    execution_order: [['chunk-01']],
    chunks: [{
      id: 'chunk-01',
      name: 'テスト',
      description: '',
      depends_on: [],
      source_docs: [],
      source_content: '',
      implementation_prompt: '',
      expected_outputs: ['test.test.ts'],
      completion_criteria: [],
      test_requirements: { interface_tests: [], boundary_tests: [], integration_refs: [] },
      is_integration_test: false,
    }],
    ...overrides,
  }
}

function makeChunkState(overrides: Partial<ChunkState> = {}): ChunkState {
  return {
    status: 'in_progress',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    outputs: [],
    retry_count: 0,
    ...overrides,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'recovery-test-'))
  vi.resetAllMocks()
  mockAppendRule.mockResolvedValue(undefined)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function setupFixture(chunkState: ChunkState, recipe: Recipe = makeRecipe()) {
  const state: ExecutionState = {
    recipe_path: join(tmpDir, 'recipe.json'),
    working_dir: tmpDir,
    started_at: '2026-01-01T00:00:00Z',
    chunks: { 'chunk-01': chunkState },
  }
  const statePath = join(tmpDir, 'state.json')
  await writeFile(join(tmpDir, 'recipe.json'), JSON.stringify(recipe))
  await writeFile(statePath, JSON.stringify(state))
  // テストファイルを作成（ファイル存在確認を通過させるため）
  await mkdir(join(tmpDir, 'tests'), { recursive: true })
  await writeFile(join(tmpDir, 'test.test.ts'), '// test')
  return statePath
}

describe('ChunkState の last_error フィールド', () => {
  it('ChunkState に last_error フィールドが存在する', () => {
    const state = makeChunkState({ last_error: 'some error' })
    expect('last_error' in state).toBe(true)
    expect(state.last_error).toBe('some error')
  })

  it('チャンク失敗時に last_error に error がコピーされる', async () => {
    const statePath = await setupFixture(makeChunkState())
    // node_modules なし → テスト実行スキップ、files_exist が true なら成功するはず
    // expected_outputs に存在するファイルを用意済み

    // わざとファイルを削除して失敗させる
    await rm(join(tmpDir, 'test.test.ts'))
    await completeChunk(statePath, 'chunk-01', ['test.test.ts'])

    const savedState: ExecutionState = JSON.parse(await readFile(statePath, 'utf-8'))
    expect(savedState.chunks['chunk-01'].status).toBe('failed')
    expect(savedState.chunks['chunk-01'].last_error).toBeDefined()
    expect(savedState.chunks['chunk-01'].last_error).toContain('Missing files')
  })
})

describe('リカバリー検出', () => {
  it('retry_count > 0 かつ last_error ありで成功したときにマッチングを試みる', async () => {
    const CJS_ERROR = 'No "default" export is defined on the "web-push" mock.'
    mockMatch.mockReturnValue(null) // マッチなし

    const statePath = await setupFixture(makeChunkState({
      status: 'failed',
      retry_count: 1,
      last_error: CJS_ERROR,
      error: CJS_ERROR,
    }))

    await completeChunk(statePath, 'chunk-01', ['test.test.ts'])

    expect(mockMatch).toHaveBeenCalledWith(CJS_ERROR, 'vitest')
  })

  it('テンプレートにマッチしたときに appendRule が呼ばれる', async () => {
    const CJS_ERROR = 'No "default" export is defined on the "web-push" mock.'
    const fakeTemplate = { id: 'mock-cjs-default', framework: 'vitest', scope: 'global' as const, error_pattern: '', description: '', rule_template: '' }
    const fakeRule = { id: 'r1', template_id: 'mock-cjs-default', framework: 'vitest', rule: 'ルール', created_at: '' }
    mockMatch.mockReturnValue(fakeTemplate)
    mockInstantiate.mockReturnValue(fakeRule)

    const statePath = await setupFixture(makeChunkState({
      status: 'failed',
      retry_count: 1,
      last_error: CJS_ERROR,
      error: CJS_ERROR,
    }))

    await completeChunk(statePath, 'chunk-01', ['test.test.ts'])

    expect(mockInstantiate).toHaveBeenCalledWith(fakeTemplate, CJS_ERROR)
    expect(mockAppendRule).toHaveBeenCalledWith(fakeRule, 'global', tmpDir)
  })

  it('retry_count === 0 のときにルール蒸留が実行されない', async () => {
    const statePath = await setupFixture(makeChunkState({ retry_count: 0 }))
    await completeChunk(statePath, 'chunk-01', ['test.test.ts'])
    expect(mockMatch).not.toHaveBeenCalled()
  })

  it('last_error が undefined のときにルール蒸留が実行されない', async () => {
    const statePath = await setupFixture(makeChunkState({ retry_count: 1, last_error: undefined }))
    await completeChunk(statePath, 'chunk-01', ['test.test.ts'])
    expect(mockMatch).not.toHaveBeenCalled()
  })

  it('テンプレートマッチなしのときに appendRule が呼ばれない', async () => {
    mockMatch.mockReturnValue(null)
    const statePath = await setupFixture(makeChunkState({ retry_count: 1, last_error: 'unrelated error' }))
    await completeChunk(statePath, 'chunk-01', ['test.test.ts'])
    expect(mockAppendRule).not.toHaveBeenCalled()
  })

  it('framework が取得できないときにクラッシュしない', async () => {
    const recipe = makeRecipe({ tech_stack: { language: 'TypeScript' } }) // test なし
    const statePath = await setupFixture(makeChunkState({ retry_count: 1, last_error: 'error' }), recipe)
    await expect(completeChunk(statePath, 'chunk-01', ['test.test.ts'])).resolves.toBeDefined()
    expect(mockMatch).not.toHaveBeenCalled()
  })

  it('成功後に last_error がクリアされる', async () => {
    mockMatch.mockReturnValue(null)
    const statePath = await setupFixture(makeChunkState({ retry_count: 1, last_error: 'some error' }))
    await completeChunk(statePath, 'chunk-01', ['test.test.ts'])

    const savedState: ExecutionState = JSON.parse(await readFile(statePath, 'utf-8'))
    expect(savedState.chunks['chunk-01'].last_error).toBeUndefined()
  })
})
