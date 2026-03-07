import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import type {
  SplitChunksInput,
  SplitChunksResult,
  DraftChunk,
  AnalyzeDesignResult,
  DocumentAnalysis,
  DocLayer,
  SourceDoc,
} from '../types.js'

// --- 実装レイヤーマッピング ---

type ImplLayer = 'data' | 'logic' | 'interface' | 'test' | 'skip'

const LAYER_TO_IMPL: Record<DocLayer, ImplLayer> = {
  foundation: 'data',
  specification: 'logic',
  usecase: 'skip',       // 実装対象外（検証基準として参照）
  interface: 'interface',
  execution: 'test',
  context: 'skip',       // 実装対象外
}

/** 実装レイヤーの優先順（依存方向：data → logic → interface → test） */
const IMPL_LAYER_ORDER: ImplLayer[] = ['data', 'logic', 'interface', 'test']

// --- セクション分析 ---

interface SectionInfo {
  title: string
  level: number
  startLine: number
  endLine: number
  estimatedTokens: number
}

function analyzeSections(content: string): SectionInfo[] {
  const lines = content.split('\n')
  const sections: SectionInfo[] = []

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/)
    if (match) {
      sections.push({
        title: match[2].trim(),
        level: match[1].length,
        startLine: i,
        endLine: lines.length - 1, // 仮値
        estimatedTokens: 0,
      })
    }
  }

  // 各セクションの終了行とトークン数を算出
  for (let i = 0; i < sections.length; i++) {
    const end = i + 1 < sections.length && sections[i + 1].level <= sections[i].level
      ? sections[i + 1].startLine - 1
      : (i + 1 < sections.length ? sections[i + 1].startLine - 1 : lines.length - 1)
    sections[i].endLine = end

    const sectionText = lines.slice(sections[i].startLine, end + 1).join('\n')
    sections[i].estimatedTokens = estimateTokens(sectionText)
  }

  return sections
}

function estimateTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff]/.test(char)) {
      tokens += 2
    } else {
      tokens += 0.25
    }
  }
  return Math.ceil(tokens)
}

// --- チャンク生成 ---

interface ChunkCandidate {
  name: string
  description: string
  sourceDocs: SourceDoc[]
  estimatedInputTokens: number
  implLayer: ImplLayer
  docPath: string
  validationDocs: string[] // 関連ユースケース文書
}

/**
 * 文書グループからチャンク候補を生成する。
 * 1文書 = 1チャンクを基本とし、トークン上限超過時は分割する。
 */
function generateCandidates(
  docs: DocumentAnalysis[],
  allDocs: DocumentAnalysis[],
  implLayer: ImplLayer,
  maxInputTokens: number,
): ChunkCandidate[] {
  const candidates: ChunkCandidate[] = []

  // ユースケース文書を特定（validation_context 用）
  const usecaseDocs = allDocs
    .filter(d => d.layer === 'usecase')
    .map(d => d.path)

  for (const doc of docs) {
    if (doc.estimated_tokens <= maxInputTokens) {
      // そのまま1チャンク
      candidates.push({
        name: doc.path.replace('.md', ''),
        description: `${doc.path} の実装`,
        sourceDocs: [{
          path: doc.path,
          sections: ['全体'],
          include: doc.estimated_tokens <= maxInputTokens / 2 ? 'full' : 'partial',
        }],
        estimatedInputTokens: doc.estimated_tokens,
        implLayer,
        docPath: doc.path,
        validationDocs: findRelatedUsecases(doc, allDocs, usecaseDocs),
      })
    } else {
      // トークン上限超過: トップレベルセクションで分割
      // ※ 実際のセクション分析は docs_dir が必要なので、ここでは分割フラグだけ立てる
      candidates.push({
        name: doc.path.replace('.md', ''),
        description: `${doc.path} の実装（大規模: 要レビュー）`,
        sourceDocs: [{
          path: doc.path,
          sections: doc.sections.length > 0 ? doc.sections : ['全体'],
          include: 'partial',
        }],
        estimatedInputTokens: doc.estimated_tokens,
        implLayer,
        docPath: doc.path,
        validationDocs: findRelatedUsecases(doc, allDocs, usecaseDocs),
      })
    }
  }

  return candidates
}

