import { analyzeDesign } from '../src/recipe-engine/analyze-design.js'
import { splitChunks } from '../src/recipe-engine/split-chunks.js'
import { exportRecipe } from '../src/recipe-engine/export-recipe.js'
import { glob } from 'node:fs/promises'
import { join } from 'node:path'

const docsDir = '/home/kazuhiro/AI-Cowork/Documents/AI-Ghost-Shell'

// 1. analyze_design
const files: string[] = []
for await (const entry of glob(join(docsDir, '*.md'))) {
  files.push(entry)
}

console.log('=== 1. analyze_design ===')
const analysis = await analyzeDesign({
  doc_paths: files,
  project_name: 'AI-Ghost-Shell',
  project_dir: docsDir,
})
console.log(`  Documents: ${analysis.documents.length}`)
console.log(`  Total tokens: ${analysis.total_tokens}`)
console.log(`  Tech stack: ${JSON.stringify(analysis.tech_stack)}`)
console.log()

// 2. split_chunks
console.log('=== 2. split_chunks ===')
const splitResult = await splitChunks({
  analysis,
  docs_dir: docsDir,
})
console.log(`  Chunks: ${splitResult.chunks.length}`)
console.log(`  Execution order: ${JSON.stringify(splitResult.execution_order)}`)
console.log(`  Needs review: ${splitResult.needs_review}`)
console.log()

for (const chunk of splitResult.chunks) {
  console.log(`  ${chunk.id}: ${chunk.name}`)
  console.log(`    depends_on: [${chunk.depends_on.join(', ')}]`)
  console.log(`    source_docs: ${chunk.source_docs.map(d => d.path).join(', ')}`)
  console.log(`    tokens: ~${chunk.estimated_input_tokens} in / ~${chunk.estimated_output_tokens} out`)
  if (chunk.validation_context) console.log(`    validation: ${chunk.validation_context}`)
}
console.log()

// 3. export_recipe
console.log('=== 3. export_recipe ===')
const recipeResult = await exportRecipe({
  project: 'AI-Ghost-Shell',
  tech_stack: {
    language: analysis.tech_stack.language ?? 'TypeScript',
    runtime: analysis.tech_stack.runtime ?? 'Node.js',
    db: analysis.tech_stack.db,
    test: analysis.tech_stack.test,
  },
  chunks: splitResult.chunks,
  docs_dir: docsDir,
  output_path: '/tmp/ai-ghost-shell-full-pipeline.json',
})
console.log(`  Recipe: ${recipeResult.recipe_path}`)
console.log(`  Total chunks: ${recipeResult.total_chunks}`)
console.log(`  Warnings: ${recipeResult.warnings.length}`)
if (recipeResult.warnings.length > 0) {
  for (const w of recipeResult.warnings) console.log(`    - ${w}`)
}
console.log()

console.log('Review notes:')
for (const note of splitResult.review_notes) {
  console.log(`  - ${note}`)
}
