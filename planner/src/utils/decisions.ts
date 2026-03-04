import { readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Decision } from '../types.js'

/**
 * decisions.jsonl を読み込み、Decision 配列として返す。
 * ファイルが存在しなければ空配列。
 */
export async function loadDecisions(projectDir: string): Promise<Decision[]> {
  const decisionsPath = join(projectDir, 'decisions.jsonl')
  try {
    const raw = await readFile(decisionsPath, 'utf-8')
    return raw.trim().split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as Decision)
  } catch {
    return []
  }
}

/**
 * 既存の決定IDから次の連番IDを生成する。
 * 例: 既存に DEC-003 まであれば DEC-004 を返す。
 */
export function generateDecisionId(existing: Decision[]): string {
  if (existing.length === 0) return 'DEC-001'

  let maxNum = 0
  for (const dec of existing) {
    const match = dec.id.match(/^DEC-(\d+)$/)
    if (match) {
      const num = parseInt(match[1], 10)
      if (num > maxNum) maxNum = num
    }
  }
  return `DEC-${String(maxNum + 1).padStart(3, '0')}`
}

/**
 * decisions.jsonl に1行追記する。
 */
export async function appendDecision(projectDir: string, decision: Decision): Promise<void> {
  const decisionsPath = join(projectDir, 'decisions.jsonl')
  const line = JSON.stringify(decision) + '\n'
  await appendFile(decisionsPath, line, 'utf-8')
}
