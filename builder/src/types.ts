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
