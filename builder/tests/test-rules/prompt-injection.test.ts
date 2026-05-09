import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildTestAgentPrompt } from '../../src/adapters/claude-code.js'
import type { PreparedChunk } from '../../src/types.js'
import type { StoredRule } from '../../src/test-rules/templates.js'

vi.mock('../../src/test-rules/rule-store.js', () => ({
  loadRules: vi.fn(),
}))

import { loadRules } from '../../src/test-rules/rule-store.js'
const mockLoadRules = vi.mocked(loadRules)

function makeChunk(overrides: Partial<PreparedChunk> = {}): PreparedChunk {
  return {
    id: 'chunk-01',
    name: 'テストチャンク',
    implementation_prompt: '実装プロンプト',
    expected_outputs: ['src/foo.test.ts'],
    completion_criteria: ['テストが通る'],
    test_requirements: {
      interface_tests: ['インターフェーステスト'],
      boundary_tests: ['境界値テスト'],
      integration_refs: [],
    },
    working_dir: '/tmp/test-project',
    ...overrides,
  }
}

function makeRule(overrides: Partial<StoredRule> = {}): StoredRule {
  return {
    id: 'rule-1',
    template_id: 'mock-cjs-default',
    framework: 'vitest',
    rule: 'web-push を default import する場合、vi.mock は { default: {...} } でラップする',
    example_before: "vi.mock('web-push', () => ({ fn: vi.fn() }))",
    example_after: "vi.mock('web-push', () => ({ default: { fn: vi.fn() } }))",
    created_at: '2026-05-09T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('buildTestAgentPrompt', () => {
  describe('ルールあり', () => {
    it('ルールがある場合にセクションを含む文字列を返す', async () => {
      mockLoadRules.mockResolvedValue([makeRule()])

      const prompt = await buildTestAgentPrompt(makeChunk(), 'vitest', '/tmp/project')

      expect(prompt).toContain('## テストフレームワーク固有ルール (vitest)')
      expect(prompt).toContain('web-push を default import する場合')
    })

    it('example_before と example_after が含まれる', async () => {
      mockLoadRules.mockResolvedValue([makeRule()])

      const prompt = await buildTestAgentPrompt(makeChunk(), 'vitest', '/tmp/project')

      expect(prompt).toContain('Bad:')
      expect(prompt).toContain('Good:')
    })

    it('複数ルールが全て注入される', async () => {
      mockLoadRules.mockResolvedValue([
        makeRule({ id: 'r1', rule: 'ルール1' }),
        makeRule({ id: 'r2', rule: 'ルール2' }),
      ])

      const prompt = await buildTestAgentPrompt(makeChunk(), 'vitest', '/tmp/project')

      expect(prompt).toContain('ルール1')
      expect(prompt).toContain('ルール2')
    })
  })

  describe('ルールなし', () => {
    it('ルールが0件の場合はセクションが追加されない', async () => {
      mockLoadRules.mockResolvedValue([])

      const prompt = await buildTestAgentPrompt(makeChunk(), 'vitest', '/tmp/project')

      expect(prompt).not.toContain('## テストフレームワーク固有ルール')
    })

    it('framework が未指定の場合はセクションが追加されない', async () => {
      const prompt = await buildTestAgentPrompt(makeChunk())

      expect(prompt).not.toContain('## テストフレームワーク固有ルール')
      expect(mockLoadRules).not.toHaveBeenCalled()
    })
  })

  describe('境界値', () => {
    it('tech_stack.test が undefined / null でもエラーにならない', async () => {
      await expect(buildTestAgentPrompt(makeChunk(), undefined, undefined)).resolves.toBeDefined()
      await expect(buildTestAgentPrompt(makeChunk(), '', '/tmp')).resolves.toBeDefined()
    })

    it('example_before / example_after が undefined のルールでも正しくフォーマットされる', async () => {
      mockLoadRules.mockResolvedValue([makeRule({ example_before: undefined, example_after: undefined })])

      const prompt = await buildTestAgentPrompt(makeChunk(), 'vitest', '/tmp/project')

      expect(prompt).toContain('## テストフレームワーク固有ルール (vitest)')
      expect(prompt).not.toContain('Bad:')
      expect(prompt).not.toContain('Good:')
    })

    it('loadRules がエラーを投げた場合でも呼び出し自体は失敗する（catch なし）', async () => {
      mockLoadRules.mockRejectedValue(new Error('load error'))

      await expect(buildTestAgentPrompt(makeChunk(), 'vitest', '/tmp/project'))
        .rejects.toThrow('load error')
    })
  })
})
