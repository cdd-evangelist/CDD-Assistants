import { readFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import type { Recipe, ExecutionState, PreparedChunk, NextChunksResult } from '../types.js'

/**
 * {{file:path}} プレースホルダを実際のファイル内容に置換する。
 */
async function resolvePlaceholders(content: string, workingDir: string): Promise<string> {
  const pattern = /\{\{file:(.+?)\}\}/g
  const matches = [...content.matchAll(pattern)]

  let resolved = content
  for (const match of matches) {
    const filePath = join(workingDir, match[1])
    try {
      const fileContent = await readFile(filePath, 'utf-8')
      resolved = resolved.replace(match[0], `// --- ${match[1]} ---\n${fileContent}`)
    } catch {
      resolved = resolved.replace(match[0], `// --- ${match[1]} (未生成) ---`)
    }
  }

  return resolved
}

/**
 * 依存が解決済みのチャンクを返す。
 * プレースホルダを実際のコードに差し込み済みの実装指示を組み立てる。
 */
export async function nextChunks(executionStatePath: string): Promise<NextChunksResult> {
  const absStatePath = resolve(executionStatePath)
  const stateRaw = await readFile(absStatePath, 'utf-8')
  const state: ExecutionState = JSON.parse(stateRaw)

  const recipePath = state.recipe_path
  const recipeRaw = await readFile(recipePath, 'utf-8')
  const recipe: Recipe = JSON.parse(recipeRaw)

  const chunkMap = new Map(recipe.chunks.map(c => [c.id, c]))

  const done: string[] = []
  const failed: string[] = []
  const blocked: string[] = []
  const readyIds: string[] = []

  for (const chunk of recipe.chunks) {
    const chunkState = state.chunks[chunk.id]
    if (!chunkState) continue

    if (chunkState.status === 'done') {
      done.push(chunk.id)
    } else if (chunkState.status === 'failed') {
      // 失敗したチャンクも再実行可能として ready に含める
      readyIds.push(chunk.id)
      failed.push(chunk.id)
    } else if (chunkState.status === 'in_progress') {
      // 実行中は何もしない
    } else {
      // pending: 依存が全て done なら ready
      const allDepsDone = chunk.depends_on.every(
        depId => state.chunks[depId]?.status === 'done'
      )
      if (allDepsDone) {
        readyIds.push(chunk.id)
      } else {
        blocked.push(chunk.id)
      }
    }
  }

  // ready チャンクのプレースホルダを解決して PreparedChunk を作成
  const ready: PreparedChunk[] = []
  for (const id of readyIds) {
    const chunk = chunkMap.get(id)
    if (!chunk) continue

    const resolvedPrompt = await resolvePlaceholders(
      chunk.implementation_prompt,
      state.working_dir
    )
    const resolvedContent = await resolvePlaceholders(
      chunk.source_content,
      state.working_dir
    )

    ready.push({
      id: chunk.id,
      name: chunk.name,
      implementation_prompt: resolvedPrompt.replace('{source_content}', resolvedContent),
      expected_outputs: chunk.expected_outputs,
      completion_criteria: chunk.completion_criteria,
      reference_doc: chunk.reference_doc,
      working_dir: state.working_dir,
    })
  }

  const total = recipe.chunks.length
  return {
    ready,
    blocked,
    done,
    failed,
    progress: `${done.length}/${total} 完了`,
  }
}
