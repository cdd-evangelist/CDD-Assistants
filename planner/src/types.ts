// ============================================================
// CDD-Planner 型定義
// ============================================================

// --- 共有型 ---

export type DocLayer =
  | 'foundation'     // 基本設計、アーキテクチャ、データモデル
  | 'specification'  // 詳細仕様、プロトコル
  | 'usecase'        // ユースケース（UC-*, AC-*）
  | 'interface'      // API、CLI、MCPツール
  | 'execution'      // 運用、デプロイ、ベンチマーク
  | 'context'        // 比較、TODO、参考資料

export type DocStatus = 'draft' | 'in_progress' | 'complete'

export interface DocFrontmatter {
  status?: DocStatus
  layer?: DocLayer
  last_reviewed?: string          // ISO 8601 日付
  decisions?: string[]            // 関連する決定事項ID (DEC-XXX)
  open_questions?: string[]
  tags?: string[]
}

export interface Decision {
  id: string
  decision: string
  rationale: string
  affects: string[]              // 影響する文書ファイル名
  supersedes?: string | null
  created_at: string             // ISO 8601
}

export type IssueSeverity = 'error' | 'warn' | 'info'

export interface Issue {
  category: string
  severity: IssueSeverity
  message: string
  suggestion?: string
  locations?: string[]           // "filename.md:line"
}

// --- clarify_idea ---

export interface ClarifyIdeaInput {
  raw_idea: string
  existing_context?: string | null
}

export type AxisKey = 'target_user' | 'value' | 'scope' | 'constraints'

export interface AxisStatus {
  axis: AxisKey
  label: string
  filled: boolean
  extracted?: string             // 入力から抽出された情報
}

export interface TemplateQuestion {
  question: string
  why: string
  axis: AxisKey
}

export interface SimilarApproach {
  name: string
  relevance: string
}

export type ClarifyRoute = 'one-shot' | 'full'

export interface ClarifyIdeaResult {
  route: ClarifyRoute
  understood: {
    core_desire: string | null
    pain_point: string | null
    implied_scope: string | null
  }
  axes: AxisStatus[]
  fulfillment: number            // 0-4: 充足軸数
  mode: 'diverge' | 'converge' | 'transition'
  questions: TemplateQuestion[]
  similar_approaches: SimilarApproach[]
  one_shot_suggestion?: string   // route が 'one-shot' のときの案内メッセージ
}

// --- design_context ---

export interface DesignContextInput {
  project_dir: string
}

export interface DocumentSummary {
  path: string
  status: DocStatus
  layer: DocLayer
  estimated_tokens: number
  sections: string[]
  decisions: string[]
  open_questions: string[]
  references_to: string[]
  referenced_by: string[]
  last_reviewed?: string
}

export interface OverallProgress {
  complete: number
  in_progress: number
  draft: number
  total: number
  readiness: 'not_ready' | 'nearly_ready' | 'ready'
}

export interface UnresolvedQuestion {
  source: string
  question: string
  blocking: boolean
}

export interface DesignContextResult {
  project: string
  documents: DocumentSummary[]
  overall_progress: OverallProgress
  unresolved_questions: UnresolvedQuestion[]
  dependency_graph: Record<string, string[]>
  total_tokens: number
}

// --- suggest_approach ---

export interface SuggestApproachInput {
  idea: string
  context?: string | null
  constraints?: string[]
}

export type ApproachSource = 'core' | 'extended'

export interface Approach {
  name: string
  description: string
  source: ApproachSource
  suggested_documents: string[]
  good_for: string
}

export interface SuggestApproachResult {
  approaches: Approach[]
  recommendation: string
}

// --- track_decision ---

export interface TrackDecisionInput {
  project_dir: string
  decision: string
  rationale: string
  affects: string[]
  supersedes?: string | null
}

export interface AffectedDocStatus {
  path: string
  needs_update: boolean
  exists: boolean
}

export interface TrackDecisionResult {
  decision_id: string
  recorded_at: string
  affected_documents_status: AffectedDocStatus[]
}

// --- check_consistency ---

export type ConsistencyCategory =
  | 'terminology'
  | 'references'
  | 'coverage'
  | 'decisions'
  | 'staleness'

export interface CheckConsistencyInput {
  project_dir: string
  focus?: ConsistencyCategory[]
}

export interface CheckConsistencyResult {
  status: 'ok' | 'warn' | 'error'
  issues: Issue[]
  summary: {
    errors: number
    warnings: number
    info: number
  }
}

// --- check_readiness ---

export interface CheckReadinessInput {
  project_dir: string
  required_coverage?: string[]
}

export interface Blocker {
  type: string
  message: string
  suggestion: string
}

export interface Warning {
  type: string
  message: string
}

export interface CheckReadinessResult {
  ready: boolean
  blockers: Blocker[]
  warnings: Warning[]
  handoff_summary: string
}

// --- ユーティリティ向け ---

export interface ParsedDocument {
  path: string                   // ファイル名 (e.g. "BasicDesign.md")
  name: string                   // 拡張子なし (e.g. "BasicDesign")
  content: string
  body: string                   // フロントマター除去後
  frontmatter: DocFrontmatter | null
  lines: number
  sections: string[]
  wikiLinks: string[]
  estimatedTokens: number
}
