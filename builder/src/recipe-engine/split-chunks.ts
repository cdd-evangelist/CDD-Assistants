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
  TestRequirements,
} from '../types.js'

// --- 実装レイヤーマッピング ---

type ImplLayer = 'data' | 'logic' | 'interface' | 'test' | 'skip'

const LAYER_TO_IMPL: Record<DocLayer, ImplLayer> = {
  foundation: 'data',
  specification: 'logic',
  usecase: 'skip',       // 実装対象外（検証基準として参照）
  interface: 'interface',
  operation: 'test',
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

// --- status フィルタ（Step 0） ---

/**
 * frontmatter.status による入力選別。
 * - draft:    除外 + 警告（review_notes に記録）
 * - archived: 除外（警告なし）
 * - その他:    含める
 */
function filterByStatus(
  docs: DocumentAnalysis[],
  reviewNotes: string[],
): DocumentAnalysis[] {
  const kept: DocumentAnalysis[] = []
  for (const doc of docs) {
    const status = doc.frontmatter?.status
    if (status === 'draft') {
      reviewNotes.push(
        `${doc.path}: status: draft のため実装対象から除外。レビューして status を更新してください`,
      )
      continue
    }
    if (status === 'archived') {
      continue // 意図的廃止。警告なし
    }
    kept.push(doc)
  }
  return kept
}

// --- test_requirements 抽出 ---

const INTERFACE_KEYWORDS = [
  'API', 'api', 'インターフェース', 'interface',
  '入力', '出力', 'メソッド', '関数',
  'ツール', 'コマンド', 'エンドポイント',
  'スキーマ', 'テーブル定義', '型定義',
]

const BOUNDARY_KEYWORDS = [
  'エラー', '異常', '境界', '例外',
  '制約', '失敗', 'バリデーション', 'validation',
  'エッジ', 'タイムアウト', 'リトライ',
]

function classifySections(sections: string[]): {
  interface_tests: string[]
  boundary_tests: string[]
} {
  const interfaceTests: string[] = []
  const boundaryTests: string[] = []

  for (const section of sections) {
    const hasBoundaryKw = BOUNDARY_KEYWORDS.some(kw => section.includes(kw))
    if (hasBoundaryKw) {
      boundaryTests.push(`「${section}」の観点で異常系・境界値を検証`)
      continue // boundary 優先、interface にも分類しない
    }
    const hasInterfaceKw = INTERFACE_KEYWORDS.some(kw => section.includes(kw))
    if (hasInterfaceKw) {
      interfaceTests.push(`「${section}」に記載された仕様を検証`)
    }
  }

  return { interface_tests: interfaceTests, boundary_tests: boundaryTests }
}

function initialTestRequirements(sections: string[]): TestRequirements {
  const { interface_tests, boundary_tests } = classifySections(sections)
  return {
    interface_tests,
    boundary_tests,
    integration_refs: [], // depends_on 解決後に埋める
  }
}

function fillIntegrationRefs(chunks: DraftChunk[]): void {
  for (const chunk of chunks) {
    if (chunk.is_integration_test) continue // 統合テストチャンク自身はスキップ
    const refs: string[] = []
    for (const depId of chunk.depends_on) {
      const dep = chunks.find(c => c.id === depId)
      if (!dep) continue
      refs.push(`${dep.name} の出力が正しく消費されること`)
    }
    chunk.test_requirements.integration_refs = refs
  }
}

// --- 統合テストチャンク挿入（Step 4） ---

function createIntegrationChunk(
  id: string,
  name: string,
  description: string,
  dependsOn: string[],
  integrationRefs: string[],
): DraftChunk {
  return {
    id,
    name,
    description,
    depends_on: dependsOn,
    source_docs: [],
    implementation_prompt_template:
      `(統合テストチャンク: Test Agent が depends_on の既存実装に対してテストを生成・実行してください。Red フェーズはスキップ)`,
    expected_outputs: [],
    completion_criteria: ['test_requirements の全項目が既存実装に対して PASS する'],
    test_requirements: {
      interface_tests: [],
      boundary_tests: [],
      integration_refs: integrationRefs,
    },
    reference_doc: `docs/ref/${id}-${name.replace(/[^a-zA-Z0-9　-鿿]/g, '-')}.md`,
    estimated_input_tokens: 1000,
    estimated_output_tokens: 1500,
    is_integration_test: true,
  }
}

/**
 * chunk-splitting.md §5 に従って統合テストチャンクを挿入する:
 *   1. 依存合流点（3チャンク以上が1チャンクに合流）
 *   2. レイヤー境界（data → logic / logic → interface 等）
 *   3. 最終位置（E2E）
 *
 * 重複挿入を避けるため、同じ depends_on セットに対しては1つだけ挿入する。
 */
function insertIntegrationChunks(
  chunks: DraftChunk[],
  candidateMap: Map<string, { implLayer: ImplLayer; docPath: string }>,
): DraftChunk[] {
  const integrationChunks: DraftChunk[] = []
  const seenDepSets = new Set<string>()
  let nextIdx = chunks.length + 1
  const nextId = () => `chunk-${String(nextIdx++).padStart(2, '0')}-integration`

  const keyOf = (deps: string[]) => [...deps].sort().join(',')

  // 1. 依存合流点: depends_on に 3 つ以上あるチャンクを検出
  for (const chunk of chunks) {
    if (chunk.depends_on.length >= 3) {
      const key = keyOf([chunk.id])
      if (seenDepSets.has(key)) continue
      seenDepSets.add(key)
      integrationChunks.push(
        createIntegrationChunk(
          nextId(),
          `${chunk.name}-合流統合テスト`,
          `${chunk.name} における ${chunk.depends_on.length} チャンクの合流の接続検証`,
          [chunk.id],
          chunk.depends_on.map(depId => {
            const dep = chunks.find(c => c.id === depId)
            return dep ? `${dep.name} の出力が ${chunk.name} で正しく連携する` : ''
          }).filter(s => s !== ''),
        ),
      )
    }
  }

  // 2. レイヤー境界: 各レイヤー最後のチャンク群を depends_on とする統合テスト
  const layerChunks = new Map<ImplLayer, string[]>()
  for (const chunk of chunks) {
    const info = candidateMap.get(chunk.id)
    if (!info) continue
    const list = layerChunks.get(info.implLayer) ?? []
    list.push(chunk.id)
    layerChunks.set(info.implLayer, list)
  }

  for (let i = 0; i < IMPL_LAYER_ORDER.length - 1; i++) {
    const lowerLayer = IMPL_LAYER_ORDER[i]
    const upperLayer = IMPL_LAYER_ORDER[i + 1]
    const lowerChunks = layerChunks.get(lowerLayer) ?? []
    const upperChunks = layerChunks.get(upperLayer) ?? []
    if (lowerChunks.length === 0 || upperChunks.length === 0) continue

    const depSet = [...lowerChunks, ...upperChunks].sort()
    const key = keyOf(depSet)
    if (seenDepSets.has(key)) continue
    seenDepSets.add(key)

    integrationChunks.push(
      createIntegrationChunk(
        nextId(),
        `${lowerLayer}-${upperLayer}-境界統合テスト`,
        `${lowerLayer} レイヤーの出力を ${upperLayer} レイヤーが正しく消費する接続検証`,
        depSet,
        [`${lowerLayer} レイヤーの出力が ${upperLayer} レイヤーで正しく消費されること`],
      ),
    )
  }

  // 3. 最終位置（E2E）: 全ての非統合チャンクに依存
  const allChunkIds = chunks.map(c => c.id).sort()
  if (allChunkIds.length > 0) {
    const key = keyOf(allChunkIds)
    if (!seenDepSets.has(key)) {
      seenDepSets.add(key)
      integrationChunks.push(
        createIntegrationChunk(
          nextId(),
          'E2E統合テスト',
          '主要ユースケースの一気通貫実行検証',
          allChunkIds,
          ['主要ユースケースが end-to-end で動作すること'],
        ),
      )
    }
  }

  return [...chunks, ...integrationChunks]
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

  // 0. status による入力選別（draft/archived を除外）
  const activeDocs = filterByStatus(analysis.documents, reviewNotes)

  // 1. 実装対象の文書をレイヤーでグループ化
  const implGroups = new Map<ImplLayer, DocumentAnalysis[]>()
  for (const doc of activeDocs) {
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
      activeDocs, // status で選別済みの文書のみを validation_context のソースに使う
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

    // test_requirements 初期生成（integration_refs は depends_on 解決後に埋める）
    const sourceDoc = activeDocs.find(d => d.path === candidate.docPath)
    const testRequirements = initialTestRequirements(sourceDoc?.sections ?? [])

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
      test_requirements: testRequirements,
      is_integration_test: false,
      reference_doc: `docs/ref/${id}-${candidate.name.replace(/[^a-zA-Z0-9\u3000-\u9fff]/g, '-')}.md`,
      validation_context: validationContext,
      estimated_input_tokens: candidate.estimatedInputTokens,
      estimated_output_tokens: estOutputTokens,
    }
  })

  // 4. 依存関係を設定
  assignDependencies(draftChunks, analysis, candidateMap)

  // 4.5 integration_refs を depends_on に基づいて充填
  fillIntegrationRefs(draftChunks)

  // 4.6 統合テストチャンクを自動挿入（合流点・レイヤー境界・最終位置）
  const allChunks = insertIntegrationChunks(draftChunks, candidateMap)

  // 5. execution_order を算出（統合テストチャンク込み）
  const executionOrder = computeExecutionOrder(allChunks)

  // 6. レビューフラグ
  // expected_outputs が空 → 必ずレビュー必要
  const needsReview = true // 常に要レビュー（expected_outputs, implementation_prompt_template は汎用テンプレート）
  reviewNotes.push(
    '各チャンクの expected_outputs を設定してください',
    '各チャンクの implementation_prompt_template を具体化してください',
    '各チャンクの completion_criteria を具体化してください',
  )

  return {
    chunks: allChunks,
    execution_order: executionOrder,
    needs_review: needsReview,
    review_notes: reviewNotes,
  }
}
