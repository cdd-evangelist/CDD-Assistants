import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Decision } from '../types.js'

/**
 * decisions.jsonl の絶対パスを解決する。
 * 設計文書標準 §5.1 に従い 4-ref/ 配下に配置する。
 *
 * - project_dir 配下に docs/ が存在する → <project_dir>/docs/4-ref/decisions.jsonl
 * - project_dir 末尾が docs（docs/ を直接渡された）→ <project_dir>/4-ref/decisions.jsonl
 * - docs/ なし（フラット構成）→ <project_dir>/4-ref/decisions.jsonl
 */
export function resolveDecisionsPath(projectDir: string): string {
  if (basename(projectDir) === 'docs') {
    return join(projectDir, '4-ref', 'decisions.jsonl')
  }
  if (existsSync(join(projectDir, 'docs'))) {
    return join(projectDir, 'docs', '4-ref', 'decisions.jsonl')
  }
  return join(projectDir, '4-ref', 'decisions.jsonl')
}

/**
 * decisions.jsonl を読み込み、Decision 配列として返す。
 * ファイルが存在しなければ空配列。
 */
export async function loadDecisions(projectDir: string): Promise<Decision[]> {
  const decisionsPath = resolveDecisionsPath(projectDir)
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
 * decisions.jsonl に1行追記する。親ディレクトリが無ければ自動作成する。
 */
export async function appendDecision(projectDir: string, decision: Decision): Promise<void> {
  const decisionsPath = resolveDecisionsPath(projectDir)
  await mkdir(dirname(decisionsPath), { recursive: true })
  const line = JSON.stringify(decision) + '\n'
  await appendFile(decisionsPath, line, 'utf-8')
}
