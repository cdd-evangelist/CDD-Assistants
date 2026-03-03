import { readFile, writeFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Recipe, ExecutionState, CompleteChunkResult } from '../types.js'

const execFileAsync = promisify(execFile)

/**
 * チャンクの完了を検証し、記録する。
 */
export async function completeChunk(
  executionStatePath: string,
  chunkId: string,
  generatedFiles: string[]
): Promise<CompleteChunkResult> {
  const absStatePath = resolve(executionStatePath)
  const stateRaw = await readFile(absStatePath, 'utf-8')
  const state: ExecutionState = JSON.parse(stateRaw)

  const recipeRaw = await readFile(state.recipe_path, 'utf-8')
  const recipe: Recipe = JSON.parse(recipeRaw)

  const chunk = recipe.chunks.find(c => c.id === chunkId)
  if (!chunk) {
    throw new Error(`Chunk not found: ${chunkId}`)
  }

  const chunkState = state.chunks[chunkId]
  if (!chunkState) {
    throw new Error(`Chunk state not found: ${chunkId}`)
  }

  // 1. ファイル存在確認
  const missingFiles: string[] = []
  for (const expected of chunk.expected_outputs) {
    const filePath = join(state.working_dir, expected)
    try {
      await access(filePath)
    } catch {
      missingFiles.push(expected)
    }
  }

  const filesExist = missingFiles.length === 0

  // 2. テスト実行（テストファイルがあれば）
  let testsPassed: boolean | undefined
  let testErrors: string[] | undefined

  if (recipe.tech_stack?.test && filesExist) {
    const testFiles = generatedFiles.filter(f =>
      f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__')
    )
    if (testFiles.length > 0) {
      try {
        const testCmd = recipe.tech_stack.test
        await execFileAsync('npx', [testCmd, 'run', ...testFiles], {
          cwd: state.working_dir,
          timeout: 60000,
        })
        testsPassed = true
      } catch (err: unknown) {
        testsPassed = false
        const error = err as { stderr?: string; stdout?: string }
        testErrors = [error.stderr || error.stdout || 'テスト実行に失敗']
      }
    }
  }

  // 3. 完了判定
  const success = filesExist && (testsPassed === undefined || testsPassed)

  // 4. 状態更新
  chunkState.status = success ? 'done' : 'failed'
  chunkState.completed_at = new Date().toISOString()
  chunkState.outputs = generatedFiles
  if (!success) {
    chunkState.retry_count += 1
    chunkState.error = missingFiles.length > 0
      ? `Missing files: ${missingFiles.join(', ')}`
      : testErrors?.join('\n') ?? 'Unknown error'
  }

  // 5. 後続チャンクのアンロック確認
  const newlyUnblocked: string[] = []
  if (success) {
    for (const c of recipe.chunks) {
      if (c.depends_on.includes(chunkId) && state.chunks[c.id]?.status === 'pending') {
        const allDepsDone = c.depends_on.every(
          depId => state.chunks[depId]?.status === 'done'
        )
        if (allDepsDone) {
          newlyUnblocked.push(c.id)
        }
      }
    }
  }

  // 状態ファイルを保存
  await writeFile(absStatePath, JSON.stringify(state, null, 2), 'utf-8')

  // 完了条件のレポート
  const criteriaMet = success
    ? chunk.completion_criteria.map(c => `${c}: OK`)
    : undefined

  return {
    chunk_id: chunkId,
    status: success ? 'done' : 'failed',
    verification: {
      files_exist: filesExist,
      missing_files: missingFiles.length > 0 ? missingFiles : undefined,
      tests_passed: testsPassed,
      test_errors: testErrors,
      criteria_met: criteriaMet,
    },
    newly_unblocked: newlyUnblocked,
  }
}
