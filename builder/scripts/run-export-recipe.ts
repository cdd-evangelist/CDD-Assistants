import { exportRecipe } from '../src/recipe-engine/export-recipe.js'
import type { ExportRecipeInput } from '../src/types.js'

// AI-Ghost-Shell 設計文書からサンプルレシピを生成
const input: ExportRecipeInput = {
  project: 'AI-Ghost-Shell',
  tech_stack: {
    language: 'TypeScript',
    runtime: 'Node.js',
    db: 'SQLite',
    test: 'vitest',
    platforms: ['linux', 'macos'],
    platform_notes: 'Git版はgitコマンド必須。Lite版はSQLiteのみ',
    directory_structure: 'src/ + tests/',
  },
  docs_dir: '/home/kazuhiro/AI-Cowork/Documents/AI-Ghost-Shell',
  output_path: '/tmp/ai-ghost-shell-recipe.json',
  chunks: [
    {
      id: 'chunk-01',
      name: 'データベーススキーマ',
      description: 'ghost.db の5テーブル作成 + マイグレーション',
      depends_on: [],
      source_docs: [
        { path: 'BasicDesign.md', sections: ['3. データベーススキーマ（ghost.db）'], include: 'partial' },
      ],
      implementation_prompt_template:
        '以下の設計に基づき、SQLite データベースのスキーマとマイグレーションを実装してください。\n\n{source_content}',
      expected_outputs: ['src/db/schema.sql', 'src/db/connection.ts', 'src/db/migrate.ts', 'tests/db/schema.test.ts'],
      completion_criteria: ['5テーブルが作成される', 'マイグレーションが冪等', 'テストが通る'],
      estimated_input_tokens: 2500,
      estimated_output_tokens: 4000,
    },
    {
      id: 'chunk-02',
      name: 'エピソード記憶抽出',
      description: 'セッションログからエピソード記憶を抽出',
      depends_on: ['chunk-01'],
      source_docs: [
        { path: 'episode-extraction.md', sections: ['抽出パイプライン', 'エンティティ抽出'], include: 'partial' },
      ],
      implementation_prompt_template:
        '以下の設計に基づき、エピソード記憶抽出モジュールを実装してください。\n\n{source_content}\n\n依存コード:\n{{file:src/db/connection.ts}}',
      expected_outputs: ['src/episode/extractor.ts', 'tests/episode/extractor.test.ts'],
      completion_criteria: ['エピソード抽出が動作する', 'テストが通る'],
      estimated_input_tokens: 3000,
      estimated_output_tokens: 5000,
    },
  ],
}

const result = await exportRecipe(input)

console.log('Export 結果:')
console.log(`  recipe_path: ${result.recipe_path}`)
console.log(`  total_chunks: ${result.total_chunks}`)
console.log(`  execution_order: ${JSON.stringify(result.execution_order)}`)
if (result.warnings.length > 0) {
  console.log(`  warnings: ${result.warnings.join(', ')}`)
}

// 出力されたレシピの source_content の先頭部分を表示
const { readFile } = await import('node:fs/promises')
const recipe = JSON.parse(await readFile(result.recipe_path, 'utf-8'))
for (const chunk of recipe.chunks) {
  console.log(`\n--- ${chunk.name} ---`)
  console.log(`source_content (先頭200文字): ${chunk.source_content.slice(0, 200)}...`)
  console.log(`implementation_prompt に {{file:}} が残っているか: ${chunk.implementation_prompt.includes('{{file:')}`)
}
