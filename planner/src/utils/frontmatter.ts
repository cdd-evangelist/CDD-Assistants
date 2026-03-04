import type { DocFrontmatter, DocLayer, DocStatus } from '../types.js'

const VALID_STATUSES: Set<string> = new Set(['draft', 'in_progress', 'complete'])
const VALID_LAYERS: Set<string> = new Set([
  'foundation', 'specification', 'usecase', 'interface', 'execution', 'context',
])

/**
 * YAML フロントマター（--- で囲まれた部分）をパースする。
 * Builder の parseFrontmatter を拡張: last_reviewed, tags 対応。
 */
export function parseFrontmatter(content: string): { frontmatter: DocFrontmatter | null; body: string } {
  if (!content.startsWith('---')) {
    return { frontmatter: null, body: content }
  }

  const endIndex = content.indexOf('\n---', 3)
  if (endIndex === -1) {
    return { frontmatter: null, body: content }
  }

  const yamlBlock = content.slice(4, endIndex).trim()
  const body = content.slice(endIndex + 4).trim()

  const fm: DocFrontmatter = {}
  let currentKey = ''
  const currentArray: string[] = []

  const flushArray = () => {
    if (currentKey && currentArray.length > 0) {
      if (currentKey === 'decisions' || currentKey === 'open_questions' || currentKey === 'tags') {
        (fm as Record<string, string[]>)[currentKey] = [...currentArray]
      }
      currentArray.length = 0
    }
  }

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) {
      currentArray.push(trimmed.slice(2).trim())
      continue
    }

    flushArray()

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()
    currentKey = key

    if (value) {
      if (key === 'status' && VALID_STATUSES.has(value)) {
        fm.status = value as DocStatus
      }
      if (key === 'layer' && VALID_LAYERS.has(value)) {
        fm.layer = value as DocLayer
      }
      if (key === 'last_reviewed') {
        fm.last_reviewed = value
      }
    }
  }
  flushArray()

  return { frontmatter: Object.keys(fm).length > 0 ? fm : null, body }
}
