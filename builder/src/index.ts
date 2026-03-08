import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { analyzeDesign } from './recipe-engine/analyze-design.js'
import { splitChunks } from './recipe-engine/split-chunks.js'
import { validateRefs } from './recipe-engine/validate-refs.js'
import { exportRecipe } from './recipe-engine/export-recipe.js'
import { loadRecipe, nextChunks, completeChunk, executionStatus } from './execution-engine/index.js'

const server = new McpServer({
  name: 'cdd-builder',
  version: '0.1.0',
})

// --- レシピエンジン ---

server.tool(
  'analyze_design',
  '設計文書群を構造分析する。レイヤー分類、依存グラフ構築、トークン推定、ドリフト検出を行う',
  {
    doc_paths: z.array(z.string()).describe('設計文書のファイルパス一覧'),
    project_name: z.string().describe('プロジェクト名'),
    project_dir: z.string().optional().describe('プロジェクトディレクトリ（ドリフト検出用、省略可）'),
  },
  async ({ doc_paths, project_name, project_dir }) => {
    const result = await analyzeDesign({ doc_paths, project_name, project_dir })
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'split_chunks',
  '設計分析結果をもとにチャンクに分割する。レイヤー間の依存関係と実行順序を算出する',
  {
    analysis: z.any().describe('analyze_design の出力結果'),
    docs_dir: z.string().describe('設計文書のベースディレクトリ'),
    strategy: z.enum(['bottom_up']).optional().describe('分割戦略（現状は bottom_up のみ）'),
    constraints: z.object({
      max_input_tokens: z.number().optional(),
      max_output_tokens: z.number().optional(),
      max_source_docs: z.number().optional(),
      max_output_files: z.number().optional(),
    }).optional().describe('分割制約'),
  },
  async ({ analysis, docs_dir, strategy, constraints }) => {
    const result = await splitChunks({ analysis, docs_dir, strategy, constraints })
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'validate_refs',
  '設計文書間の参照整合性をチェックする。リンク切れ、用語の揺れ、ID欠番を検出する',
  {
    doc_paths: z.array(z.string()).describe('検証対象の設計文書パス一覧'),
  },
  async ({ doc_paths }) => {
    const result = await validateRefs(doc_paths)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'export_recipe',
  'チャンク群をレシピファイル（recipe.json）として出力する。設計文書の内容を埋め込む',
  {
    project: z.string().describe('プロジェクト名'),
    tech_stack: z.any().describe('技術スタック情報'),
    chunks: z.any().describe('split_chunks の出力チャンク群'),
    docs_dir: z.string().describe('設計文書のベースディレクトリ'),
    output_path: z.string().describe('レシピファイルの出力パス'),
    include_source_content: z.boolean().optional().describe('設計文書の内容を埋め込むか（デフォルト: true）'),
  },
  async ({ project, tech_stack, chunks, docs_dir, output_path, include_source_content }) => {
    const result = await exportRecipe({ project, tech_stack, chunks, docs_dir, output_path, include_source_content })
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

// --- 実行エンジン ---

server.tool(
  'load_recipe',
  'レシピファイルを読み込み、実行状態を初期化する',
  {
    recipe_path: z.string().describe('レシピファイル（recipe.json）のパス'),
    working_dir: z.string().optional().describe('実装先ディレクトリ（省略時はレシピと同じディレクトリ）'),
  },
  async ({ recipe_path, working_dir }) => {
    const result = await loadRecipe(recipe_path, working_dir)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'next_chunks',
  '依存が解決済みのチャンクを返す。プレースホルダ解決済みの実装指示を含む',
  {
    execution_state_path: z.string().describe('実行状態ファイルのパス'),
  },
  async ({ execution_state_path }) => {
    const result = await nextChunks(execution_state_path)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'complete_chunk',
  'チャンクの完了を検証し、記録する',
  {
    execution_state_path: z.string().describe('実行状態ファイルのパス'),
    chunk_id: z.string().describe('完了したチャンクのID'),
    generated_files: z.array(z.string()).describe('生成されたファイルパスの一覧'),
  },
  async ({ execution_state_path, chunk_id, generated_files }) => {
    const result = await completeChunk(execution_state_path, chunk_id, generated_files)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'execution_status',
  '全体の実行進捗を可視化する',
  {
    execution_state_path: z.string().describe('実行状態ファイルのパス'),
  },
  async ({ execution_state_path }) => {
    const result = await executionStatus(execution_state_path)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  }
)

// --- サーバー起動 ---

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
