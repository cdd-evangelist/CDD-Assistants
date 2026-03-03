import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Recipe, ExecutionState, ExecutionStatusResult } from '../types.js'

/**
 * 全体の実行進捗を可視化する。
 */
export async function executionStatus(executionStatePath: string): Promise<ExecutionStatusResult> {
  const absStatePath = resolve(executionStatePath)
  const stateRaw = await readFile(absStatePath, 'utf-8')
  const state: ExecutionState = JSON.parse(stateRaw)

  const recipeRaw = await readFile(state.recipe_path, 'utf-8')
  const recipe: Recipe = JSON.parse(recipeRaw)

  let doneCount = 0
  let inProgressCount = 0
  let pendingCount = 0
  let failedCount = 0
  let blockedCount = 0

  const chunkDetails: ExecutionStatusResult['chunks'] = []

  for (const chunk of recipe.chunks) {
    const chunkState = state.chunks[chunk.id]
    if (!chunkState) continue

    const { status } = chunkState

    if (status === 'done') {
      doneCount++
    } else if (status === 'in_progress') {
      inProgressCount++
    } else if (status === 'failed') {
      failedCount++
    } else {
      // pending: 依存が全て done なら pending、そうでなければ blocked
      const allDepsDone = chunk.depends_on.every(
        depId => state.chunks[depId]?.status === 'done'
      )
      if (allDepsDone) {
        pendingCount++
      } else {
        blockedCount++
      }
    }

    const blockedBy = chunk.depends_on.filter(
      depId => state.chunks[depId]?.status !== 'done'
    )

    chunkDetails.push({
      id: chunk.id,
      name: chunk.name,
      status: status,
      blocked_by: blockedBy.length > 0 ? blockedBy : undefined,
      retry_count: chunkState.retry_count > 0 ? chunkState.retry_count : undefined,
    })
  }

  // 現在の実行レベルを判定
  let currentLevel = 0
  for (let i = 0; i < recipe.execution_order.length; i++) {
    const levelChunks = recipe.execution_order[i]
    const allDone = levelChunks.every(id => state.chunks[id]?.status === 'done')
    if (allDone) {
      currentLevel = i + 1
    } else {
      break
    }
  }

  const total = recipe.chunks.length
  const remaining = total - doneCount

  return {
    progress: {
      done: doneCount,
      in_progress: inProgressCount,
      pending: pendingCount,
      failed: failedCount,
      blocked: blockedCount,
      total,
    },
    chunks: chunkDetails,
    current_level: currentLevel,
    estimated_remaining: `${remaining} chunks`,
  }
}
