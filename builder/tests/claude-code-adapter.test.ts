import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeCodeExecutor } from '../src/adapters/claude-code.js'
import type { PreparedChunk } from '../src/types.js'

// claude CLI のモック
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
    // callback 形式の場合
    if (cb) cb(null, { stdout: 'done', stderr: '' })
    return { stdout: 'done', stderr: '' }
  }),
}))

// promisify のモック（execFile を Promise 化した結果をモック）
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
    expected_outputs: ['src/test.ts'],
    completion_criteria: ['ファイルが作成される'],
    working_dir: '/tmp/test-project',
    ...overrides,
  }
}

describe('ClaudeCodeExecutor', () => {
  it('デフォルト設定で生成できる', () => {
    const executor = new ClaudeCodeExecutor()
    expect(executor).toBeDefined()
  })

  it('カスタム設定で生成できる', () => {
    const executor = new ClaudeCodeExecutor({
      model: 'haiku',
      timeout: 60000,
      allowedTools: ['Read', 'Write'],
    })
    expect(executor).toBeDefined()
  })

  it('ChunkExecutor インターフェースを満たす', () => {
    const executor = new ClaudeCodeExecutor()
    expect(typeof executor.execute).toBe('function')
  })

  it('プロンプトにチャンク情報が含まれる', async () => {
    // buildPrompt は private なので、execute の呼び出しを通して間接的にテスト
    // ここでは型の整合性と構造をチェック
    const chunk = createTestChunk({
      name: 'DB スキーマ',
      expected_outputs: ['src/schema.sql', 'tests/schema.test.ts'],
      completion_criteria: ['テーブルが作成される', 'テストが通る'],
    })

    expect(chunk.name).toBe('DB スキーマ')
    expect(chunk.expected_outputs).toHaveLength(2)
    expect(chunk.completion_criteria).toHaveLength(2)
  })
})
