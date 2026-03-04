import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { trackDecision } from '../src/tools/track-decision.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'track-decision-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('trackDecision', () => {
  it('新規プロジェクトで DEC-001 を生成する', async () => {
    await writeFile(join(tmpDir, 'a.md'), '# A')

    const result = await trackDecision({
      project_dir: tmpDir,
      decision: 'テスト決定',
      rationale: 'テスト理由',
      affects: ['a.md'],
    })

    expect(result.decision_id).toBe('DEC-001')
    expect(result.recorded_at).toBeTruthy()
  })

  it('既存の decisions.jsonl に追記する', async () => {
    await writeFile(join(tmpDir, 'a.md'), '# A')
    await writeFile(join(tmpDir, 'decisions.jsonl'),
      JSON.stringify({ id: 'DEC-001', decision: '既存', rationale: '', affects: ['a.md'], created_at: '2026-03-01T00:00:00Z' }) + '\n'
    )

    const result = await trackDecision({
      project_dir: tmpDir,
      decision: '新規決定',
      rationale: '理由',
      affects: ['a.md'],
    })

    expect(result.decision_id).toBe('DEC-002')

    // ファイルに2行あることを確認
    const content = await readFile(join(tmpDir, 'decisions.jsonl'), 'utf-8')
    const lines = content.trim().split('\n').filter(l => l.trim())
    expect(lines).toHaveLength(2)

    const lastLine = JSON.parse(lines[1])
    expect(lastLine.id).toBe('DEC-002')
    expect(lastLine.decision).toBe('新規決定')
  })

  it('連番が正しくインクリメントされる', async () => {
    await writeFile(join(tmpDir, 'decisions.jsonl'), [
      JSON.stringify({ id: 'DEC-001', decision: 'a', rationale: '', affects: [], created_at: '' }),
      JSON.stringify({ id: 'DEC-005', decision: 'b', rationale: '', affects: [], created_at: '' }),
    ].join('\n') + '\n')

    const result = await trackDecision({
      project_dir: tmpDir,
      decision: '新規',
      rationale: '',
      affects: [],
    })

    // 最大の既存 ID (DEC-005) + 1
    expect(result.decision_id).toBe('DEC-006')
  })

  it('影響文書の存在チェックを行う', async () => {
    await writeFile(join(tmpDir, 'existing.md'), '# Existing')

    const result = await trackDecision({
      project_dir: tmpDir,
      decision: 'テスト',
      rationale: '',
      affects: ['existing.md', 'missing.md'],
    })

    expect(result.affected_documents_status).toHaveLength(2)

    const existing = result.affected_documents_status.find(d => d.path === 'existing.md')!
    expect(existing.exists).toBe(true)
    expect(existing.needs_update).toBe(true)

    const missing = result.affected_documents_status.find(d => d.path === 'missing.md')!
    expect(missing.exists).toBe(false)
    expect(missing.needs_update).toBe(true)
  })

  it('supersedes を記録する', async () => {
    const result = await trackDecision({
      project_dir: tmpDir,
      decision: '新方針',
      rationale: '旧方針を置換',
      affects: [],
      supersedes: '旧: messages テーブル',
    })

    const content = await readFile(join(tmpDir, 'decisions.jsonl'), 'utf-8')
    const parsed = JSON.parse(content.trim())
    expect(parsed.supersedes).toBe('旧: messages テーブル')
  })

  it('recorded_at が ISO 8601 形式', async () => {
    const result = await trackDecision({
      project_dir: tmpDir,
      decision: 'テスト',
      rationale: '',
      affects: [],
    })

    // ISO 8601 形式のチェック
    const date = new Date(result.recorded_at)
    expect(date.toISOString()).toBe(result.recorded_at)
  })
})
