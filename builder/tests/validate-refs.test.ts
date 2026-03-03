import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateRefs } from '../src/recipe-engine/validate-refs.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'validate-refs-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('validate_refs', () => {
  it('正常な文書群では issues が空', async () => {
    await writeFile(join(tmpDir, 'BasicDesign.md'), [
      '# Basic Design',
      '## 1. 概要',
      'これは [[mcp-tools]] を参照する。',
    ].join('\n'))

    await writeFile(join(tmpDir, 'mcp-tools.md'), [
      '# MCP Tools',
      '## 1. memory_search',
    ].join('\n'))

    const result = await validateRefs([
      join(tmpDir, 'BasicDesign.md'),
      join(tmpDir, 'mcp-tools.md'),
    ])

    expect(result.status).toBe('ok')
    expect(result.issues).toHaveLength(0)
  })

  it('wiki-link のリンク切れを検出する', async () => {
    await writeFile(join(tmpDir, 'BasicDesign.md'), [
      '# Basic Design',
      '参照: [[missing-doc]]',
      '参照: [[also-missing]]',
    ].join('\n'))

    const result = await validateRefs([join(tmpDir, 'BasicDesign.md')])

    expect(result.status).toBe('warn')
    expect(result.issues).toHaveLength(2)
    expect(result.issues[0].type).toBe('broken_wiki_link')
    expect(result.issues[0].message).toContain('missing-doc')
    expect(result.issues[0].locations[0]).toContain('BasicDesign.md:2')
  })

  it('wiki-link のセクション指定（#）も処理する', async () => {
    await writeFile(join(tmpDir, 'a.md'), '参照: [[b#セクション1]]')
    await writeFile(join(tmpDir, 'b.md'), '# B\n## セクション1')

    const result = await validateRefs([
      join(tmpDir, 'a.md'),
      join(tmpDir, 'b.md'),
    ])

    expect(result.status).toBe('ok')
    expect(result.issues).toHaveLength(0)
  })

  it('UC-N の欠番を検出する', async () => {
    await writeFile(join(tmpDir, 'usecases.md'), [
      '# ユースケース',
      '- UC-1: ログイン',
      '- UC-2: ログアウト',
      '- UC-4: 設定変更',  // UC-3 が欠番
    ].join('\n'))

    const result = await validateRefs([join(tmpDir, 'usecases.md')])

    expect(result.status).toBe('warn')
    const gap = result.issues.find(i => i.type === 'usecase_gap')
    expect(gap).toBeDefined()
    expect(gap!.message).toContain('UC-3')
  })

  it('AC-N の欠番を検出する', async () => {
    await writeFile(join(tmpDir, 'ai-usecases.md'), [
      '# AI側ユースケース',
      '- AC-1: 記憶検索',
      '- AC-3: エピソード抽出',  // AC-2 が欠番
    ].join('\n'))

    const result = await validateRefs([join(tmpDir, 'ai-usecases.md')])

    const gap = result.issues.find(i => i.type === 'usecase_gap' && i.message.includes('AC-2'))
    expect(gap).toBeDefined()
  })

  it('連番が揃っていれば欠番なし', async () => {
    await writeFile(join(tmpDir, 'usecases.md'), [
      '- UC-1: a',
      '- UC-2: b',
      '- UC-3: c',
    ].join('\n'))

    const result = await validateRefs([join(tmpDir, 'usecases.md')])

    const gaps = result.issues.filter(i => i.type === 'usecase_gap')
    expect(gaps).toHaveLength(0)
  })

  it('サマリーが正しく集計される', async () => {
    await writeFile(join(tmpDir, 'doc.md'), [
      '参照: [[broken]]',
      '- UC-1: a',
      '- UC-3: c',
    ].join('\n'))

    const result = await validateRefs([join(tmpDir, 'doc.md')])

    expect(result.summary.warnings).toBe(2) // broken_wiki_link + usecase_gap
    expect(result.summary.errors).toBe(0)
  })

  it('複数文書にまたがるユースケースIDを統合して検出する', async () => {
    await writeFile(join(tmpDir, 'user-uc.md'), '- UC-1: a\n- UC-2: b')
    await writeFile(join(tmpDir, 'admin-uc.md'), '- UC-4: d')  // UC-3 欠番

    const result = await validateRefs([
      join(tmpDir, 'user-uc.md'),
      join(tmpDir, 'admin-uc.md'),
    ])

    const gap = result.issues.find(i => i.message.includes('UC-3'))
    expect(gap).toBeDefined()
  })

  it('インラインコード内の wiki-link は無視する', async () => {
    await writeFile(join(tmpDir, 'doc.md'), [
      '# 説明',
      'Obsidian の `[[wikilink]]` に着想を得た仕組み。',
      '通常の [[existing]] は検出する。',
    ].join('\n'))
    await writeFile(join(tmpDir, 'existing.md'), '# Existing')

    const result = await validateRefs([
      join(tmpDir, 'doc.md'),
      join(tmpDir, 'existing.md'),
    ])

    expect(result.status).toBe('ok')
    expect(result.issues).toHaveLength(0)
  })
})
