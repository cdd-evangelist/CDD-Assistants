import { describe, it, expect, vi } from 'vitest'
import { ClaudeCodeExecutor, buildTestAgentPrompt, buildImplAgentPrompt } from '../src/adapters/claude-code.js'
import type { PreparedChunk } from '../src/types.js'

// claude CLI のモック
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
    if (cb) cb(null, { stdout: 'done', stderr: '' })
    return { stdout: 'done', stderr: '' }
  }),
}))

vi.mock('node:util', async () => {
  const actual = await vi.importActual('node:util')
  return {
    ...actual,
    promisify: () => vi.fn().mockResolvedValue({ stdout: 'done', stderr: '' }),
  }
})

function createTestChunk(overrides: Partial<PreparedChunk> = {}): PreparedChunk {
  return {
    id: 'chunk-01',
    name: 'テストチャンク',
    implementation_prompt: 'テスト用のファイルを作成してください',
    expected_outputs: ['src/test.ts', 'tests/test.test.ts'],
    completion_criteria: ['ファイルが作成される'],
    test_requirements: {
      interface_tests: ['公開 API が期待通りに動作する'],
      boundary_tests: ['入力が空のとき例外を返す'],
      integration_refs: [],
    },
    reference_doc: 'docs/ref/chunk-01-test.md',
    working_dir: '/tmp/test-project',
    is_integration_test: false,
    ...overrides,
  }
}

describe('ClaudeCodeExecutor', () => {
  it('デフォルト設定で生成できる', () => {
    const executor = new ClaudeCodeExecutor()
    expect(executor).toBeDefined()
  })

  it('カスタム設定で生成できる', () => {
    const executor = new ClaudeCodeExecutor({ model: 'haiku', timeout: 60000 })
    expect(executor).toBeDefined()
  })

  it('ChunkExecutor インターフェースを満たす（generateTests / implement / investigate）', () => {
    const executor = new ClaudeCodeExecutor()
    expect(typeof executor.generateTests).toBe('function')
    expect(typeof executor.implement).toBe('function')
    expect(typeof executor.investigate).toBe('function')
  })
})

describe('buildTestAgentPrompt', () => {
  it('Test Agent プロンプトにチャンク情報が含まれる', () => {
    const chunk = createTestChunk({ name: 'DB スキーマ' })
    const prompt = buildTestAgentPrompt(chunk)

    expect(prompt).toContain('Test Agent')
    expect(prompt).toContain('chunk-01')
    expect(prompt).toContain('DB スキーマ')
    expect(prompt).toContain('テスト用のファイルを作成してください') // implementation_prompt = source_content
  })

  it('test_requirements の観点がプロンプトに含まれる', () => {
    const chunk = createTestChunk()
    const prompt = buildTestAgentPrompt(chunk)

    expect(prompt).toContain('公開 API が期待通りに動作する')
    expect(prompt).toContain('入力が空のとき例外を返す')
  })

  it('テストファイルのみが「生成すべきファイル」に含まれる', () => {
    const chunk = createTestChunk({
      expected_outputs: ['src/db.ts', 'tests/db.test.ts', 'test/schema.spec.ts'],
    })
    const prompt = buildTestAgentPrompt(chunk)

    expect(prompt).toContain('tests/db.test.ts')
    expect(prompt).toContain('test/schema.spec.ts')
    expect(prompt).not.toContain('src/db.ts') // 非テストファイルは除外
  })

  it('全テスト FAIL 指示が含まれる（Red フェーズ）', () => {
    const chunk = createTestChunk()
    const prompt = buildTestAgentPrompt(chunk)
    expect(prompt).toContain('FAIL')
  })
})

describe('buildImplAgentPrompt', () => {
  it('Impl Agent プロンプトにチャンク情報と test_code が含まれる', () => {
    const chunk = createTestChunk({ name: 'API 実装' })
    const testCode = 'describe("api", () => { it("works", ...) })'
    const prompt = buildImplAgentPrompt(chunk, testCode)

    expect(prompt).toContain('Impl Agent')
    expect(prompt).toContain('chunk-01')
    expect(prompt).toContain('API 実装')
    expect(prompt).toContain(testCode)
  })

  it('実装ファイルのみが「生成すべきファイル」に含まれる', () => {
    const chunk = createTestChunk({
      expected_outputs: ['src/db.ts', 'tests/db.test.ts'],
    })
    const prompt = buildImplAgentPrompt(chunk, '')

    expect(prompt).toContain('src/db.ts')
    expect(prompt).not.toContain('tests/db.test.ts') // テストは除外
  })

  it('coding_standards_digest がある場合プロンプトに含まれる', () => {
    const chunk = createTestChunk({
      coding_standards_digest: '--- コード規約 ---\n- AGENTS.md に従う',
    })
    const prompt = buildImplAgentPrompt(chunk, '')
    expect(prompt).toContain('--- コード規約 ---')
  })

  it('reference_doc パスが含まれる（リファレンス生成指示）', () => {
    const chunk = createTestChunk()
    const prompt = buildImplAgentPrompt(chunk, '')
    expect(prompt).toContain('docs/ref/chunk-01-test.md')
  })
})
