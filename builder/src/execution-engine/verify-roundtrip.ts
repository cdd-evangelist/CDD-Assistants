import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import type { Recipe, ExecutionState, DivergenceReport } from '../types.js'

export type Verdict = 'OK' | '要更新' | 'NG'

export interface VerificationRecord {
  verdict: Verdict
  verification_path: string
}

/**
 * DivergenceReport から最終判定を計算する。
 * - critical が1件でもあれば NG
 * - update_needed があれば 要更新
 * - 上記がなければ OK（軽微のみ含む / 乖離なし）
 */
export function computeVerdict(report: DivergenceReport): Verdict {
  const hasCritical = report.items.some(i => i.severity === 'critical')
  if (hasCritical) return 'NG'

  const hasUpdateNeeded = report.items.some(i => i.severity === 'update_needed')
  if (hasUpdateNeeded) return '要更新'

  return 'OK'
}

interface FormatInput {
  chunkName: string
  sourceDocPaths: string[]
  referenceDocPath: string
  timestamp: string
  divergence: DivergenceReport
}

/**
 * 検証結果のマークダウンを整形する（roundtrip-verification.md §6）。
 */
export function formatVerificationReport(input: FormatInput): string {
  const verdict = computeVerdict(input.divergence)

  // 重み別カウント
  const counts = { critical: 0, update_needed: 0, minor: 0 }
  for (const item of input.divergence.items) {
    counts[item.severity]++
  }

  const lines: string[] = [
    `# ラウンドトリップ検証結果: ${input.chunkName}`,
    '',
    `- 検証日時: ${input.timestamp}`,
    `- 設計文書: ${input.sourceDocPaths.join(', ')}`,
    `- リファレンス: ${input.referenceDocPath}`,
    '',
    `## 判定: ${verdict}`,
    '',
    '## 乖離一覧',
    '',
    '| # | 重み | 分類 | 内容 |',
    '|---|------|------|------|',
  ]

  if (input.divergence.items.length === 0) {
    lines.push('| - | - | - | （乖離なし） |')
  } else {
    input.divergence.items.forEach((item, i) => {
      const severityLabel = severityToLabel(item.severity)
      lines.push(`| ${i + 1} | ${severityLabel} | ${item.category} | ${item.description} |`)
    })
  }

  lines.push(
    '',
    '## サマリー',
    '',
    `- 致命的: ${counts.critical}件`,
    `- 要更新: ${counts.update_needed}件`,
    `- 軽微: ${counts.minor}件`,
  )

  return lines.join('\n')
}

function severityToLabel(s: 'critical' | 'update_needed' | 'minor'): string {
  return s === 'critical' ? '致命的' : s === 'update_needed' ? '要更新' : '軽微'
}

/**
 * 検証結果を docs/ref/verification-{chunk_id}.md として記録する。
 */
export async function recordVerificationResult(
  executionStatePath: string,
  chunkId: string,
  divergence: DivergenceReport,
): Promise<VerificationRecord> {
  const absStatePath = resolve(executionStatePath)
  const stateRaw = await readFile(absStatePath, 'utf-8')
  const state: ExecutionState = JSON.parse(stateRaw)

  const recipeRaw = await readFile(resolve(state.recipe_path), 'utf-8')
  const recipe: Recipe = JSON.parse(recipeRaw)

  const chunk = recipe.chunks.find(c => c.id === chunkId)
  if (!chunk) {
    throw new Error(`チャンク ${chunkId} が recipe.json に見つかりません`)
  }

  const verificationPath = join(
    state.working_dir,
    'docs',
    'ref',
    `verification-${chunkId}.md`,
  )

  const md = formatVerificationReport({
    chunkName: chunk.name,
    sourceDocPaths: chunk.source_docs.map(d => d.path),
    referenceDocPath: chunk.reference_doc,
    timestamp: new Date().toISOString(),
    divergence,
  })

  await mkdir(dirname(verificationPath), { recursive: true })
  await writeFile(verificationPath, md, 'utf-8')

  return {
    verdict: computeVerdict(divergence),
    verification_path: verificationPath,
  }
}
