import { readFile } from 'node:fs/promises'
import { resolve, basename, join } from 'node:path'
import type {
  AnalyzeDesignResult,
  DocumentAnalysis,
  DocFrontmatter,
  DocLayer,
  Decision,
  TechStack,
} from '../types.js'

// --- フロントマター解析 ---

/**
 * YAML フロントマター（--- で囲まれた部分）をパースする。
 * 簡易パーサー: key: value 形式のみ対応。配列は - item 形式。
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
      if (currentKey === 'decisions' || currentKey === 'open_questions') {
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
      if (key === 'status') fm.status = value
      if (key === 'layer') fm.layer = value as DocLayer
    }
  }
  flushArray()

  return { frontmatter: Object.keys(fm).length > 0 ? fm : null, body }
}

// --- セクション抽出 ---

function extractSectionNames(content: string): string[] {
  const sections: string[] = []
  for (const line of content.split('\n')) {
    const match = line.match(/^#{2,4}\s+(.+)/)
    if (match) {
      sections.push(match[1].trim())
    }
  }
  return sections
}

// --- wiki-link 参照グラフ ---

function extractWikiLinks(content: string): string[] {
  const links = new Set<string>()
  // インラインコード内は除外
  const cleaned = content.replace(/`[^`]*`/g, '')
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]*)?\]\]/g
  for (const match of cleaned.matchAll(pattern)) {
    links.add(match[1].trim().replace(/\.md$/, ''))
  }
  return [...links]
}

// --- レイヤー推定 ---

const LAYER_HEURISTICS: Array<{ layer: DocLayer; patterns: RegExp[] }> = [
  {
    layer: 'usecase',
    patterns: [/\bUC-\d+\b/, /\bAC-\d+\b/, /ユースケース/i, /use\s*case/i],
  },
  {
    layer: 'interface',
    patterns: [/\bMCP\b.*ツール/, /\bCLI\b/, /\bAPI\b.*エンドポイント/, /コマンド一覧/],
  },
  {
    layer: 'execution',
    patterns: [/操作フロー/, /ベンチマーク/, /デプロイ/, /運用/],
  },
  {
    layer: 'context',
    patterns: [/比較/, /ToDo/i, /参考/, /prior.*art/i, /バックログ/],
  },
  {
    layer: 'specification',
    patterns: [/仕様/, /spec/i, /プロトコル/, /ポリシー/, /セキュリティ/],
  },
  {
    layer: 'foundation',
    patterns: [/基本設計/, /アーキテクチャ/, /ER図/, /テーブル定義/, /データモデル/],
  },
]

function inferLayer(docName: string, content: string): DocLayer {
  // ファイル名でのヒント
  const nameHints: Array<{ pattern: RegExp; layer: DocLayer }> = [
    { pattern: /usecase/i, layer: 'usecase' },
    { pattern: /cli/i, layer: 'interface' },
    { pattern: /mcp.*tool/i, layer: 'interface' },
    { pattern: /spec/i, layer: 'specification' },
    { pattern: /security/i, layer: 'specification' },
    { pattern: /policy/i, layer: 'specification' },
    { pattern: /basic.*design/i, layer: 'foundation' },
    { pattern: /todo/i, layer: 'context' },
    { pattern: /comparison/i, layer: 'context' },
    { pattern: /prior.*art/i, layer: 'context' },
    { pattern: /operation/i, layer: 'execution' },
    { pattern: /benchmark/i, layer: 'execution' },
    { pattern: /flow/i, layer: 'execution' },
  ]

  for (const hint of nameHints) {
    if (hint.pattern.test(docName)) {
      return hint.layer
    }
  }

  // 内容からの推定
  for (const { layer, patterns } of LAYER_HEURISTICS) {
    const matchCount = patterns.filter(p => p.test(content)).length
    if (matchCount >= 2) return layer
    // 1つだけマッチした場合は弱い証拠として保持
  }

  // 単一マッチでも判定
  for (const { layer, patterns } of LAYER_HEURISTICS) {
    if (patterns.some(p => p.test(content))) return layer
  }

  return 'context' // デフォルト
}

// --- tech_stack 抽出 ---

function extractTechStack(docs: Array<{ name: string; content: string }>): Partial<TechStack> {
  const allContent = docs.map(d => d.content).join('\n')
  const tech: Partial<TechStack> = {}

  // 言語検出
  const langPatterns: Array<{ pattern: RegExp; lang: string }> = [
    { pattern: /\bTypeScript\b/i, lang: 'TypeScript' },
    { pattern: /\bPython\b/i, lang: 'Python' },
    { pattern: /\bRust\b/i, lang: 'Rust' },
    { pattern: /\bGo\b/i, lang: 'Go' },
  ]
  for (const { pattern, lang } of langPatterns) {
    if (pattern.test(allContent)) {
      tech.language = lang
      break
    }
  }

  // ランタイム
  if (/\bNode\.?js\b/i.test(allContent)) tech.runtime = 'Node.js'
  else if (/\bDeno\b/i.test(allContent)) tech.runtime = 'Deno'
  else if (/\bBun\b/i.test(allContent)) tech.runtime = 'Bun'

  // データベース
  if (/\bSQLite\b/i.test(allContent)) tech.db = 'SQLite'
  else if (/\bPostgreSQL\b/i.test(allContent)) tech.db = 'PostgreSQL'
  else if (/\bMySQL\b/i.test(allContent)) tech.db = 'MySQL'

  // テストフレームワーク
  if (/\bvitest\b/i.test(allContent)) tech.test = 'vitest'
  else if (/\bjest\b/i.test(allContent)) tech.test = 'jest'
  else if (/\bpytest\b/i.test(allContent)) tech.test = 'pytest'

  return tech
}

// --- トークン推定 ---

/** 日本語を含むテキストのトークン数を推定（日本語1文字≒2トークン、英語4文字≒1トークン） */
function estimateTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff]/.test(char)) {
      tokens += 2 // CJK 文字
    } else {
      tokens += 0.25 // ASCII
    }
  }
  return Math.ceil(tokens)
}

