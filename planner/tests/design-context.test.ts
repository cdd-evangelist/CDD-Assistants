import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { designContext } from '../src/tools/design-context.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'design-context-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('designContext', () => {
  it('基本的な文書スキャンができる', async () => {
    await writeFile(join(tmpDir, 'BasicDesign.md'), [
      '---',
      'status: complete',
      'layer: foundation',
      '---',
      '# 基本設計',
      '## 1. 概要',
      'TypeScript で実装する。',
    ].join('\n'))

    const result = await designContext({ project_dir: tmpDir })

    expect(result.documents).toHaveLength(1)
    expect(result.documents[0].path).toBe('BasicDesign.md')
    expect(result.documents[0].status).toBe('complete')
    expect(result.documents[0].layer).toBe('foundation')
    expect(result.documents[0].sections).toContain('1. 概要')
  })

  it('フロントマターなしの文書もステータスを推定する', async () => {
    await writeFile(join(tmpDir, 'doc.md'), [
      '# ドキュメント',
      '## セクション1',
      '内容',
      '## セクション2',
      '内容',
    ].join('\n'))

    const result = await designContext({ project_dir: tmpDir })
    expect(result.documents[0].status).toBe('complete')
  })

  it('TBD を含む文書は draft と推定する', async () => {
    await writeFile(join(tmpDir, 'doc.md'), [
      '# ドキュメント',
      '## セクション1',
      'TBD: 未定の項目',
    ].join('\n'))

    const result = await designContext({ project_dir: tmpDir })
    expect(result.documents[0].status).toBe('draft')
  })

  it('wiki-link から依存グラフを構築する', async () => {
    await writeFile(join(tmpDir, 'a.md'), '# A\n参照: [[b]]')
    await writeFile(join(tmpDir, 'b.md'), '# B\n参照: [[a]]')

    const result = await designContext({ project_dir: tmpDir })

    expect(result.dependency_graph['a.md']).toContain('b.md')
    expect(result.dependency_graph['b.md']).toContain('a.md')
  })

  it('referenced_by を正しく構築する', async () => {
    await writeFile(join(tmpDir, 'a.md'), '# A\n参照: [[b]]')
    await writeFile(join(tmpDir, 'b.md'), '# B')

    const result = await designContext({ project_dir: tmpDir })

    const docB = result.documents.find(d => d.path === 'b.md')!
    expect(docB.referenced_by).toContain('a.md')
  })

  it('overall_progress を集計する', async () => {
    await writeFile(join(tmpDir, 'a.md'), '---\nstatus: complete\n---\n# A\n## S1\n内容')
    await writeFile(join(tmpDir, 'b.md'), '---\nstatus: draft\n---\n# B')

    const result = await designContext({ project_dir: tmpDir })

    expect(result.overall_progress.complete).toBe(1)
    expect(result.overall_progress.draft).toBe(1)
    expect(result.overall_progress.total).toBe(2)
    expect(result.overall_progress.readiness).toBe('not_ready')
  })

  it('全文書 complete なら readiness は ready', async () => {
    await writeFile(join(tmpDir, 'a.md'), '---\nstatus: complete\n---\n# A\n## S1\n内容')
    await writeFile(join(tmpDir, 'b.md'), '---\nstatus: complete\n---\n# B\n## S1\n内容')

    const result = await designContext({ project_dir: tmpDir })
    expect(result.overall_progress.readiness).toBe('ready')
  })

  it('decisions.jsonl から決定事項を収集する', async () => {
    await writeFile(join(tmpDir, 'a.md'), '---\nstatus: complete\ndecisions:\n  - DEC-001\n---\n# A\n## S\n内容')
    await writeFile(join(tmpDir, 'decisions.jsonl'),
      JSON.stringify({ id: 'DEC-001', decision: 'テスト決定', rationale: '', affects: ['a.md'], created_at: '2026-03-01T00:00:00Z' })
    )

    const result = await designContext({ project_dir: tmpDir })
    expect(result.documents[0].decisions).toContain('DEC-001')
  })

  it('open_questions をフロントマターと本文から収集する', async () => {
    await writeFile(join(tmpDir, 'doc.md'), [
      '---',
      'status: draft',
      'open_questions:',
      '  - FM質問1',
      '---',
      '# Doc',
      '- [ ] 本文の未決事項',
      '- 要検討: チューニング方法',
    ].join('\n'))

    const result = await designContext({ project_dir: tmpDir })

    const questions = result.documents[0].open_questions
    expect(questions).toContain('FM質問1')
    expect(questions.some(q => q.includes('未決事項'))).toBe(true)
    expect(questions.some(q => q.includes('チューニング'))).toBe(true)
  })

  it('unresolved_questions を正しく収集する', async () => {
    await writeFile(join(tmpDir, 'doc.md'), [
      '---',
      'status: draft',
      'open_questions:',
      '  - 重要な質問',
      '---',
      '# Doc',
    ].join('\n'))

    const result = await designContext({ project_dir: tmpDir })

    expect(result.unresolved_questions).toHaveLength(1)
    expect(result.unresolved_questions[0].source).toBe('doc.md')
    expect(result.unresolved_questions[0].blocking).toBe(true)
  })

  it('sample-project fixtures で動作する', async () => {
    const fixturesDir = join(import.meta.dirname, 'fixtures', 'sample-project')
    const result = await designContext({ project_dir: fixturesDir })

    expect(result.documents.length).toBe(3)
    expect(result.overall_progress.total).toBe(3)
    expect(result.total_tokens).toBeGreaterThan(0)

    const basic = result.documents.find(d => d.path === 'BasicDesign.md')!
    expect(basic.status).toBe('complete')
    expect(basic.layer).toBe('foundation')
  })

  it('total_tokens を集計する', async () => {
    await writeFile(join(tmpDir, 'jp.md'), '日本語テスト')
    await writeFile(join(tmpDir, 'en.md'), 'English test')

    const result = await designContext({ project_dir: tmpDir })
    expect(result.total_tokens).toBeGreaterThan(0)
  })
})
