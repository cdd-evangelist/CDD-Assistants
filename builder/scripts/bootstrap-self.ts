/**
 * 自己ブートストラップ検証スクリプト。
 *
 * Builder 自身の設計文書（docs/builder/）を analyze_design → split_chunks → export_recipe で
 * チャンク化できるかを検証する。CDD の輪が閉じることの確認。
 *
 * 実行: npx tsx scripts/bootstrap-self.ts
 */

import { analyzeDesign } from '../src/recipe-engine/analyze-design.js'
import { splitChunks } from '../src/recipe-engine/split-chunks.js'
import { exportRecipe } from '../src/recipe-engine/export-recipe.js'
import { readdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const repoRoot = resolve(__dirname, '../..')
const docsDir  = join(repoRoot, 'docs/builder')
const outputPath = '/tmp/cdd-builder-self-recipe.json'

console.log('=== 自己ブートストラップ検証 ===')
console.log(`  対象: ${docsDir}`)
console.log(`  出力: ${outputPath}`)
console.log()

// 1. md ファイルを再帰的に収集
const entries = await readdir(docsDir, { recursive: true, withFileTypes: true })
const files: string[] = entries
  .filter(e => e.isFile() && e.name.endsWith('.md'))
  .map(e => join(e.parentPath ?? (e as any).path ?? docsDir, e.name))
console.log(`  収集した文書数: ${files.length}`)
for (const f of files) console.log(`    - ${f.replace(docsDir + '/', '')}`)
console.log()

// 2. analyze_design
console.log('=== Step 1: analyze_design ===')
const analysis = await analyzeDesign({
  doc_paths: files,
  project_name: 'cdd-builder',
  project_dir: repoRoot,
})
console.log(`  documents: ${analysis.documents.length}`)
console.log(`  total_tokens: ${analysis.total_tokens}`)
console.log(`  tech_stack: ${JSON.stringify(analysis.tech_stack)}`)
console.log(`  coding_standards:`, analysis.coding_standards
  ? `docs=[${analysis.coding_standards.docs}], linters=[${analysis.coding_standards.linters}], scripts=${JSON.stringify(analysis.coding_standards.scripts)}`
  : 'null')
console.log(`  drift_warnings: ${analysis.drift_warnings.length}`)
console.log()
console.log('  レイヤー分類:')
for (const [layer, paths] of Object.entries(analysis.layers)) {
  if ((paths as string[]).length === 0) continue
  console.log(`    ${layer}: ${(paths as string[]).length}本`)
  for (const p of paths as string[]) console.log(`      - ${p}`)
}
console.log()

// 3. split_chunks
console.log('=== Step 2: split_chunks ===')
const splitResult = await splitChunks({ analysis, docs_dir: docsDir })
console.log(`  chunks: ${splitResult.chunks.length}`)
console.log(`  needs_review: ${splitResult.needs_review}`)
console.log(`  execution_order:`)
for (let i = 0; i < splitResult.execution_order.length; i++) {
  console.log(`    Level ${i}: [${splitResult.execution_order[i].join(', ')}]`)
}
console.log()

console.log('  チャンク一覧:')
for (const chunk of splitResult.chunks) {
  const flag = chunk.is_integration_test ? ' [統合テスト]' : ''
  console.log(`  ${chunk.id}: ${chunk.name}${flag}`)
  console.log(`    depends_on: [${chunk.depends_on.join(', ')}]`)
  if (chunk.source_docs.length > 0) {
    console.log(`    source_docs: ${chunk.source_docs.map(d => d.path).join(', ')}`)
  }
  console.log(`    tokens: ~${chunk.estimated_input_tokens} in / ~${chunk.estimated_output_tokens} out`)
  console.log(`    test_requirements:`)
  console.log(`      interface: ${chunk.test_requirements.interface_tests.length}件`)
  console.log(`      boundary:  ${chunk.test_requirements.boundary_tests.length}件`)
  console.log(`      integration: ${chunk.test_requirements.integration_refs.length}件`)
}
console.log()

console.log('  review_notes:')
for (const note of splitResult.review_notes) console.log(`    - ${note}`)
console.log()

// 4. export_recipe
console.log('=== Step 3: export_recipe ===')
const exportResult = await exportRecipe({
  project: 'cdd-builder',
  tech_stack: {
    language: analysis.tech_stack.language ?? 'TypeScript',
    runtime:  analysis.tech_stack.runtime  ?? 'Node.js',
    db:       analysis.tech_stack.db,
    test:     analysis.tech_stack.test,
  },
  coding_standards: analysis.coding_standards,
  chunks: splitResult.chunks,
  docs_dir: docsDir,
  output_path: outputPath,
})
console.log(`  recipe_path: ${exportResult.recipe_path}`)
console.log(`  total_chunks: ${exportResult.total_chunks}`)
console.log(`  warnings: ${exportResult.warnings.length}`)
for (const w of exportResult.warnings) console.log(`    - ${w}`)
console.log()

console.log('=== 完了 ===')
console.log(`recipe.json は ${outputPath} に出力された`)
