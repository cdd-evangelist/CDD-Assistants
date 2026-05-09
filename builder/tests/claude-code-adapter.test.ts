import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { ClaudeCodeExecutor, buildTestAgentPrompt, buildImplAgentPrompt } from '../src/adapters/claude-code.js'
import type { PreparedChunk } from '../src/types.js'
import { readdir, stat } from 'node:fs/promises'

// 偽 ChildProcess を組み立てるヘルパー: stdout に dataBytes を流し、close(0) で終了
function makeFakeChild(stdoutData: string = '') {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (signal?: string) => boolean }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  // 同期実行内では emit が見逃されるため、queueMicrotask で次ティックに発火
  queueMicrotask(() => {
    if (stdoutData) child.stdout.emit('data', Buffer.from(stdoutData, 'utf-8'))
    child.emit('close', 0)
  })
  return child
}

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

// listFiles の readdir / stat、testCode 読み込みの readFile を空のモックで代替
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ mtimeMs: 0 }),
  readFile: vi.fn().mockResolvedValue(''),
}))

beforeEach(() => {
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => makeFakeChild('done'))
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
    reference_doc: 'docs/4-ref/chunk-01-test.md',
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
  it('Test Agent プロンプトにチャンク情報が含まれる', async () => {
    const chunk = createTestChunk({ name: 'DB スキーマ' })
    const prompt = await buildTestAgentPrompt(chunk)

    expect(prompt).toContain('Test Agent')
    expect(prompt).toContain('chunk-01')
    expect(prompt).toContain('DB スキーマ')
    expect(prompt).toContain('テスト用のファイルを作成してください') // implementation_prompt = source_content
  })

  it('test_requirements の観点がプロンプトに含まれる', async () => {
    const chunk = createTestChunk()
    const prompt = await buildTestAgentPrompt(chunk)

    expect(prompt).toContain('公開 API が期待通りに動作する')
    expect(prompt).toContain('入力が空のとき例外を返す')
  })

  it('テストファイルのみが「生成すべきファイル」に含まれる', async () => {
    const chunk = createTestChunk({
      expected_outputs: ['src/db.ts', 'tests/db.test.ts', 'test/schema.spec.ts'],
    })
    const prompt = await buildTestAgentPrompt(chunk)

    expect(prompt).toContain('tests/db.test.ts')
    expect(prompt).toContain('test/schema.spec.ts')
    expect(prompt).not.toContain('src/db.ts') // 非テストファイルは除外
  })

  it('全テスト FAIL 指示が含まれる（Red フェーズ）', async () => {
    const chunk = createTestChunk()
    const prompt = await buildTestAgentPrompt(chunk)
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
    expect(prompt).toContain('docs/4-ref/chunk-01-test.md')
  })

  it('reference_doc が undefined のときリファレンス生成指示を出さない（#18 統合テスト）', () => {
    const chunk = createTestChunk({ reference_doc: undefined })
    const prompt = buildImplAgentPrompt(chunk, '')

    expect(prompt).not.toContain('リファレンス生成指示')
    expect(prompt).not.toContain('リファレンス（日本語文書）を生成します')
    // 作業手順にもリファレンスステップを含めない
    expect(prompt).not.toContain('4. リファレンスを生成する')
  })
})

