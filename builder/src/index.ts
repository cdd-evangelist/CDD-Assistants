import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { loadRecipe, nextChunks, completeChunk, executionStatus } from './execution-engine/index.js'

const server = new McpServer({
  name: 'cdd-builder',
  version: '0.1.0',
})

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
