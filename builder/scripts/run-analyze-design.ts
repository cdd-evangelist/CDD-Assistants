import { analyzeDesign } from '../src/recipe-engine/analyze-design.js'
import { glob } from 'node:fs/promises'
import { join } from 'node:path'

const docsDir = '/home/kazuhiro/AI-Cowork/Documents/AI-Ghost-Shell'

const files: string[] = []
for await (const entry of glob(join(docsDir, '*.md'))) {
  files.push(entry)
}

const result = await analyzeDesign({
  doc_paths: files,
  project_name: 'AI-Ghost-Shell',
  project_dir: docsDir,
})

console.log(`Project: ${result.project_name}`)
console.log(`Documents: ${result.documents.length}`)
console.log(`Total tokens: ${result.total_tokens}`)
console.log()

console.log('Tech Stack:')
for (const [key, value] of Object.entries(result.tech_stack)) {
  if (value) console.log(`  ${key}: ${value}`)
}
console.log()

console.log('Layers:')
for (const [layer, docs] of Object.entries(result.layers)) {
  if (docs.length > 0) {
    console.log(`  ${layer}: ${docs.join(', ')}`)
  }
}
console.log()

console.log('Documents:')
for (const doc of result.documents) {
  console.log(`  ${doc.path} (${doc.lines} lines, ~${doc.estimated_tokens} tokens) [${doc.layer}]`)
  if (doc.references_to.length > 0) console.log(`    → refs: ${doc.references_to.join(', ')}`)
  if (doc.referenced_by.length > 0) console.log(`    ← by:   ${doc.referenced_by.join(', ')}`)
}
