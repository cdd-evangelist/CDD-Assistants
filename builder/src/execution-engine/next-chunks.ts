import { readFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import type { Recipe, ExecutionState, PreparedChunk, NextChunksResult, CodingStandards, TechStack } from '../types.js'

// --- コード規約ダイジェスト生成（coding-standards.md §4） ---

const LANGUAGE_FALLBACK: Record<string, string> = {
  TypeScript: 'TypeScript 標準のコーディング規約に従うこと（strict モード推奨、any 禁止）',
  JavaScript: 'JavaScript 標準のコーディング規約に従うこと',
  Python: 'PEP 8 に従うこと（型ヒント推奨）',
  Go: 'gofmt / golint の規約に従うこと',
  Rust: 'rustfmt の規約に従うこと',
}

/**
 * CodingStandards から Agent に読ませる短縮ダイジェストを生成する。
 * coding-standards.md §4 のフォーマットに従う。
 */
export function generateCodingStandardsDigest(
  codingStandards: CodingStandards | null,
  techStack: TechStack,
): string {
  const lines: string[] = ['--- コード規約（プロジェクト遵守） ---']

  if (!codingStandards) {
    // 言語慣例フォールバック
    const fallback = LANGUAGE_FALLBACK[techStack.language]
      ?? `${techStack.language} の標準的なコーディング規約に従うこと`
    lines.push(`- ${fallback}`)
    return lines.join('\n')
  }

  // 規約文書
  for (const doc of codingStandards.docs) {
    lines.push(`- ${doc} のルールに従うこと`)
  }

  // linter / formatter 設定
  if (codingStandards.linters.length > 0) {
    lines.push(`- 既存 linter 設定（${codingStandards.linters.join(', ')}）を遵守すること`)
  }

  // lint / format コマンド
  const commands: string[] = []
  if (codingStandards.scripts.lint)   commands.push(codingStandards.scripts.lint)
  if (codingStandards.scripts.format) commands.push(codingStandards.scripts.format)
  if (commands.length > 0) {
    lines.push(`- 実装完了後、以下のコマンドが通ること: ${commands.join(' && ')}`)
  }

  return lines.join('\n')
}

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

  // coding_standards_digest を事前に生成（全チャンク共通）
  const digest = generateCodingStandardsDigest(recipe.coding_standards, recipe.tech_stack)

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

    // 統合テストチャンクにはダイジェストを注入しない（実装プロンプトを持たないため）
    const basePrompt = resolvedPrompt.replace('{source_content}', resolvedContent)
    const finalPrompt = chunk.is_integration_test
      ? basePrompt
      : `${basePrompt}\n\n${digest}`

    ready.push({
      id: chunk.id,
      name: chunk.name,
      implementation_prompt: finalPrompt,
      expected_outputs: chunk.expected_outputs,
      completion_criteria: chunk.completion_criteria,
      test_requirements: chunk.test_requirements,
      reference_doc: chunk.reference_doc,
      working_dir: state.working_dir,
      coding_standards_digest: chunk.is_integration_test ? undefined : digest,
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