/** 文書に関連するユースケースを探す */
function findRelatedUsecases(
  doc: DocumentAnalysis,
  allDocs: DocumentAnalysis[],
  usecaseDocs: string[],
): string[] {
  const related: string[] = []

  // この文書を参照しているユースケース
  for (const refBy of doc.referenced_by) {
    if (usecaseDocs.includes(refBy)) {
      related.push(refBy)
    }
  }

  // この文書が参照しているユースケース
  for (const refTo of doc.references_to) {
    if (usecaseDocs.includes(refTo) && !related.includes(refTo)) {
      related.push(refTo)
    }
  }

  return related
}

// --- 依存関係の決定 ---

function assignDependencies(
  chunks: DraftChunk[],
  analysis: AnalyzeDesignResult,
  candidateMap: Map<string, { implLayer: ImplLayer; docPath: string }>,
): void {
  // 実装レイヤー間の依存: data → logic → interface → test
  const layerChunks = new Map<ImplLayer, string[]>()
  for (const chunk of chunks) {
    const info = candidateMap.get(chunk.id)!
    const list = layerChunks.get(info.implLayer) ?? []
    list.push(chunk.id)
    layerChunks.set(info.implLayer, list)
  }

  // レイヤー間の依存
  for (let i = 1; i < IMPL_LAYER_ORDER.length; i++) {
    const currentLayer = IMPL_LAYER_ORDER[i]
    const prevLayer = IMPL_LAYER_ORDER[i - 1]
    const currentChunks = layerChunks.get(currentLayer) ?? []
    const prevChunks = layerChunks.get(prevLayer) ?? []

    if (prevChunks.length > 0) {
      for (const chunkId of currentChunks) {
        const chunk = chunks.find(c => c.id === chunkId)!
        // 前のレイヤーのすべてのチャンクに依存（保守的）
        chunk.depends_on = [...new Set([...chunk.depends_on, ...prevChunks])]
      }
    }
  }

  // 文書間の直接依存（wiki-link）も反映
  for (const chunk of chunks) {
    const info = candidateMap.get(chunk.id)!
    const docAnalysis = analysis.documents.find(d => d.path === info.docPath)
    if (!docAnalysis) continue

    for (const refTo of docAnalysis.references_to) {
      // 参照先の文書を含むチャンクを探す
      for (const other of chunks) {
        if (other.id === chunk.id) continue
        const otherInfo = candidateMap.get(other.id)!
        if (otherInfo.docPath === refTo && !chunk.depends_on.includes(other.id)) {
          // 同一レイヤー or 下位レイヤーへの参照のみ依存に追加
          const chunkLayerIdx = IMPL_LAYER_ORDER.indexOf(info.implLayer)
          const otherLayerIdx = IMPL_LAYER_ORDER.indexOf(otherInfo.implLayer)
          if (otherLayerIdx <= chunkLayerIdx) {
            chunk.depends_on.push(other.id)
          }
        }
      }
    }
  }
}

// --- execution_order 算出 ---

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
      levels.push([...remaining])
      break
    }

    level.sort()
    levels.push(level)
    for (const id of level) {
      remaining.delete(id)
      done.add(id)
    }
  }

  return levels
}

// --- メイン ---

const DEFAULT_CONSTRAINTS = {
  max_input_tokens: 8000,
  max_output_tokens: 12000,
  max_source_docs: 2,
  max_output_files: 5,
}

