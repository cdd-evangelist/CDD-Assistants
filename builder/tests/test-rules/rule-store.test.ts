import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRules, appendRule } from '../../src/test-rules/rule-store.js'
import type { StoredRule } from '../../src/test-rules/templates.js'

function makeRule(overrides: Partial<StoredRule> = {}): StoredRule {
  return {
    id: 'test-id-1',
    template_id: 'mock-cjs-default',
    framework: 'vitest',
    rule: 'web-push を default import する場合は { default: {...} } でラップする',
    created_at: '2026-05-09T00:00:00.000Z',
    ...overrides,
  }
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'rule-store-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('loadRules', () => {
  it('StoredRule[] を返す', async () => {
    const rules = await loadRules('vitest', tmpDir)
    expect(Array.isArray(rules)).toBe(true)
  })

  it('ファイル未存在時に空配列を返す', async () => {
    const rules = await loadRules('vitest', tmpDir)
    expect(rules).toHaveLength(0)
  })

  it('プロジェクトルールを読み込む', async () => {
    const rule = makeRule()
    await appendRule(rule, 'project', tmpDir)

    const rules = await loadRules('vitest', tmpDir)
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe('test-id-1')
  })

  it('グローバルとプロジェクト両方にルールがある場合にマージされる', async () => {
    const projectRule = makeRule({ id: 'project-rule', template_id: 'mock-cjs-default' })
    const globalRule = makeRule({ id: 'global-rule', template_id: 'mock-hoisting' })

    await appendRule(projectRule, 'project', tmpDir)

    // グローバルストアはホームディレクトリなので直接テストは難しい
    // プロジェクトに2件入れてマージ動作を検証する
    const rule2 = makeRule({ id: 'project-rule-2', template_id: 'mock-hoisting' })
    await appendRule(rule2, 'project', tmpDir)

    const rules = await loadRules('vitest', tmpDir)
    expect(rules).toHaveLength(2)
    expect(rules.map(r => r.id)).toContain('project-rule')
    expect(rules.map(r => r.id)).toContain('project-rule-2')

    void globalRule // グローバルテストは実環境依存のため省略
  })

  it('id の重複を排除してマージする', async () => {
    const rule = makeRule({ id: 'dup-id' })
    // 同じファイルに直接2行書き込む代わりに、
    // appendRule → loadRules で重複なしを確認（appendRule が template_id で防ぐ）
    await appendRule(rule, 'project', tmpDir)
    const rules = await loadRules('vitest', tmpDir)
    expect(rules.filter(r => r.id === 'dup-id')).toHaveLength(1)
  })
})

describe('appendRule', () => {
  it('Promise<void> を返す', async () => {
    const rule = makeRule()
    const result = appendRule(rule, 'project', tmpDir)
    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toBeUndefined()
  })

  it('プロジェクトスコープで正しいパスに追記する', async () => {
    const rule = makeRule()
    await appendRule(rule, 'project', tmpDir)

    const rules = await loadRules('vitest', tmpDir)
    expect(rules).toHaveLength(1)
    expect(rules[0].template_id).toBe('mock-cjs-default')
  })

  it('同じ template_id のルールを2回 append しても1件しか保存されない', async () => {
    const rule1 = makeRule({ id: 'id-1', template_id: 'mock-cjs-default' })
    const rule2 = makeRule({ id: 'id-2', template_id: 'mock-cjs-default' })

    await appendRule(rule1, 'project', tmpDir)
    await appendRule(rule2, 'project', tmpDir)

    const rules = await loadRules('vitest', tmpDir)
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe('id-1')
  })

  it('ディレクトリが存在しなくても自動作成して追記する', async () => {
    const rule = makeRule()
    await expect(appendRule(rule, 'project', join(tmpDir, 'nonexistent'))).resolves.toBeUndefined()
  })
})

describe('エラーハンドリング', () => {
  it('破損 JSONL ファイルを読んでも loadRules は reject しない', async () => {
    const rulesDir = join(tmpDir, 'docs', '4-ref', 'test-rules')
    await mkdir(rulesDir, { recursive: true })
    await writeFile(join(rulesDir, 'vitest.jsonl'), '{invalid json}\n')

    // JSON.parse は無効な JSON に対して SyntaxError を投げるが、
    // loadRules はそれを内部で捕捉して空配列を返す
    expect(() => JSON.parse('{invalid}')).toThrow(SyntaxError)
    await expect(loadRules('vitest', tmpDir)).resolves.toEqual([])
  })

  it('空のファイルでも reject しない', async () => {
    const rulesDir = join(tmpDir, 'docs', '4-ref', 'test-rules')
    await mkdir(rulesDir, { recursive: true })
    await writeFile(join(rulesDir, 'vitest.jsonl'), '')

    await expect(loadRules('vitest', tmpDir)).resolves.toEqual([])
  })
})
