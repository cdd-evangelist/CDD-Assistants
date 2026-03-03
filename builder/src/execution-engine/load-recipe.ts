import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import type { Recipe, ExecutionState, LoadRecipeResult } from '../types.js'

/**
 * レシピファイルを読み込み、実行状態を初期化する。
 */
export async function loadRecipe(recipePath: string, workingDir?: string): Promise<LoadRecipeResult> {
  const absRecipePath = resolve(recipePath)
  const raw = await readFile(absRecipePath, 'utf-8')
  const recipe: Recipe = JSON.parse(raw)

  // 実行状態の初期化
  const state: ExecutionState = {
    recipe_path: absRecipePath,
    working_dir: workingDir ?? dirname(absRecipePath),
    started_at: new Date().toISOString(),
    chunks: {},
  }

  for (const chunk of recipe.chunks) {
    state.chunks[chunk.id] = {
      status: 'pending',
      started_at: null,
      completed_at: null,
      outputs: [],
      retry_count: 0,
    }
  }

  // 依存なしで即座に実行可能なチャンクを特定
  const readyChunks = recipe.chunks
    .filter(c => c.depends_on.length === 0)
    .map(c => c.id)

  // 実行状態ファイルを保存
  const statePath = absRecipePath.replace(/\.json$/, '-state.json')
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8')

  return {
    project: recipe.project,
    total_chunks: recipe.chunks.length,
    ready_chunks: readyChunks,
    execution_state_path: statePath,
  }
}
