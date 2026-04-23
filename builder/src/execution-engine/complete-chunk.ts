import { readFile, writeFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFile, exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { Recipe, ExecutionState, CompleteChunkResult } from '../types.js'
import { checkTestQuality } from './test-quality-checker.js'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

/**
 * coding_standards.scripts のコマンド（"npm run lint" 等の shell 表記）を実行し、
 * pass/fail と stderr/stdout を返す。
 */
async function runStandardScript(
  command: string,
  workingDir: string
): Promise<{ passed: boolean; errors?: string[] }> {
  try {
    await execAsync(command, { cwd: workingDir, timeout: 60000 })
    return { passed: true }
  } catch (err: unknown) {
    const error = err as { stderr?: string; stdout?: string; message?: string }
    const output = error.stderr || error.stdout || error.message || '実行に失敗'
    return { passed: false, errors: [output] }
  }
}

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

  // 2. テスト実行（テストファイルがあり、テスト環境が整っている場合）
  let testsPassed: boolean | undefined
  let testErrors: string[] | undefined

  if (recipe.tech_stack?.test && filesExist) {
    const testFiles = generatedFiles.filter(f =>
      f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__')
    )

    // node_modules が存在するか確認（テスト実行に必要）
    let hasNodeModules = false
    try {
      await access(join(state.working_dir, 'node_modules'))
      hasNodeModules = true
    } catch {
      // node_modules なし → テスト実行をスキップ
    }

    if (testFiles.length > 0 && hasNodeModules) {
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

  // 3. テスト品質静的検証（test-quality.md §4.1 の v0.1 項目）
  let testQualityPassed: boolean | undefined
  let testQualityIssues: string[] | undefined

  if (filesExist) {
    const testFiles = generatedFiles.filter(f =>
      f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__')
    )
    if (testFiles.length > 0) {
      const requirements = chunk.test_requirements ?? {
        interface_tests: [],
        boundary_tests: [],
        integration_refs: [],
      }
      const qualityResult = await checkTestQuality(
        testFiles,
        state.working_dir,
        requirements
      )
      testQualityPassed = qualityResult.passed
      testQualityIssues = qualityResult.issues.length > 0 ? qualityResult.issues : undefined
    }
  }

  // 4. 規約適合性検証（coding_standards.scripts.lint / format が定義されていれば実行）
  let lintPassed: boolean | undefined
  let lintErrors: string[] | undefined
  let formatPassed: boolean | undefined
  let formatErrors: string[] | undefined

  if (recipe.coding_standards?.scripts && filesExist) {
    const lintCmd = recipe.coding_standards.scripts.lint
    if (lintCmd) {
      const r = await runStandardScript(lintCmd, state.working_dir)
      lintPassed = r.passed
      lintErrors = r.errors
    }
    const formatCmd = recipe.coding_standards.scripts.format
    if (formatCmd) {
      const r = await runStandardScript(formatCmd, state.working_dir)
      formatPassed = r.passed
      formatErrors = r.errors
    }
  }

  // 5. 完了判定（規約違反・テスト品質不足は失敗扱い）
  const success =
    filesExist &&
    (testsPassed === undefined || testsPassed) &&
    (testQualityPassed === undefined || testQualityPassed) &&
    (lintPassed === undefined || lintPassed) &&
    (formatPassed === undefined || formatPassed)

  // 6. 状態更新
  chunkState.status = success ? 'done' : 'failed'
  chunkState.completed_at = new Date().toISOString()
  chunkState.outputs = generatedFiles
  if (!success) {
    chunkState.retry_count += 1
    const errorParts: string[] = []
    if (missingFiles.length > 0) errorParts.push(`Missing files: ${missingFiles.join(', ')}`)
    if (testErrors?.length) errorParts.push(`Tests failed: ${testErrors.join('\n')}`)
    if (testQualityPassed === false && testQualityIssues?.length) {
      errorParts.push(`Test quality: ${testQualityIssues.join('; ')}`)
    }
    if (lintErrors?.length) errorParts.push(`Lint failed: ${lintErrors.join('\n')}`)
    if (formatErrors?.length) errorParts.push(`Format failed: ${formatErrors.join('\n')}`)
    chunkState.error = errorParts.join('\n') || 'Unknown error'
  }

  // 7. 後続チャンクのアンロック確認
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
      lint_passed: lintPassed,
      lint_errors: lintErrors,
      format_passed: formatPassed,
      format_errors: formatErrors,
      test_quality_issues: testQualityIssues,
    },
    newly_unblocked: newlyUnblocked,
  }
}
