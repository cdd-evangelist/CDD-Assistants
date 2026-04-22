import { analyzeDesign } from '../src/recipe-engine/analyze-design.js'
import { readdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const docsDir = join(repoRoot, 'docs/builder')

const entries = await readdir(docsDir, { recursive: true, withFileTypes: true })
const files = entries
  .filter(e => e.isFile() && e.name.endsWith('.md'))
  .map(e => join(e.parentPath ?? (e as any).path ?? docsDir, e.name))

const a = await analyzeDesign({
  doc_paths: files,
  project_name: 'cdd-builder',
  project_dir: repoRoot,
})

for (const d of a.documents) {
  if (d.tier === 'detail') {
    console.log(`${d.path} (tier=${d.tier})`)
    console.log(`  references_to: ${JSON.stringify(d.references_to)}`)
  }
}
