import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import type {
  ExportRecipeInput,
  ExportRecipeResult,
  Recipe,
  Chunk,
  DraftChunk,
  SourceDoc,
} from '../types.js'

const BUILDER_VERSION = '0.1.0'

/**
 * Markdown 文書から指定セクションを抽出する。
 * 見出しレベルを考慮し、セクションの末尾（次の同レベル以上の見出し）まで取得する。
 */
export function extractSections(content: string, sectionNames: string[]): string {
  const lines = content.split('\n')
  const extracted: string[] = []

  for (const sectionName of sectionNames) {
    // 見出し行を探す（## 3. データベーススキーマ → sectionName = "3. データベーススキーマ"）
    let found = false
    for (let i = 0; i < lines.length; i++) {
      const headingMatch = lines[i].match(/^(#{1,6})\s+(.+)/)
      if (!headingMatch) continue

      const level = headingMatch[1].length
      const title = headingMatch[2].trim()

      if (title === sectionName || title.startsWith(sectionName)) {
        found = true
        // このセクションの末尾を探す
        const sectionLines = [lines[i]]
        for (let j = i + 1; j < lines.length; j++) {
          const nextHeading = lines[j].match(/^(#{1,6})\s/)
          if (nextHeading && nextHeading[1].length <= level) {
            break
          }
          sectionLines.push(lines[j])
        }
        extracted.push(sectionLines.join('\n').trimEnd())
        break
      }
    }

    if (!found) {
      extracted.push(`<!-- セクション "${sectionName}" が見つかりませんでした -->`)
    }
  }

  return extracted.join('\n\n')
}

/**
 * source_docs からコンテンツを読み込み、source_content を生成する。
 */
async function resolveSourceContent(
  sourceDocs: SourceDoc[],
  docsDir: string,
  includeContent: boolean,
): Promise<{ content: string; warnings: string[] }> {
  if (!includeContent) {
    return {
      content: sourceDocs.map(d =>
        `（参照: ${d.path} / セクション: ${d.sections.join(', ')}）`
      ).join('\n'),
      warnings: [],
    }
  }

  const parts: string[] = []
  const warnings: string[] = []

  for (const doc of sourceDocs) {
    const docPath = resolve(docsDir, doc.path)
    let fileContent: string
    try {
      fileContent = await readFile(docPath, 'utf-8')
    } catch {
      warnings.push(`${doc.path} が読み込めません`)
      parts.push(`<!-- ${doc.path} が見つかりませんでした -->`)
      continue
    }

    if (doc.include === 'full') {
      parts.push(fileContent.trimEnd())
    } else {
      // partial: 指定セクションを抽出
      if (doc.sections.length === 1 && doc.sections[0] === '全体') {
        parts.push(fileContent.trimEnd())
      } else {
        const extracted = extractSections(fileContent, doc.sections)
        parts.push(extracted)
      }
    }
  }

  return { content: parts.join('\n\n'), warnings }
}

/**
 * DraftChunk の depends_on グラフから execution_order（トポロジカル順のレベル分け）を算出する。
 */
function computeExecutionOrder(chunks: DraftChunk[]): string[][] {
  const remaining = new Set(chunks.map(c => c.id))
  const done = new Set<string>()
  const levels: string[][] = []

  while (remaining.size > 0) {
    const level: string[] = []
    for (const id of remaining) {
      const chunk = chunks.find(c => c.id === id)!
      const allDepsDone = chunk.depends_on.every(dep => done.has(dep))
      if (allDepsDone) {
        level.push(id)
      }
    }

    if (level.length === 0) {
      // 循環依存 → 残りを最後のレベルに押し込む（警告付き）
      levels.push([...remaining])
      break
    }

    level.sort() // 安定したID順
    levels.push(level)
    for (const id of level) {
      remaining.delete(id)
      done.add(id)
    }
  }

  return levels
}

/**
 * split_chunks の出力をレシピファイルとしてエクスポートする。
 */
export async function exportRecipe(input: ExportRecipeInput): Promise<ExportRecipeResult> {
  const {
    project,
    tech_stack,
    chunks: draftChunks,
    docs_dir: docsDir,
    output_path: outputPath,
    include_source_content = true,
  } = input

  const allWarnings: string[] = []
  const resolvedChunks: Chunk[] = []

  for (const draft of draftChunks) {
    // source_docs から source_content を解決
    const { content: sourceContent, warnings } = await resolveSourceContent(
      draft.source_docs,
      docsDir,
      include_source_content,
    )
    allWarnings.push(...warnings)

    // implementation_prompt テンプレートの {source_content} を置換
    const implementationPrompt = draft.implementation_prompt_template
      .replace('{source_content}', sourceContent)

    resolvedChunks.push({
      id: draft.id,
      name: draft.name,
      description: draft.description,
      depends_on: draft.depends_on,
      source_docs: draft.source_docs,
      source_content: sourceContent,
      implementation_prompt: implementationPrompt,
      expected_outputs: draft.expected_outputs,
      completion_criteria: draft.completion_criteria,
      reference_doc: draft.reference_doc,
      validation_context: draft.validation_context,
      estimated_input_tokens: draft.estimated_input_tokens,
      estimated_output_tokens: draft.estimated_output_tokens,
    })
  }

  // 実行順序を算出
  const executionOrder = computeExecutionOrder(draftChunks)

  const recipe: Recipe = {
    project,
    created_at: new Date().toISOString(),
    builder_version: BUILDER_VERSION,
    tech_stack,
    chunks: resolvedChunks,
    execution_order: executionOrder,
  }

  // 出力
  const absOutputPath = resolve(outputPath)
  await writeFile(absOutputPath, JSON.stringify(recipe, null, 2), 'utf-8')

  return {
    recipe_path: absOutputPath,
    total_chunks: resolvedChunks.length,
    execution_order: executionOrder,
    warnings: allWarnings,
  }
}
