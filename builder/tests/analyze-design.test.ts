import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { analyzeDesign } from '../src/recipe-engine/analyze-design.js'
import { parseFrontmatter, detectDrift } from '../src/recipe-engine/analyze-design.js'

const exec = promisify(execFile)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'analyze-design-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// --- parseFrontmatter ---

describe('parseFrontmatter', () => {
  it('YAML フロントマターをパースする', () => {
    const content = [
      '---',
      'status: confirmed',
      'layer: foundation',
      'decisions:',
      '  - D-001',
      '  - D-002',
      '---',
      '# 本文',
      'ここから本文。',
    ].join('\n')

    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).not.toBeNull()
    expect(frontmatter!.status).toBe('confirmed')
    expect(frontmatter!.layer).toBe('foundation')
    expect(frontmatter!.decisions).toEqual(['D-001', 'D-002'])
    expect(body).toContain('# 本文')
    expect(body).not.toContain('---')
  })

  it('フロントマターがなければ null を返す', () => {
    const content = '# ドキュメント\n本文'
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toBeNull()
    expect(body).toBe(content)
  })
})

// --- analyzeDesign ---

describe('analyzeDesign', () => {
  it('基本的な文書分析ができる', async () => {
    await writeFile(join(tmpDir, 'BasicDesign.md'), [
      '# 基本設計',
      '## 1. 概要',
      'TypeScript と Node.js で実装する。',
      '## 2. アーキテクチャ',
      'SQLite を使用する。',
      '## 3. データベース',
      'テーブル定義は以下。',
    ].join('\n'))

    const result = await analyzeDesign({
      doc_paths: [join(tmpDir, 'BasicDesign.md')],
      project_name: 'TestProject',
    })

    expect(result.project_name).toBe('TestProject')
    expect(result.documents).toHaveLength(1)

    const doc = result.documents[0]
    expect(doc.path).toBe('BasicDesign.md')
    expect(doc.lines).toBe(7)
    expect(doc.sections).toContain('1. 概要')
    expect(doc.sections).toContain('2. アーキテクチャ')
    expect(doc.layer).toBe('foundation')
    expect(result.total_tokens).toBeGreaterThan(0)
  })

  it('wiki-link から依存グラフを構築する', async () => {
    await writeFile(join(tmpDir, 'a.md'), '# A\n参照: [[b]]')
    await writeFile(join(tmpDir, 'b.md'), '# B\n参照: [[a]]')

    const result = await analyzeDesign({
      doc_paths: [join(tmpDir, 'a.md'), join(tmpDir, 'b.md')],
      project_name: 'Test',
    })

    expect(result.dependency_graph['a.md']).toContain('b.md')
    expect(result.dependency_graph['b.md']).toContain('a.md')

    const docA = result.documents.find(d => d.path === 'a.md')!
    expect(docA.references_to).toContain('b.md')

    const docB = result.documents.find(d => d.path === 'b.md')!
    expect(docB.referenced_by).toContain('a.md')
  })

  it('フロントマターの layer を優先する（Hybrid C）', async () => {
    // ファイル名は "todo" を含むが、フロントマターで foundation 指定
    await writeFile(join(tmpDir, 'todo-list.md'), [
      '---',
      'layer: foundation',
      '---',
      '# 重要な設計方針のToDoリスト',
    ].join('\n'))

    const result = await analyzeDesign({
      doc_paths: [join(tmpDir, 'todo-list.md')],
      project_name: 'Test',
    })

    // ファイル名ヒントなら context になるが、フロントマター優先
    expect(result.documents[0].layer).toBe('foundation')
    expect(result.layers.foundation).toContain('todo-list.md')
  })

  it('ファイル名・内容からレイヤーを推定する', async () => {
    await writeFile(join(tmpDir, 'ai-usecases.md'), '# ユースケース\n- UC-1: ログイン\n- UC-2: ログアウト')
    await writeFile(join(tmpDir, 'ghost-cli.md'), '# CLI\n## コマンド一覧')
    await writeFile(join(tmpDir, 'ghost-security.md'), '# セキュリティ\nポリシーの仕様')
    await writeFile(join(tmpDir, 'operation-flows.md'), '# 操作フロー\nベンチマーク手順')

    const result = await analyzeDesign({
      doc_paths: [
        join(tmpDir, 'ai-usecases.md'),
        join(tmpDir, 'ghost-cli.md'),
        join(tmpDir, 'ghost-security.md'),
        join(tmpDir, 'operation-flows.md'),
      ],
      project_name: 'Test',
    })

    const layerOf = (name: string) => result.documents.find(d => d.path === name)!.layer
    expect(layerOf('ai-usecases.md')).toBe('usecase')
    expect(layerOf('ghost-cli.md')).toBe('interface')
    expect(layerOf('ghost-security.md')).toBe('specification')
    expect(layerOf('operation-flows.md')).toBe('operation')
  })

  it('tech_stack を設計文書から抽出する', async () => {
    await writeFile(join(tmpDir, 'design.md'), [
      '# 設計',
      '## 技術選定',
      'TypeScript + Node.js で実装する。',
      'データベースは SQLite (better-sqlite3)。',
      'テストは vitest を使用。',
    ].join('\n'))

    const result = await analyzeDesign({
      doc_paths: [join(tmpDir, 'design.md')],
      project_name: 'Test',
    })

    expect(result.tech_stack.language).toBe('TypeScript')
    expect(result.tech_stack.runtime).toBe('Node.js')
    expect(result.tech_stack.db).toBe('SQLite')
    expect(result.tech_stack.test).toBe('vitest')
  })

  it('decisions.jsonl から追加の依存関係を反映する', async () => {
    await writeFile(join(tmpDir, 'a.md'), '# A')
    await writeFile(join(tmpDir, 'b.md'), '# B')
    await writeFile(join(tmpDir, 'decisions.jsonl'), [
      JSON.stringify({
        id: 'D-001',
        decision: 'AとBは関連する',
        affected_docs: ['a.md', 'b.md'],
        decided_at: '2026-03-01',
      }),
    ].join('\n'))

    const result = await analyzeDesign({
      doc_paths: [join(tmpDir, 'a.md'), join(tmpDir, 'b.md')],
      project_name: 'Test',
      project_dir: tmpDir,
    })

    // decisions.jsonl により a→b, b→a の依存が追加される
    expect(result.dependency_graph['a.md']).toContain('b.md')
    expect(result.dependency_graph['b.md']).toContain('a.md')
  })

  it('トークン推定で日本語を適切にカウントする', async () => {
    await writeFile(join(tmpDir, 'jp.md'), '日本語テスト') // 6文字 × 2 = 12トークン
    await writeFile(join(tmpDir, 'en.md'), 'English test') // 12文字 × 0.25 = 3トークン

    const result = await analyzeDesign({
      doc_paths: [join(tmpDir, 'jp.md'), join(tmpDir, 'en.md')],
      project_name: 'Test',
    })

    const jpDoc = result.documents.find(d => d.path === 'jp.md')!
    const enDoc = result.documents.find(d => d.path === 'en.md')!
    expect(jpDoc.estimated_tokens).toBeGreaterThan(enDoc.estimated_tokens)
  })
})

