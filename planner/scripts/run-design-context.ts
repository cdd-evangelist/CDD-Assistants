/**
 * デバッグ用スクリプト: design_context を指定ディレクトリで実行
 * Usage: npx tsx scripts/run-design-context.ts <project_dir>
 */
import { designContext } from '../src/tools/design-context.js'

const projectDir = process.argv[2]
if (!projectDir) {
  console.error('Usage: npx tsx scripts/run-design-context.ts <project_dir>')
  process.exit(1)
}

const result = await designContext({ project_dir: projectDir })
console.log(JSON.stringify(result, null, 2))
