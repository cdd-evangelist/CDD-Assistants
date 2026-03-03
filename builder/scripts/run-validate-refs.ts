import { validateRefs } from '../src/recipe-engine/validate-refs.js'
import { glob } from 'node:fs/promises'
import { join } from 'node:path'

const docsDir = process.argv[2]
if (!docsDir) {
  console.error('Usage: npx tsx scripts/run-validate-refs.ts <docs-dir>')
  process.exit(1)
}

// ディレクトリ内の .md ファイルを収集
const files: string[] = []
for await (const entry of glob(join(docsDir, '*.md'))) {
  files.push(entry)
}

console.log(`検証対象: ${files.length} 文書`)
files.forEach(f => console.log(`  - ${f.split('/').pop()}`))
console.log()

const result = await validateRefs(files)

console.log(`Status: ${result.status}`)
console.log(`Summary: errors=${result.summary.errors}, warnings=${result.summary.warnings}, info=${result.summary.info}`)
console.log()

if (result.issues.length > 0) {
  console.log('Issues:')
  for (const issue of result.issues) {
    const icon = issue.severity === 'error' ? 'ERROR' : issue.severity === 'warn' ? 'WARN' : 'INFO'
    console.log(`  [${icon}] ${issue.type}: ${issue.message}`)
    if (issue.locations.length > 0) {
      console.log(`         at: ${issue.locations.join(', ')}`)
    }
  }
} else {
  console.log('問題なし')
}