// --- detectDrift ---

describe('detectDrift', () => {
  let gitDir: string

  async function git(...args: string[]) {
    return exec('git', args, { cwd: gitDir })
  }

  beforeEach(async () => {
    gitDir = await mkdtemp(join(tmpdir(), 'drift-test-'))
    await git('init')
    await git('config', 'user.email', 'test@test.com')
    await git('config', 'user.name', 'Test')
  })

  afterEach(async () => {
    await rm(gitDir, { recursive: true, force: true })
  })

  it('リファレンスがなければ空配列を返す', async () => {
    const warnings = await detectDrift(gitDir)
    expect(warnings).toEqual([])
  })

  it('リファレンス後に変更がなければ空配列を返す', async () => {
    // 初期コミット
    await writeFile(join(gitDir, 'src.ts'), 'const x = 1')
    await git('add', '.')
    await git('commit', '-m', 'initial')

    // 1秒待ってリファレンス作成（mtime がコミット後になるように）
    await new Promise(r => setTimeout(r, 1100))
    await mkdir(join(gitDir, 'docs', 'ref'), { recursive: true })
    await writeFile(join(gitDir, 'docs', 'ref', 'chunk-01-ref.md'), '# Reference')
    await git('add', '.')
    await git('commit', '-m', 'add reference')

    const warnings = await detectDrift(gitDir)
    expect(warnings).toEqual([])
  })

  it('リファレンス後にコード変更があれば警告を返す', async () => {
    // 初期コミット + リファレンス
    await mkdir(join(gitDir, 'docs', 'ref'), { recursive: true })
    await writeFile(join(gitDir, 'src.ts'), 'const x = 1')
    await writeFile(join(gitDir, 'docs', 'ref', 'chunk-01-ref.md'), '# Reference')
    await git('add', '.')
    await git('commit', '-m', 'initial with reference')

    // 1秒待ってからコード変更（mtime の差を確保）
    await new Promise(r => setTimeout(r, 1100))
    await writeFile(join(gitDir, 'src.ts'), 'const x = 2')
    await git('add', '.')
    await git('commit', '-m', 'modify src')

    const warnings = await detectDrift(gitDir)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].reference).toContain('chunk-01-ref.md')
    expect(warnings[0].commits_since).toBeGreaterThanOrEqual(1)
    expect(warnings[0].changed_files).toContain('src.ts')
    expect(warnings[0].message).toContain('リファレンス生成後')
  })

  it('docs/ref/ 内の変更は検出対象から除外する', async () => {
    await mkdir(join(gitDir, 'docs', 'ref'), { recursive: true })
    await writeFile(join(gitDir, 'docs', 'ref', 'chunk-01-ref.md'), '# Reference v1')
    await git('add', '.')
    await git('commit', '-m', 'initial')

    await new Promise(r => setTimeout(r, 1100))
    // リファレンス自身だけを変更
    await writeFile(join(gitDir, 'docs', 'ref', 'chunk-01-ref.md'), '# Reference v2')
    await git('add', '.')
    await git('commit', '-m', 'update reference only')

    const warnings = await detectDrift(gitDir)
    // docs/ref/ の変更はフィルタされるので、changed_files が空 → 警告なし
    expect(warnings).toEqual([])
  })

  it('git リポジトリでなければ空配列を返す', async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), 'no-git-'))
    await mkdir(join(nonGitDir, 'docs', 'ref'), { recursive: true })
    await writeFile(join(nonGitDir, 'docs', 'ref', 'ref.md'), '# Ref')

    const warnings = await detectDrift(nonGitDir)
    expect(warnings).toEqual([])

    await rm(nonGitDir, { recursive: true, force: true })
  })
})
