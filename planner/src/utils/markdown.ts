import type { DocLayer, DocStatus } from '../types.js'

/**
 * Markdown のセクション見出し（## ~ ####）を抽出する。
 */
export function extractSectionNames(content: string): string[] {
  const sections: string[] = []
  for (const line of content.split('\n')) {
    const match = line.match(/^#{2,4}\s+(.+)/)
    if (match) {
      sections.push(match[1].trim())
    }
  }
  return sections
}

/**
 * [[wiki-link]] を抽出する。インラインコード内は除外。
 */
export function extractWikiLinks(content: string): string[] {
  const links = new Set<string>()
  const cleaned = content.replace(/`[^`]*`/g, '')
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]*)?\]\]/g
  for (const match of cleaned.matchAll(pattern)) {
    links.add(match[1].trim().replace(/\.md$/, ''))
  }
  return [...links]
}

/**
 * 日本語を含むテキストのトークン数を推定する。
 * CJK 1文字 ≒ 2トークン、ASCII 4文字 ≒ 1トークン。
 */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff]/.test(char)) {
      tokens += 2
    } else {
      tokens += 0.25
    }
  }
  return Math.ceil(tokens)
}

/**
 * フロントマターの status がない場合、内容からステータスを推定する。
 */
export function inferDocStatus(content: string, sections: string[]): DocStatus {
  // TBD/TODO/WIP が含まれている → draft
  if (/\b(TBD|TODO|WIP|未定|要検討)\b/i.test(content)) {
    return 'draft'
  }
  // セクションが少ない → draft
  if (sections.length <= 1) {
    return 'draft'
  }
  // それ以外 → complete と推定
  return 'complete'
}

/**
 * 文書内の open_questions / 未決事項を抽出する。
 * パターン: "- [ ]", "Q:", "?", "未決", "要検討"
 */
export function extractOpenQuestions(content: string): string[] {
  const questions: string[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    // チェックボックス未チェック
    if (trimmed.startsWith('- [ ]')) {
      questions.push(trimmed.slice(5).trim())
      continue
    }
    // Q: で始まる行
    if (/^Q[:：]/.test(trimmed)) {
      questions.push(trimmed.slice(2).trim())
      continue
    }
    // 「未決」「要検討」を含むリスト項目
    if (trimmed.startsWith('- ') && /(?:未決|要検討|TBD|TODO)/.test(trimmed)) {
      questions.push(trimmed.slice(2).trim())
    }
  }
  return questions
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

const NAME_HINTS: Array<{ pattern: RegExp; layer: DocLayer }> = [
  { pattern: /^readme$/i, layer: 'context' },
  { pattern: /^changelog$/i, layer: 'context' },
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

/**
 * ファイル名と内容からレイヤーを推定する。
 */
export function inferLayer(docName: string, content: string): DocLayer {
  for (const hint of NAME_HINTS) {
    if (hint.pattern.test(docName)) {
      return hint.layer
    }
  }

  for (const { layer, patterns } of LAYER_HEURISTICS) {
    const matchCount = patterns.filter(p => p.test(content)).length
    if (matchCount >= 2) return layer
  }

  for (const { layer, patterns } of LAYER_HEURISTICS) {
    if (patterns.some(p => p.test(content))) return layer
  }

  return 'context'
}