describe('runClaude の stdio 制御（#17）', () => {
  it('generateTests は spawn に stdio: ["ignore", "pipe", "pipe"] を渡して stdin を即時クローズする', async () => {
    const executor = new ClaudeCodeExecutor()
    await executor.generateTests(createTestChunk())

    expect(spawnMock).toHaveBeenCalled()
    const opts = spawnMock.mock.calls[0]![2] as { stdio?: unknown[] }
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it('implement も spawn に stdio: ["ignore", ...] を渡す', async () => {
    const executor = new ClaudeCodeExecutor()
    await executor.implement(createTestChunk(), [])

    expect(spawnMock).toHaveBeenCalled()
    const opts = spawnMock.mock.calls[0]![2] as { stdio?: unknown[] }
    expect(opts.stdio?.[0]).toBe('ignore')
  })

  it('investigate も spawn に stdio: ["ignore", ...] を渡す', async () => {
    const executor = new ClaudeCodeExecutor()
    spawnMock.mockImplementation(() =>
      makeFakeChild('{"verdict":"implementation","reasoning":"x","suggested_action":"y"}'),
    )
    await executor.investigate(
      createTestChunk(),
      { items: [] },
      { design_doc: '', implementation: [], tests: [], reference: '' },
    )

    expect(spawnMock).toHaveBeenCalled()
    const opts = spawnMock.mock.calls[0]![2] as { stdio?: unknown[] }
    expect(opts.stdio?.[0]).toBe('ignore')
  })

  it('プロンプトは -p 引数で渡す（stdin 経由ではない）', async () => {
    const executor = new ClaudeCodeExecutor()
    await executor.generateTests(createTestChunk({ name: '一意なチャンク名XYZ' }))

    expect(spawnMock).toHaveBeenCalled()
    const args = spawnMock.mock.calls[0]![1] as string[]
    const pIndex = args.indexOf('-p')
    expect(pIndex).toBeGreaterThanOrEqual(0)
    expect(args[pIndex + 1]).toContain('一意なチャンク名XYZ')
  })

  it('exit code が 0 でなければ error を返す', async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (s?: string) => boolean }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => true
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('something failed', 'utf-8'))
        child.emit('close', 1)
      })
      return child
    })

    const executor = new ClaudeCodeExecutor()
    const result = await executor.generateTests(createTestChunk())
    expect(result.success).toBe(false)
    expect(result.error).toContain('something failed')
  })
})

// エラー終了する spawn を組み立てるヘルパー
function makeErrorChild(stderrMessage: string) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (s?: string) => boolean }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  queueMicrotask(() => {
    child.stderr.emit('data', Buffer.from(stderrMessage, 'utf-8'))
    child.emit('close', 1)
  })
  return child
}

describe('エラー時の部分生成検出', () => {
  it('generateTests: エラーでも部分生成されたテストファイルを partial: true で返す', async () => {
    spawnMock.mockImplementation(() => makeErrorChild('claude exit code 1'))

    // before: 空, after: テストファイルが1件出現
    vi.mocked(readdir)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: 'auth.test.ts', isDirectory: () => false }] as any)
    vi.mocked(stat).mockResolvedValueOnce({ mtimeMs: 1000 } as any)

    const executor = new ClaudeCodeExecutor()
    const result = await executor.generateTests(createTestChunk())

    expect(result.success).toBe(false)
    expect(result.partial).toBe(true)
    expect(result.test_files).toHaveLength(1)
    expect(result.test_files[0]).toBe('auth.test.ts')
    expect(result.error).toBeDefined()
  })

  it('generateTests: エラーかつファイルも生成されなかった場合 partial は undefined', async () => {
    spawnMock.mockImplementation(() => makeErrorChild('タイムアウト'))
    // readdir はデフォルトモック（常に空）のまま

    const executor = new ClaudeCodeExecutor()
    const result = await executor.generateTests(createTestChunk())

    expect(result.success).toBe(false)
    expect(result.partial).toBeUndefined()
    expect(result.test_files).toHaveLength(0)
    expect(result.error).toBeDefined()
  })

  it('implement: エラーでも部分生成されたファイルを partial: true で返す', async () => {
    spawnMock.mockImplementation(() => makeErrorChild('claude exit code 1'))

    // before: 空, after: 実装ファイルが1件出現
    vi.mocked(readdir)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: 'auth.ts', isDirectory: () => false }] as any)
    vi.mocked(stat).mockResolvedValueOnce({ mtimeMs: 1000 } as any)

    const executor = new ClaudeCodeExecutor()
    const result = await executor.implement(createTestChunk(), [])

    expect(result.success).toBe(false)
    expect(result.partial).toBe(true)
    expect(result.generated_files).toHaveLength(1)
    expect(result.generated_files[0]).toBe('auth.ts')
    expect(result.error).toBeDefined()
  })

  it('implement: エラーかつファイルも生成されなかった場合 partial は undefined', async () => {
    spawnMock.mockImplementation(() => makeErrorChild('タイムアウト'))

    const executor = new ClaudeCodeExecutor()
    const result = await executor.implement(createTestChunk(), [])

    expect(result.success).toBe(false)
    expect(result.partial).toBeUndefined()
    expect(result.generated_files).toHaveLength(0)
    expect(result.error).toBeDefined()
  })
})
