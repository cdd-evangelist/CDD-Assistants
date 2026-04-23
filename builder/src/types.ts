// ============================================================
// CDD-Builder 型定義
// ============================================================

// --- レシピ ---

export interface Recipe {
  project: string
  created_at: string
  builder_version: string
  tech_stack: TechStack
  coding_standards: CodingStandards | null
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

/**
 * チャンクに紐づくテスト観点。設計文書から抽出し、Test Agent が生成するテストの
 * 網羅性の基準として使う。
 */
export interface TestRequirements {
  interface_tests: string[]     // 設計文書に記載された入出力・公開 API の動作検証
  boundary_tests: string[]      // エラーケース・境界値・異常系の検証
  integration_refs: string[]    // depends_on チャンクとの接続検証
}

/**
 * プロジェクトのコード規約情報。analyze_design が検出し、next_chunks が
 * ダイジェストを生成してプロンプトに注入する。未検出時は null。
 */
export interface CodingStandards {
  docs: string[]        // AGENTS.md / CODING-STANDARDS.md 等の規約文書
  linters: string[]     // .editorconfig / eslint.config.js / .prettierrc 等の設定ファイル
  scripts: {
    lint?: string
    format?: string
    test?: string
  }
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
  test_requirements: TestRequirements
  reference_doc: string // リファレンスドキュメントの出力先パス
  validation_context?: string
  estimated_input_tokens: number
  estimated_output_tokens: number
  is_integration_test: boolean // 統合テストチャンクのフラグ（chunk-splitting.md §5）
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
  test_requirements: TestRequirements
  reference_doc: string // リファレンスドキュメントの出力先パス
  validation_context?: string
  estimated_input_tokens: number
  estimated_output_tokens: number
  is_integration_test: boolean // 統合テストチャンクのフラグ（chunk-splitting.md §5）
}

export interface ExportRecipeInput {
  project: string
  tech_stack: TechStack
  coding_standards?: CodingStandards | null // analyze_design の結果から受け渡す
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
  | 'operation'      // 運用、ベンチマーク、操作フロー
  | 'context'        // 比較、TODO、参考資料

/**
 * 設計文書の階層（design-doc-standard.md §2 / §5）。
 * フォルダ構成から判定し、Builder の挙動を切り替える:
 *   - basic    : docs/ ルート (basic-design.md 等)。実装の参照のみ
 *   - feature  : 2-features/。実装の参照のみ
 *   - detail   : 3-details/。**この層のみが実装チャンクを生成する**
 *   - usecase  : 1-usecases/。validation_context として参照
 *   - reference: 4-ref/ や階層不明。チャンク化対象外
 */
export type DocTier =
  | 'basic'
  | 'feature'
  | 'detail'
  | 'usecase'
  | 'reference'

/** decisions.jsonl の各行 */
export interface Decision {
  id: string
  decision: string
  affected_docs: string[]
  decided_at: string
}

/** ドリフト検出の警告 */
export interface DriftWarning {
  reference: string        // リファレンスファイルパス
  commits_since: number    // リファレンス生成後のコミット数
  changed_files: string[]  // 変更されたファイル
  message: string          // 警告メッセージ
}

/** analyze_design の出力 */
export interface AnalyzeDesignResult {
  project_name: string
  drift_warnings: DriftWarning[]
  documents: DocumentAnalysis[]
  dependency_graph: Record<string, string[]> // doc → [referenced docs]
  layers: Record<DocLayer, string[]>
  tiers: Record<DocTier, string[]>           // 階層（basic / feature / detail / usecase / reference）
  tech_stack: Partial<TechStack>
  coding_standards: CodingStandards | null
  total_tokens: number
}

export interface DocumentAnalysis {
  path: string
  lines: number
  estimated_tokens: number
  layer: DocLayer
  tier: DocTier
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
  test_requirements: TestRequirements
  reference_doc: string // リファレンスドキュメントの出力先パス
  working_dir: string
  coding_standards_digest?: string // next_chunks がプロンプトに付加済み
}

export interface ExecutionResult {
  success: boolean
  generated_files: string[]
  reference_doc?: string // 生成されたリファレンスのパス
  error?: string
}

export interface TestGenerationResult {
  success: boolean
  test_files: string[]  // 生成されたテストファイルパス
  error?: string
}

export interface DivergenceReport {
  items: Array<{
    severity: 'critical' | 'update_needed' | 'minor'
    category: string     // '機能の欠落' | '型の不一致' | 'ロジックの矛盾' | '設計の進化' 等
    description: string
  }>
}

export interface Artifacts {
  design_doc: string    // 設計文書の該当セクション
  implementation: string[] // 実装ファイルパス
  tests: string[]       // テストファイルパス
  reference: string     // リファレンスのパス
}

export interface InvestigationResult {
  verdict: 'implementation' | 'design_ambiguity' | 'test_insufficient'
  reasoning: string     // 判定の根拠（人にエスカレーションする場合の説明）
  suggested_action: string // 次のアクションの提案
}

export interface ChunkExecutor {
  /** テスト生成（Red フェーズ）。設計文書と test_requirements のみをコンテキストに使う */
  generateTests(chunk: PreparedChunk): Promise<TestGenerationResult>

  /** 実装 + リファレンス生成（Green フェーズ）。テストコード + 設計文書をコンテキストに使う */
  implement(chunk: PreparedChunk, testFiles: string[]): Promise<ExecutionResult>

  /** 照合 NG 時の原因仕分け（Investigation フェーズ） */
  investigate(chunk: PreparedChunk, divergence: DivergenceReport, artifacts: Artifacts): Promise<InvestigationResult>
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
    lint_passed?: boolean             // coding_standards.scripts.lint の実行結果
    lint_errors?: string[]
    format_passed?: boolean           // coding_standards.scripts.format の実行結果
    format_errors?: string[]
    test_quality_issues?: string[]    // 静的検証で検出されたテスト品質の問題
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
