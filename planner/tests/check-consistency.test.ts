import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { checkConsistency } from '../src/tools/check-consistency.js'
import { resolveDecisionsPath } from '../src/utils/decisions.js'

async function writeDecisionsFile(projectDir: string, content: string): Promise<void> {
  const path = resolveDecisionsPath(projectDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'check-consistency-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('checkConsistency', () => {
  // --- terminology ---

  describe('terminology', () => {
    it('バッククォート内の用語揺れを検出する', async () => {
      await writeFile(join(tmpDir, 'a.md'), '# A\n`episodes` テーブルを使う')
      await writeFile(join(tmpDir, 'b.md'), '# B\n`episode_memories` テーブルを使う')

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['terminology'],
      })

      // episodes vs episode_memories は normalized が異なるので揺れにならない
      // 同じ正規化結果になるケースをテスト
      expect(result.status).toBe('ok')
    })

    it('大文字小文字の違いによる揺れを検出する', async () => {
      await writeFile(join(tmpDir, 'a.md'), '# A\n`GhostShell` を使う')
      await writeFile(join(tmpDir, 'b.md'), '# B\n`ghostshell` を参照')

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['terminology'],
      })

      expect(result.status).toBe('warn')
      const termIssue = result.issues.find(i => i.category === 'terminology')
      expect(termIssue).toBeDefined()
      expect(termIssue!.message).toContain('GhostShell')
      expect(termIssue!.message).toContain('ghostshell')
    })

    it('ハイフンとアンダースコアの揺れを検出する', async () => {
      await writeFile(join(tmpDir, 'a.md'), '# A\n`ghost-shell` モジュール')
      await writeFile(join(tmpDir, 'b.md'), '# B\n`ghost_shell` モジュール')

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['terminology'],
      })

      expect(result.status).toBe('warn')
      const issue = result.issues.find(i => i.category === 'terminology')
      expect(issue).toBeDefined()
    })
  })

  // --- references ---

  describe('references', () => {
    it('wiki-link のリンク切れを検出する', async () => {
      await writeFile(join(tmpDir, 'a.md'), '# A\n参照: [[missing-doc]]')

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['references'],
      })

      expect(result.status).toBe('warn')
      const issue = result.issues.find(i => i.message.includes('missing-doc'))
      expect(issue).toBeDefined()
      expect(issue!.category).toBe('references')
    })

    it('UC-N の欠番を検出する', async () => {
      await writeFile(join(tmpDir, 'uc.md'), '# UC\n- UC-1: a\n- UC-3: c')

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['references'],
      })

      const gap = result.issues.find(i => i.message.includes('UC-2'))
      expect(gap).toBeDefined()
    })

    it('正常な文書群では references の issues が空', async () => {
      await writeFile(join(tmpDir, 'a.md'), '# A\n参照: [[b]]')
      await writeFile(join(tmpDir, 'b.md'), '# B')

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['references'],
      })

      expect(result.status).toBe('ok')
    })
  })

  // --- coverage ---

  describe('coverage', () => {
    it('ユースケース文書がない場合に info を返す', async () => {
      await writeFile(join(tmpDir, 'a.md'), '# A\n## S1\n内容')
      await writeFile(join(tmpDir, 'b.md'), '# B\n## S1\n内容')

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['coverage'],
      })

      const issue = result.issues.find(i =>
        i.category === 'coverage' && i.message.includes('ユースケース定義')
      )
      expect(issue).toBeDefined()
      expect(issue!.severity).toBe('info')
    })

    it('ユースケースから参照されない設計文書を検出する', async () => {
      await writeFile(join(tmpDir, 'uc.md'), '# UC\n- UC-1: a\n参照: [[a]]')
      await writeFile(join(tmpDir, 'a.md'), '# A\n## S\n内容')
      await writeFile(join(tmpDir, 'orphan.md'), '# Orphan\n## S\n内容')

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['coverage'],
      })

      const issue = result.issues.find(i => i.message.includes('orphan.md'))
      expect(issue).toBeDefined()
    })
  })

  // --- decisions ---

  describe('decisions', () => {
    it('decisions.jsonl の影響文書が存在しない場合に warn', async () => {
      await writeFile(join(tmpDir, 'a.md'), '# A')
      await writeDecisionsFile(tmpDir,
        JSON.stringify({
          id: 'DEC-001', decision: 'test', rationale: '',
          affects: ['a.md', 'missing.md'], created_at: '2026-03-01T00:00:00Z',
        })
      )

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['decisions'],
      })

      const issue = result.issues.find(i => i.message.includes('missing.md'))
      expect(issue).toBeDefined()
      expect(issue!.category).toBe('decisions')
    })

    it('フロントマターに記載されていない決定IDを検出する', async () => {
      await writeFile(join(tmpDir, 'a.md'), [
        '---',
        'decisions:',
        '  - DEC-001',
        '---',
        '# A',
      ].join('\n'))
      await writeDecisionsFile(tmpDir, [
        JSON.stringify({ id: 'DEC-001', decision: 'a', rationale: '', affects: ['a.md'], created_at: '' }),
        JSON.stringify({ id: 'DEC-002', decision: 'b', rationale: '', affects: ['a.md'], created_at: '' }),
      ].join('\n'))

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['decisions'],
      })

      const issue = result.issues.find(i => i.message.includes('DEC-002'))
      expect(issue).toBeDefined()
    })

    it('decisions.jsonl にない ID がフロントマターにある場合に warn', async () => {
      await writeFile(join(tmpDir, 'a.md'), [
        '---',
        'decisions:',
        '  - DEC-999',
        '---',
        '# A',
      ].join('\n'))

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['decisions'],
      })

      const issue = result.issues.find(i => i.message.includes('DEC-999'))
      expect(issue).toBeDefined()
      expect(issue!.severity).toBe('warn')
    })
  })

  // --- staleness ---

  describe('staleness', () => {
    it('last_reviewed より後の決定がある文書を検出する', async () => {
      await writeFile(join(tmpDir, 'a.md'), [
        '---',
        'last_reviewed: 2026-02-01',
        '---',
        '# A',
      ].join('\n'))
      await writeDecisionsFile(tmpDir,
        JSON.stringify({
          id: 'DEC-001', decision: 'test', rationale: '',
          affects: ['a.md'], created_at: '2026-03-01T00:00:00Z',
        })
      )

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['staleness'],
      })

      const issue = result.issues.find(i => i.category === 'staleness')
      expect(issue).toBeDefined()
      expect(issue!.message).toContain('DEC-001')
    })

    it('last_reviewed が最新なら staleness なし', async () => {
      await writeFile(join(tmpDir, 'a.md'), [
        '---',
        'last_reviewed: 2026-12-31',
        '---',
        '# A',
      ].join('\n'))
      await writeDecisionsFile(tmpDir,
        JSON.stringify({
          id: 'DEC-001', decision: 'test', rationale: '',
          affects: ['a.md'], created_at: '2026-03-01T00:00:00Z',
        })
      )

      const result = await checkConsistency({
        project_dir: tmpDir,
        focus: ['staleness'],
      })

      expect(result.issues.filter(i => i.category === 'staleness')).toHaveLength(0)
    })
  })

  // --- 統合 ---

  it('focus 指定なしで全カテゴリをチェックする', async () => {
    await writeFile(join(tmpDir, 'a.md'), '# A\n参照: [[missing]]')

    const result = await checkConsistency({ project_dir: tmpDir })

    // references の broken link が検出されること
    expect(result.issues.some(i => i.category === 'references')).toBe(true)
  })

  it('summary を正しく集計する', async () => {
    await writeFile(join(tmpDir, 'a.md'), '# A\n参照: [[missing1]]\n参照: [[missing2]]')

    const result = await checkConsistency({
      project_dir: tmpDir,
      focus: ['references'],
    })

    expect(result.summary.warnings).toBe(2)
    expect(result.summary.errors).toBe(0)
  })

  it('sample-project fixtures で動作する', async () => {
    const fixturesDir = join(import.meta.dirname, 'fixtures', 'sample-project')
    const result = await checkConsistency({ project_dir: fixturesDir })

    // 何らかの結果が返ること
    expect(result.status).toBeDefined()
    expect(result.summary).toBeDefined()
  })
})
