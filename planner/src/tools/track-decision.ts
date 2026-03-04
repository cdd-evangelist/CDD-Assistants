import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { loadDecisions, generateDecisionId, appendDecision } from '../utils/decisions.js'
import type {
  TrackDecisionInput,
  TrackDecisionResult,
  AffectedDocStatus,
  Decision,
} from '../types.js'

/**
 * 決定事項を decisions.jsonl に記録し、影響文書のステータスを返す。
 */
export async function trackDecision(input: TrackDecisionInput): Promise<TrackDecisionResult> {
  const { project_dir, decision, rationale, affects, supersedes } = input

  // 既存の決定を読み込み
  const existing = await loadDecisions(project_dir)

  // 新しい決定IDを生成
  const decision_id = generateDecisionId(existing)
  const created_at = new Date().toISOString()

  // Decision オブジェクトを構築
  const newDecision: Decision = {
    id: decision_id,
    decision,
    rationale,
    affects,
    supersedes: supersedes ?? null,
    created_at,
  }

  // decisions.jsonl に追記
  await appendDecision(project_dir, newDecision)

  // 影響文書の存在チェック
  const affected_documents_status: AffectedDocStatus[] = []
  for (const docPath of affects) {
    const fullPath = join(project_dir, docPath)
    let exists = false
    try {
      await access(fullPath)
      exists = true
    } catch {
      exists = false
    }
    affected_documents_status.push({
      path: docPath,
      needs_update: true,
      exists,
    })
  }

  return {
    decision_id,
    recorded_at: created_at,
    affected_documents_status,
  }
}