// --- decisions.jsonl 読み込み ---

async function loadDecisions(projectDir: string): Promise<Decision[]> {
  const decisionsPath = join(projectDir, 'decisions.jsonl')
  try {
    const raw = await readFile(decisionsPath, 'utf-8')
    return raw.trim().split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as Decision)
  } catch {
    return []
  }
}

// --- メイン ---

export async function analyzeDesign(input: {
  doc_paths: string[]
  project_name: string
  project_dir?: string
}): Promise<AnalyzeDesignResult> {
  const { doc_paths, project_name, project_dir } = input

  // 1. 文書を読み込み
  const docs: Array<{
    path: string
    name: string
    content: string
    body: string
    frontmatter: DocFrontmatter | null
    lines: number
    sections: string[]
    wikiLinks: string[]
    estimatedTokens: number
  }> = []

  for (const docPath of doc_paths) {
    const absPath = resolve(docPath)
    const content = await readFile(absPath, 'utf-8')
    const name = basename(absPath, '.md')
    const { frontmatter, body } = parseFrontmatter(content)
    const lines = content.split('\n').length

    docs.push({
      path: basename(absPath),
      name,
      content,
      body,
      frontmatter,
      lines,
      sections: extractSectionNames(body),
      wikiLinks: extractWikiLinks(body),
      estimatedTokens: estimateTokens(content),
    })
  }

  // 2. decisions.jsonl を読み込み
  const decisions = project_dir ? await loadDecisions(project_dir) : []

  // 3. 依存グラフを構築
  const docNameSet = new Set(docs.map(d => d.name))
  const dependencyGraph: Record<string, string[]> = {}

  for (const doc of docs) {
    // wiki-link から同一文書群内のリンクを抽出
    const refs = doc.wikiLinks.filter(link => docNameSet.has(link) && link !== doc.name)
    dependencyGraph[doc.path] = refs.map(r => `${r}.md`)
  }

  // decisions.jsonl から追加の依存関係を反映
  for (const decision of decisions) {
    if (decision.affected_docs.length > 1) {
      // 影響を受ける文書間に暗黙の依存を追加
      for (const docName of decision.affected_docs) {
        if (!dependencyGraph[docName]) continue
        for (const other of decision.affected_docs) {
          if (other !== docName && !dependencyGraph[docName].includes(other)) {
            dependencyGraph[docName].push(other)
          }
        }
      }
    }
  }

  // 4. レイヤー分類
  const layers: Record<DocLayer, string[]> = {
    foundation: [],
    specification: [],
    usecase: [],
    interface: [],
    execution: [],
    context: [],
  }

  for (const doc of docs) {
    // Hybrid Approach C: フロントマターがあれば優先
    const layer = doc.frontmatter?.layer ?? inferLayer(doc.name, doc.body)
    layers[layer].push(doc.path)
  }

  // 5. referenced_by を構築
  const referencedByMap = new Map<string, string[]>()
  for (const doc of docs) {
    referencedByMap.set(doc.path, [])
  }
  for (const doc of docs) {
    for (const ref of dependencyGraph[doc.path] ?? []) {
      const list = referencedByMap.get(ref)
      if (list && !list.includes(doc.path)) {
        list.push(doc.path)
      }
    }
  }

  // 6. tech_stack 抽出
  const techStack = extractTechStack(docs)

  // 7. DocumentAnalysis を組み立て
  const documents: DocumentAnalysis[] = docs.map(doc => {
    const layer = doc.frontmatter?.layer ?? inferLayer(doc.name, doc.body)
    return {
      path: doc.path,
      lines: doc.lines,
      estimated_tokens: doc.estimatedTokens,
      layer,
      sections: doc.sections,
      references_to: dependencyGraph[doc.path] ?? [],
      referenced_by: referencedByMap.get(doc.path) ?? [],
      ...(doc.frontmatter ? { frontmatter: doc.frontmatter } : {}),
    }
  })

  const totalTokens = docs.reduce((sum, d) => sum + d.estimatedTokens, 0)

  return {
    project_name: project_name,
    documents,
    dependency_graph: dependencyGraph,
    layers,
    tech_stack: techStack,
    total_tokens: totalTokens,
  }
}
