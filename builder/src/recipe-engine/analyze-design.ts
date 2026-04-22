import { readFile, readdir, stat, access } from 'node:fs/promises'
import { resolve, basename, join, relative, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  AnalyzeDesignResult,
  DocumentAnalysis,
  DocFrontmatter,
  DocLayer,
  Decision,
  DriftWarning,
  TechStack,
  CodingStandards,
} from '../types.js'

const execFileAsync = promisify(execFile)

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
    layer: 'operation',
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
    { pattern: /operation/i, layer: 'operation' },
    { pattern: /benchmark/i, layer: 'operation' },
    { pattern: /flow/i, layer: 'operation' },
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

// --- ドリフト検出 ---

/**
 * 既存リファレンスとコミット履歴を照合し、設計文書と実装の乖離を検出する。
 * git リポジトリでない場合やリファレンスが存在しない場合は空配列を返す。
 */
export async function detectDrift(projectDir: string): Promise<DriftWarning[]> {
  const refDir = join(projectDir, 'docs', 'ref')
  let refFiles: string[]
  try {
    refFiles = (await readdir(refDir)).filter(f => f.endsWith('.md'))
  } catch {
    return [] // リファレンスディレクトリなし → 初回ビルド
  }

  if (refFiles.length === 0) return []

  const warnings: DriftWarning[] = []

  for (const refFile of refFiles) {
    const refPath = join(refDir, refFile)
    const refStat = await stat(refPath)
    const refDate = refStat.mtime.toISOString()

    // リファレンス生成後のコミットで変更されたファイルを取得
    try {
      const { stdout } = await execFileAsync(
        'git', ['log', '--since', refDate, '--name-only', '--pretty=format:', '--diff-filter=ACMR'],
        { cwd: projectDir }
      )

      const changedFiles = [...new Set(
        stdout.split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('docs/ref/'))
      )]

      if (changedFiles.length > 0) {
        // コミット数をカウント
        const { stdout: logOut } = await execFileAsync(
          'git', ['log', '--since', refDate, '--oneline'],
          { cwd: projectDir }
        )
        const commitCount = logOut.trim().split('\n').filter(l => l.trim()).length

        warnings.push({
          reference: join('docs', 'ref', refFile),
          commits_since: commitCount,
          changed_files: changedFiles,
          message: `リファレンス生成後にコードが変更されています。設計文書が最新の実装を反映しているか、Planner で確認してください`,
        })
      }
    } catch {
      // git コマンド失敗 → git リポジトリでない等。スキップ
    }
  }

  return warnings
}

// --- メイン ---

// --- パスユーティリティ ---

/**
 * 複数の絶対パスから最長共通親ディレクトリを計算する。
 * source_docs[].path をサブディレクトリ込みの相対パスにするための基準。
 */
function computeCommonParent(absPaths: string[]): string {
  if (absPaths.length === 0) return ''
  if (absPaths.length === 1) return dirname(absPaths[0])

  const splitPaths = absPaths.map(p => dirname(p).split(/[/\\]/))
  const minLen = Math.min(...splitPaths.map(s => s.length))
  const common: string[] = []
  for (let i = 0; i < minLen; i++) {
    const seg = splitPaths[0][i]
    if (splitPaths.every(s => s[i] === seg)) {
      common.push(seg)
    } else {
      break
    }
  }
  return common.join('/') || '/'
}

// --- コード規約検出（coding-standards.md §3） ---

const CODING_STANDARD_DOCS = ['AGENTS.md', 'CODING-STANDARDS.md']

const LINTER_FILES = [
  '.editorconfig',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.json',
  'prettier.config.js',
  'ruff.toml',
  'pyproject.toml',
]

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * プロジェクトディレクトリからコード規約情報を検出する。
 * coding-standards.md §3 の優先順序に従う。
 * docs / linters / scripts のいずれも空の場合は null を返す。
 */
