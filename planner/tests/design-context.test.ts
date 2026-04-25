import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

  describe('standard_doc_path の解決', () => {
    it('プロジェクト内 docs/design-doc-standard.md があればそれを返す', async () => {
      await mkdir(join(tmpDir, 'docs'), { recursive: true })
      const standardPath = join(tmpDir, 'docs', 'design-doc-standard.md')
      await writeFile(standardPath, '# 標準')

      const result = await designContext({ project_dir: tmpDir })
      expect(result.standard_doc_path).toBe(resolve(standardPath))
    })

    it('プロジェクト直下 design-doc-standard.md があればそれを返す', async () => {
      const standardPath = join(tmpDir, 'design-doc-standard.md')
      await writeFile(standardPath, '# 標準')

      const result = await designContext({ project_dir: tmpDir })
      expect(result.standard_doc_path).toBe(resolve(standardPath))
    })

    it('プロジェクト内に標準が無ければバンドル版にフォールバックする', async () => {
      await writeFile(join(tmpDir, 'a.md'), '# A')

      const result = await designContext({ project_dir: tmpDir })
      // バンドル版は planner/templates/design-doc-standard.md を指す絶対パス
      expect(result.standard_doc_path).not.toBeNull()
      expect(result.standard_doc_path).toMatch(/templates[\\/]design-doc-standard\.md$/)
    })

    it('プロジェクト内 docs/ がプロジェクト直下より優先される', async () => {
      await mkdir(join(tmpDir, 'docs'), { recursive: true })
      const docsPath = join(tmpDir, 'docs', 'design-doc-standard.md')
      const rootPath = join(tmpDir, 'design-doc-standard.md')
      await writeFile(docsPath, '# docs')
      await writeFile(rootPath, '# root')

      const result = await designContext({ project_dir: tmpDir })
      expect(result.standard_doc_path).toBe(resolve(docsPath))
    })
  })

  describe('再帰スキャン', () => {
    it('サブディレクトリ配下の .md ファイルを再帰的に拾う', async () => {
      await mkdir(join(tmpDir, '2-features'), { recursive: true })
      await mkdir(join(tmpDir, '3-details'), { recursive: true })
      await writeFile(join(tmpDir, 'basic-design.md'), '# 基本')
      await writeFile(join(tmpDir, '2-features', 'auth.md'), '# 認証')
      await writeFile(join(tmpDir, '3-details', 'mcp-tools.md'), '# MCP')

      const result = await designContext({ project_dir: tmpDir })

      const paths = result.documents.map(d => d.path).sort()
      expect(paths).toEqual([
        '2-features/auth.md',
        '3-details/mcp-tools.md',
        'basic-design.md',
      ])
    })

    it('複数コンポーネント構成（component/3-details/）も拾う', async () => {
      await mkdir(join(tmpDir, 'planner', '3-details'), { recursive: true })
      await mkdir(join(tmpDir, 'builder', '3-details'), { recursive: true })
      await writeFile(join(tmpDir, 'planner', 'basic-design.md'), '# planner')
      await writeFile(join(tmpDir, 'planner', '3-details', 'tools.md'), '# tools')
      await writeFile(join(tmpDir, 'builder', 'basic-design.md'), '# builder')

      const result = await designContext({ project_dir: tmpDir })

      const paths = result.documents.map(d => d.path).sort()
      expect(paths).toContain('planner/basic-design.md')
      expect(paths).toContain('planner/3-details/tools.md')
      expect(paths).toContain('builder/basic-design.md')
    })

    it('隠しディレクトリ（.git など）を除外する', async () => {
      await mkdir(join(tmpDir, '.git'), { recursive: true })
      await writeFile(join(tmpDir, '.git', 'should-not-find.md'), '# 隠れ')
      await writeFile(join(tmpDir, 'visible.md'), '# 見える')

      const result = await designContext({ project_dir: tmpDir })

      const paths = result.documents.map(d => d.path)
      expect(paths).toContain('visible.md')
      expect(paths.some(p => p.includes('.git'))).toBe(false)
    })

    it('node_modules / dist / build / target を除外する', async () => {
      for (const dir of ['node_modules', 'dist', 'build', 'target']) {
        await mkdir(join(tmpDir, dir), { recursive: true })
        await writeFile(join(tmpDir, dir, 'should-not-find.md'), '# 除外')
      }
      await writeFile(join(tmpDir, 'visible.md'), '# 見える')

      const result = await designContext({ project_dir: tmpDir })

      const paths = result.documents.map(d => d.path)
      expect(paths).toEqual(['visible.md'])
    })

    it('文書のパスは POSIX 形式の相対パスで保存される', async () => {
      await mkdir(join(tmpDir, '3-details'), { recursive: true })
      await writeFile(join(tmpDir, '3-details', 'tools.md'), '# tools')

      const result = await designContext({ project_dir: tmpDir })

      expect(result.documents[0].path).toBe('3-details/tools.md')
      expect(result.documents[0].path).not.toContain('\\')
    })
  })

  describe('プロジェクト名の解決', () => {
    it('通常のディレクトリ名はそのまま使われる', async () => {
      await writeFile(join(tmpDir, 'a.md'), '# A')
      const result = await designContext({ project_dir: tmpDir })
      // tmpDir は mkdtemp が生成したパスなので、末尾セグメントがそのまま入る
      expect(result.project).not.toBe('docs')
    })

    it('末尾が docs の場合は親ディレクトリ名を使う', async () => {
      const docsDir = join(tmpDir, 'docs')
      await mkdir(docsDir, { recursive: true })
      await writeFile(join(docsDir, 'a.md'), '# A')

      const result = await designContext({ project_dir: docsDir })

      // tmpDir の末尾セグメントが project になる
      const expected = tmpDir.split(/[/\\]/).filter(Boolean).pop()
      expect(result.project).toBe(expected)
    })
  })

  describe('layer 推定', () => {
    it('README.md は layer: context として扱う', async () => {
      await writeFile(join(tmpDir, 'README.md'), [
        '# プロジェクト',
        '## ユースケース',
        '- usecase 1',
      ].join('\n'))

      const result = await designContext({ project_dir: tmpDir })
      const readme = result.documents.find(d => d.path === 'README.md')!
      expect(readme.layer).toBe('context')
    })

    it('CHANGELOG.md は layer: context として扱う', async () => {
      await writeFile(join(tmpDir, 'CHANGELOG.md'), '# 変更履歴\n## 2026-04-25\n- 修正')

      const result = await designContext({ project_dir: tmpDir })
      const changelog = result.documents.find(d => d.path === 'CHANGELOG.md')!
      expect(changelog.layer).toBe('context')
    })

    it('フロントマターの layer はファイル名 hint より優先される', async () => {
      await writeFile(join(tmpDir, 'README.md'), [
        '---',
        'layer: foundation',
        '---',
        '# README',
      ].join('\n'))

      const result = await designContext({ project_dir: tmpDir })
      const readme = result.documents.find(d => d.path === 'README.md')!
      expect(readme.layer).toBe('foundation')
    })
  })
})
