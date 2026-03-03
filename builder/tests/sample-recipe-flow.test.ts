import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir, cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRecipe } from '../src/execution-engine/load-recipe.js'
import { nextChunks } from '../src/execution-engine/next-chunks.js'
import { completeChunk } from '../src/execution-engine/complete-chunk.js'
import { executionStatus } from '../src/execution-engine/execution-status.js'

let tmpDir: string
let recipePath: string
let statePath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ghost-shell-test-'))
  recipePath = join(tmpDir, 'recipe.json')
  statePath = join(tmpDir, 'recipe-state.json')

  // サンプルレシピをコピー
  const fixtureRecipe = new URL('./fixtures/sample-recipe.json', import.meta.url).pathname
  await cp(fixtureRecipe, recipePath)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('AI-Ghost-Shell サンプルレシピ フロー', () => {
  it('レシピを読み込んで chunk-01 が ready になる', async () => {
    const result = await loadRecipe(recipePath, tmpDir)

    expect(result.project).toBe('AI-Ghost-Shell')
    expect(result.total_chunks).toBe(3)
    expect(result.ready_chunks).toEqual(['chunk-01'])
  })

  it('chunk-01 の実装プロンプトに CREATE TABLE が含まれる', async () => {
    await loadRecipe(recipePath, tmpDir)
    const result = await nextChunks(statePath)

    expect(result.ready).toHaveLength(1)
    const chunk01 = result.ready[0]
    expect(chunk01.id).toBe('chunk-01')
    expect(chunk01.implementation_prompt).toContain('CREATE TABLE ghost_profile')
    expect(chunk01.implementation_prompt).toContain('CREATE TABLE sessions')
    expect(chunk01.implementation_prompt).toContain('CREATE TABLE episode_memories')
    expect(chunk01.expected_outputs).toContain('src/db/schema.sql')
  })

  it('全3チャンクを順番に完了させるフルフロー', async () => {
    await loadRecipe(recipePath, tmpDir)

    // --- chunk-01: DB スキーマ ---
    const step1 = await nextChunks(statePath)
    expect(step1.ready).toHaveLength(1)
    expect(step1.ready[0].id).toBe('chunk-01')

    // chunk-01 の成果物をシミュレート
    await mkdir(join(tmpDir, 'src/db'), { recursive: true })
    await mkdir(join(tmpDir, 'tests/db'), { recursive: true })
    await writeFile(join(tmpDir, 'src/db/schema.sql'), 'CREATE TABLE ghost_profile (...);')
    await writeFile(join(tmpDir, 'src/db/connection.ts'), 'export function connect() {}')
    await writeFile(join(tmpDir, 'src/db/migrate.ts'), 'export function migrate() {}')
    await writeFile(join(tmpDir, 'tests/db/schema.test.ts'), 'test("tables", () => {})')

    const complete1 = await completeChunk(statePath, 'chunk-01', [
      'src/db/schema.sql', 'src/db/connection.ts', 'src/db/migrate.ts', 'tests/db/schema.test.ts',
    ])
    expect(complete1.status).toBe('done')
    expect(complete1.newly_unblocked.sort()).toEqual(['chunk-02', 'chunk-03'])

    // --- chunk-02 & chunk-03: 並列で実行可能 ---
    const step2 = await nextChunks(statePath)
    expect(step2.ready).toHaveLength(2)
    const readyIds = step2.ready.map(c => c.id).sort()
    expect(readyIds).toEqual(['chunk-02', 'chunk-03'])
    expect(step2.progress).toBe('1/3 完了')

    // chunk-02 のプレースホルダが解決されている
    const chunk02 = step2.ready.find(c => c.id === 'chunk-02')!
    expect(chunk02.implementation_prompt).toContain('export function connect')
    expect(chunk02.implementation_prompt).not.toContain('{{file:')

    // chunk-03 のプレースホルダも解決
    const chunk03 = step2.ready.find(c => c.id === 'chunk-03')!
    expect(chunk03.implementation_prompt).toContain('CREATE TABLE ghost_profile')
    expect(chunk03.implementation_prompt).not.toContain('{{file:')

    // chunk-02 の成果物をシミュレート
    await mkdir(join(tmpDir, 'src/policy'), { recursive: true })
    await mkdir(join(tmpDir, 'tests/policy'), { recursive: true })
    await writeFile(join(tmpDir, 'src/policy/types.ts'), 'export interface GhostPolicy {}')
    await writeFile(join(tmpDir, 'src/policy/defaults.ts'), 'export const defaults = {}')
    await writeFile(join(tmpDir, 'src/policy/parser.ts'), 'export function loadPolicy() {}')
    await writeFile(join(tmpDir, 'tests/policy/parser.test.ts'), 'test("parse", () => {})')

    const complete2 = await completeChunk(statePath, 'chunk-02', [
      'src/policy/types.ts', 'src/policy/defaults.ts', 'src/policy/parser.ts', 'tests/policy/parser.test.ts',
    ])
    expect(complete2.status).toBe('done')

    // chunk-03 の成果物をシミュレート
    await mkdir(join(tmpDir, 'src/session'), { recursive: true })
    await mkdir(join(tmpDir, 'tests/session'), { recursive: true })
    await writeFile(join(tmpDir, 'src/session/scanner.ts'), 'export function scanSessions() {}')
    await writeFile(join(tmpDir, 'src/session/types.ts'), 'export interface SessionMeta {}')
    await writeFile(join(tmpDir, 'tests/session/scanner.test.ts'), 'test("scan", () => {})')

    const complete3 = await completeChunk(statePath, 'chunk-03', [
      'src/session/scanner.ts', 'src/session/types.ts', 'tests/session/scanner.test.ts',
    ])
    expect(complete3.status).toBe('done')

    // --- 全体進捗を確認 ---
    const status = await executionStatus(statePath)
    expect(status.progress.done).toBe(3)
    expect(status.progress.total).toBe(3)
    expect(status.progress.pending).toBe(0)
    expect(status.progress.blocked).toBe(0)
    expect(status.current_level).toBe(2) // 全レベル完了
    expect(status.estimated_remaining).toBe('0 chunks')
  })

  it('chunk-01 が失敗した場合、chunk-02/03 は blocked のまま', async () => {
    await loadRecipe(recipePath, tmpDir)

    // chunk-01 をファイルなしで完了させる（失敗）
    const complete1 = await completeChunk(statePath, 'chunk-01', [])
    expect(complete1.status).toBe('failed')

    // chunk-02, chunk-03 はまだ blocked
    const step2 = await nextChunks(statePath)
    // chunk-01 が failed なので ready に含まれる（リトライ対象）
    const readyIds = step2.ready.map(c => c.id)
    expect(readyIds).toContain('chunk-01')
    expect(readyIds).not.toContain('chunk-02')
    expect(readyIds).not.toContain('chunk-03')

    const status = await executionStatus(statePath)
    expect(status.progress.failed).toBe(1)
    expect(status.progress.blocked).toBe(2)
  })
})
