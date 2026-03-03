// ============================================================
// CDD-Builder 型定義
// ============================================================

// --- レシピ ---

export interface Recipe {
  project: string
  created_at: string
  builder_version: string
  tech_stack: TechStack
  chunks: Chunk[]
  execution_order: string[][] // DAG のレベル順。同一レベルは並列可能
}

export interface TechStack {
  language: string
  runtime?: string
  db?: string
  test?: string
  platforms?: string[]
  platform_notes?: string
  directory_structure?: string
}

export interface Chunk {
  id: string
  name: string
  description: string
  depends_on: string[]
  source_docs: SourceDoc[]
  source_content: string // プレースホルダ含む（{{file:path}} 形式）
  implementation_prompt: string
  expected_outputs: string[]
  completion_criteria: string[]
  validation_context?: string
  estimated_input_tokens: number
  estimated_output_tokens: number
}

export interface SourceDoc {
  path: string
  sections: string[]
  include: 'full' | 'partial'
}

// --- レシピエンジン ---

/** split_chunks → export_recipe へ渡すチャンク定義（source_content 未解決） */
export interface DraftChunk {
  id: string
  name: string
  description: string
  depends_on: string[]
  source_docs: SourceDoc[]
  implementation_prompt_template: string // {source_content} と {{file:path}} を含むテンプレート
  expected_outputs: string[]
  completion_criteria: string[]
  validation_context?: string
  estimated_input_tokens: number
  estimated_output_tokens: number
}

export interface ExportRecipeInput {
  project: string
  tech_stack: TechStack
  chunks: DraftChunk[]
  docs_dir: string       // source_docs のパス解決用ベースディレクトリ
  output_path: string
  include_source_content?: boolean // デフォルト true
}

export interface ExportRecipeResult {
  recipe_path: string
  total_chunks: number
  execution_order: string[][]
  warnings: string[]
}

/** Planner が付与する YAML フロントマター */
export interface DocFrontmatter {
  status?: string            // e.g. "confirmed", "draft"
  layer?: DocLayer
  decisions?: string[]       // 関連する決定事項ID
  open_questions?: string[]
}

export type DocLayer =
  | 'foundation'     // 基本設計、アーキテクチャ、データモデル
  | 'specification'  // 詳細仕様、プロトコル
  | 'usecase'        // ユースケース（UC-*, AC-*）
  | 'interface'      // API、CLI、MCPツール
  | 'execution'      // 運用、デプロイ、ベンチマーク
  | 'context'        // 比較、TODO、参考資料

/** decisions.jsonl の各行 */
export interface Decision {
  id: string
  decision: string
  affected_docs: string[]
  decided_at: string
}

/** analyze_design の出力 */
export interface AnalyzeDesignResult {
  project_name: string
  documents: DocumentAnalysis[]
  dependency_graph: Record<string, string[]> // doc → [referenced docs]
  layers: Record<DocLayer, string[]>
  tech_stack: Partial<TechStack>
  total_tokens: number
}

export interface DocumentAnalysis {
  path: string
  lines: number
  estimated_tokens: number
  layer: DocLayer
  sections: string[]
  references_to: string[]   // この文書が参照する文書
  referenced_by: string[]   // この文書を参照する文書
  frontmatter?: DocFrontmatter
}

export interface SplitChunksInput {
  analysis: AnalyzeDesignResult
  strategy?: 'bottom_up'    // 現状は bottom_up のみ
  constraints?: {
    max_input_tokens?: number    // デフォルト 8000
    max_output_tokens?: number   // デフォルト 12000
    max_source_docs?: number     // デフォルト 2
    max_output_files?: number    // デフォルト 5
  }
  docs_dir: string  // 文書読み込み用ベースディレクトリ
}

export interface SplitChunksResult {
  chunks: DraftChunk[]
  execution_order: string[][]
  needs_review: boolean    // 判断が必要な箇所がある場合 true
  review_notes: string[]   // 要レビュー箇所の説明
}

// --- 実行状態 ---

export type ChunkStatus = 'pending' | 'in_progress' | 'done' | 'failed'

export interface ChunkState {
  status: ChunkStatus
  started_at: string | null
  completed_at: string | null
  outputs: string[] // 実際に生成されたファイルパス
  retry_count: number
  error?: string
}

export interface ExecutionState {
  recipe_path: string
  working_dir: string
  started_at: string
  chunks: Record<string, ChunkState>
}

// --- 実行アダプタ ---

export interface PreparedChunk {
  id: string
  name: string
  implementation_prompt: string // プレースホルダ解決済み
  expected_outputs: string[]
  completion_criteria: string[]
  working_dir: string
}

export interface ExecutionResult {
  success: boolean
  generated_files: string[]
  error?: string
}

export interface ChunkExecutor {
  execute(chunk: PreparedChunk): Promise<ExecutionResult>
}

// --- ツール出力 ---

export interface LoadRecipeResult {
  project: string
  total_chunks: number
  ready_chunks: string[]
  execution_state_path: string
}

export interface NextChunksResult {
  ready: PreparedChunk[]
  blocked: string[]
  done: string[]
  failed: string[]
  progress: string
}

export interface CompleteChunkResult {
  chunk_id: string
  status: 'done' | 'failed'
  verification: {
    files_exist: boolean
    missing_files?: string[]
    tests_passed?: boolean
    test_errors?: string[]
    criteria_met?: string[]
  }
  newly_unblocked: string[]
}

export interface ExecutionStatusResult {
  progress: {
    done: number
    in_progress: number
    pending: number
    failed: number
    blocked: number
    total: number
  }
  chunks: Array<{
    id: string
    name: string
    status: ChunkStatus
    blocked_by?: string[]
    retry_count?: number
  }>
  current_level: number
  estimated_remaining: string
}