async function detectCodingStandards(projectDir: string): Promise<CodingStandards | null> {
  const docs: string[] = []
  const linters: string[] = []
  const scripts: CodingStandards['scripts'] = {}

  // 1. 規約文書（AGENTS.md / CODING-STANDARDS.md）
  for (const docFile of CODING_STANDARD_DOCS) {
    if (await fileExists(join(projectDir, docFile))) {
      docs.push(docFile)
    }
  }

  // 2. linter / formatter 設定ファイル
  for (const linterFile of LINTER_FILES) {
    if (await fileExists(join(projectDir, linterFile))) {
      linters.push(linterFile)
    }
  }

  // 3. scripts（package.json → pyproject.toml の順）
  const packageJsonPath = join(projectDir, 'package.json')
  if (await fileExists(packageJsonPath)) {
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, 'utf-8'))
      const s = pkg.scripts ?? {}
      if (s.lint)   scripts.lint   = s.lint
      if (s.format) scripts.format = s.format
      if (s.test)   scripts.test   = s.test
    } catch {
      // JSON パース失敗は無視
    }
  }

  if (!scripts.lint && !scripts.format && !scripts.test) {
    // pyproject.toml の [tool.scripts] も探す（簡易対応）
    const pyprojectPath = join(projectDir, 'pyproject.toml')
    if (await fileExists(pyprojectPath) && !linters.includes('pyproject.toml')) {
      // pyproject.toml は linter 設定としても扱うが、scripts は未対応（TOML パーサー不要）
    }
  }

  if (docs.length === 0 && linters.length === 0 && Object.keys(scripts).length === 0) {
    return null
  }

  return { docs, linters, scripts }
}

export async function analyzeDesign(input: {
  doc_paths: string[]
  project_name: string
  project_dir?: string
}): Promise<AnalyzeDesignResult> {
  const { doc_paths, project_name, project_dir } = input

  // 1. ドリフト検出（既存実装がある場合）
  const driftWarnings = project_dir ? await detectDrift(project_dir) : []

  // 2. 文書を読み込み
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

  // 全 doc の絶対パスを先に決めて、最長共通親ディレクトリを計算する
  const absPaths = doc_paths.map(p => resolve(p))
  const commonBase = computeCommonParent(absPaths)

  for (const absPath of absPaths) {
    const content = await readFile(absPath, 'utf-8')
    const name = basename(absPath, '.md')
    const { frontmatter, body } = parseFrontmatter(content)
    const lines = content.split('\n').length

    // commonBase からの相対パスを path とする（サブディレクトリも保持）
    const relPath = relative(commonBase, absPath) || basename(absPath)

    docs.push({
      path: relPath,
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

  // 3. decisions.jsonl を読み込み
  const decisions = project_dir ? await loadDecisions(project_dir) : []

  // 4. 依存グラフを構築
  const nameToPath = new Map(docs.map(d => [d.name, d.path]))
  const dependencyGraph: Record<string, string[]> = {}

  for (const doc of docs) {
    // wiki-link から同一文書群内のリンクを抽出（path は相対パスで揃える）
    const refs = doc.wikiLinks
      .filter(link => nameToPath.has(link) && link !== doc.name)
      .map(link => nameToPath.get(link)!)
    dependencyGraph[doc.path] = refs
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

  // 5. レイヤー分類
  const layers: Record<DocLayer, string[]> = {
    foundation: [],
    specification: [],
    usecase: [],
    interface: [],
    operation: [],
    context: [],
  }

  const KNOWN_LAYERS = new Set<DocLayer>([
    'foundation', 'specification', 'usecase', 'interface', 'operation', 'context',
  ])
  for (const doc of docs) {
    // Hybrid Approach C: フロントマターがあれば優先。ただし未知の layer 値はフォールバック
    const fmLayer = doc.frontmatter?.layer as DocLayer | undefined
    const layer: DocLayer = fmLayer && KNOWN_LAYERS.has(fmLayer)
      ? fmLayer
      : inferLayer(doc.name, doc.body)
    layers[layer].push(doc.path)
  }

  // 6. referenced_by を構築
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

  // 7. tech_stack 抽出
  const techStack = extractTechStack(docs)

  // 8. DocumentAnalysis を組み立て
  const documents: DocumentAnalysis[] = docs.map(doc => {
    const fmLayer = doc.frontmatter?.layer as DocLayer | undefined
    const layer: DocLayer = fmLayer && KNOWN_LAYERS.has(fmLayer)
      ? fmLayer
      : inferLayer(doc.name, doc.body)
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
    drift_warnings: driftWarnings,
    documents,
    dependency_graph: dependencyGraph,
    layers,
    tech_stack: techStack,
    coding_standards: project_dir ? await detectCodingStandards(project_dir) : null,
    total_tokens: totalTokens,
  }
}