export async function splitChunks(input: SplitChunksInput): Promise<SplitChunksResult> {
  const { analysis, constraints: userConstraints } = input
  const constraints = { ...DEFAULT_CONSTRAINTS, ...userConstraints }
  const reviewNotes: string[] = []

  // 1. 実装対象の文書をレイヤーでグループ化
  const implGroups = new Map<ImplLayer, DocumentAnalysis[]>()
  for (const doc of analysis.documents) {
    const implLayer = LAYER_TO_IMPL[doc.layer]
    if (implLayer === 'skip') continue

    const list = implGroups.get(implLayer) ?? []
    list.push(doc)
    implGroups.set(implLayer, list)
  }

  // 2. 各グループからチャンク候補を生成
  const allCandidates: ChunkCandidate[] = []
  for (const [implLayer, docs] of implGroups) {
    const candidates = generateCandidates(
      docs,
      analysis.documents,
      implLayer,
      constraints.max_input_tokens,
    )
    allCandidates.push(...candidates)
  }

  if (allCandidates.length === 0) {
    return {
      chunks: [],
      execution_order: [],
      needs_review: true,
      review_notes: ['実装対象の文書が見つかりませんでした。設計文書のレイヤー分類を確認してください。'],
    }
  }

  // 3. DraftChunk に変換
  const candidateMap = new Map<string, { implLayer: ImplLayer; docPath: string }>()
  const draftChunks: DraftChunk[] = allCandidates.map((candidate, i) => {
    const id = `chunk-${String(i + 1).padStart(2, '0')}`
    candidateMap.set(id, { implLayer: candidate.implLayer, docPath: candidate.docPath })

    // 推定出力トークン（入力の 1.5 倍、上限あり）
    const estOutputTokens = Math.min(
      Math.ceil(candidate.estimatedInputTokens * 1.5),
      constraints.max_output_tokens,
    )

    // source_docs の制約チェック
    if (candidate.sourceDocs.length > constraints.max_source_docs) {
      reviewNotes.push(`${id} (${candidate.name}): 参照文書が ${candidate.sourceDocs.length} 本で制約 (${constraints.max_source_docs}) を超過`)
    }

    // トークン上限チェック
    if (candidate.estimatedInputTokens > constraints.max_input_tokens) {
      reviewNotes.push(`${id} (${candidate.name}): 推定入力トークン ${candidate.estimatedInputTokens} が制約 (${constraints.max_input_tokens}) を超過。分割を検討してください`)
    }

    // validation_context の生成
    const validationContext = candidate.validationDocs.length > 0
      ? `関連ユースケース: ${candidate.validationDocs.join(', ')}`
      : undefined

    return {
      id,
      name: candidate.name,
      description: candidate.description,
      depends_on: [], // 後で設定
      source_docs: candidate.sourceDocs,
      implementation_prompt_template:
        `以下の設計に基づき、${candidate.name} を実装してください。\n\n{source_content}`,
      expected_outputs: [], // 機械的に決定困難 → 要レビュー
      completion_criteria: ['テストが通る'],
      reference_doc: `docs/ref/${id}-${candidate.name.replace(/[^a-zA-Z0-9\u3000-\u9fff]/g, '-')}.md`,
      validation_context: validationContext,
      estimated_input_tokens: candidate.estimatedInputTokens,
      estimated_output_tokens: estOutputTokens,
    }
  })

  // 4. 依存関係を設定
  assignDependencies(draftChunks, analysis, candidateMap)

  // 5. execution_order を算出
  const executionOrder = computeExecutionOrder(draftChunks)

  // 6. レビューフラグ
  // expected_outputs が空 → 必ずレビュー必要
  const needsReview = true // 常に要レビュー（expected_outputs, implementation_prompt_template は汎用テンプレート）
  reviewNotes.push(
    '各チャンクの expected_outputs を設定してください',
    '各チャンクの implementation_prompt_template を具体化してください',
    '各チャンクの completion_criteria を具体化してください',
  )

  return {
    chunks: draftChunks,
    execution_order: executionOrder,
    needs_review: needsReview,
    review_notes: reviewNotes,
  }
}
