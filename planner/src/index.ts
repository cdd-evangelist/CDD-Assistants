import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { clarifyIdea } from './tools/clarify-idea.js'
import { suggestApproach } from './tools/suggest-approach.js'
import { designContext } from './tools/design-context.js'
import { trackDecision } from './tools/track-decision.js'
import { checkConsistency } from './tools/check-consistency.js'
import { checkReadiness } from './tools/check-readiness.js'

const server = new McpServer({
  name: 'cdd-planner',
  version: '0.1.0',
})

// --- Phase 0: 構想引き出し ---

server.tool(
  'clarify_idea',
  '曖昧な構想を4軸（対象ユーザー・価値・スコープ・制約）で分析し、深掘り質問を生成する',
  {
    raw_idea: z.string().describe('ユーザーの生のアイデアや構想テキスト'),
    existing_context: z.string().nullable().optional().describe('既存のコンテキスト情報（あれば）'),
  },
  async ({ raw_idea, existing_context }) => {
    const result = clarifyIdea({ raw_idea, existing_context })
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

// --- 設計状況スナップショット ---

server.tool(
  'design_context',
  'プロジェクトの設計文書群をスキャンし、進捗・参照関係・未決事項のスナップショットを返す',
  {
    project_dir: z.string().describe('設計文書が格納されたディレクトリパス'),
  },
  async ({ project_dir }) => {
    const result = await designContext({ project_dir })
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

// --- 設計切り口提案 ---

server.tool(
  'suggest_approach',
  '構想やアイデアに対して、設計をどこから攻めるかの切り口を提案する',
  {
    idea: z.string().describe('設計対象のアイデアや構想'),
    context: z.string().nullable().optional().describe('既存の design_context 出力など'),
    constraints: z.array(z.string()).optional().describe('技術的な制約条件'),
  },
  async ({ idea, context, constraints }) => {
    const result = suggestApproach({ idea, context, constraints })
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

// --- 決定事項記録 ---

server.tool(
  'track_decision',
  '壁打ち中の決定事項を decisions.jsonl に構造化記録する',
  {
    project_dir: z.string().describe('プロジェクトディレクトリパス'),
    decision: z.string().describe('決定内容'),
    rationale: z.string().describe('決定の理由'),
    affects: z.array(z.string()).describe('影響を受ける文書ファイル名の配列'),
    supersedes: z.string().nullable().optional().describe('この決定が置き換える旧方針（あれば）'),
  },
  async ({ project_dir, decision, rationale, affects, supersedes }) => {
    const result = await trackDecision({ project_dir, decision, rationale, affects, supersedes })
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

// --- 整合性チェック ---

server.tool(
  'check_consistency',
  '設計文書群の整合性を5カテゴリ（terminology, references, coverage, decisions, staleness）でチェックする',
  {
    project_dir: z.string().describe('プロジェクトディレクトリパス'),
    focus: z.array(z.enum(['terminology', 'references', 'coverage', 'decisions', 'staleness']))
      .optional().describe('チェックするカテゴリ（省略時は全カテゴリ）'),
  },
  async ({ project_dir, focus }) => {
    const result = await checkConsistency({ project_dir, focus })
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

// --- Builder ハンドオフ判定 ---

server.tool(
  'check_readiness',
  '設計文書群が Builder に渡せる状態かを判定する。文書完了・未決事項・整合性・カバレッジを総合チェック',
  {
    project_dir: z.string().describe('プロジェクトディレクトリパス'),
    required_coverage: z.array(z.string()).optional().describe('必要な設計領域（例: usecases, data_model）'),
  },
  async ({ project_dir, required_coverage }) => {
    const result = await checkReadiness({ project_dir, required_coverage })
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

// --- サーバー起動 ---

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
