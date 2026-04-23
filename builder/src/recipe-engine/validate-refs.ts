import { readFile } from 'node:fs/promises'
import { resolve, basename } from 'node:path'

// --- 型定義 ---

export type IssueSeverity = 'error' | 'warn' | 'info'

export interface ValidationIssue {
  severity: IssueSeverity
  type: string
  message: string
  locations: string[]
}

export interface ValidationResult {
  status: 'ok' | 'warn' | 'error'
  issues: ValidationIssue[]
  summary: {
    errors: number
    warnings: number
    info: number
  }
}

interface DocContent {
  path: string
  name: string // ファイル名（拡張子なし）
  content: string
  lines: string[]
}

// --- チェッカー ---

/**
 * [[wiki-link]] のリンク切れを検出する
 */
function checkWikiLinks(docs: DocContent[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const docNames = new Set(docs.map(d => d.name))

  for (const doc of docs) {
    const wikiLinkPattern = /\[\[([^\]|#]+)(?:#[^\]|]*)?\]\]/g

    for (let i = 0; i < doc.lines.length; i++) {
      const line = doc.lines[i]
      // インラインコード内の wiki-link は無視
      const lineWithoutCode = line.replace(/`[^`]*`/g, '')
      for (const match of lineWithoutCode.matchAll(wikiLinkPattern)) {
        const linkTarget = match[1].trim()
        // ファイル名として解決を試みる（拡張子あり・なし両対応）
        const targetName = linkTarget.replace(/\.md$/, '')
        if (!docNames.has(targetName)) {
          issues.push({
            severity: 'warn',
            type: 'broken_wiki_link',
            message: `[[${linkTarget}]] のリンク先が見つからない`,
            locations: [`${doc.name}.md:${i + 1}`],
          })
        }
      }
    }
  }

  return issues
}

/**
 * [text](path.md) 形式の Markdown 標準リンクのリンク切れを検出する。
 * 画像リンク ![alt](img) と外部URL（http/https/mailto）は対象外。
 */
function checkMarkdownLinks(docs: DocContent[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const docNames = new Set(docs.map(d => d.name))

  // 先頭が `!` でないリンクのみ。URL 部に `.md` を含むものに限定。
  const mdLinkPattern = /(?<!!)\[[^\]]+\]\(([^)]+\.md)(?:#[^)]*)?\)/g

  for (const doc of docs) {
    for (let i = 0; i < doc.lines.length; i++) {
      const line = doc.lines[i]
      // インラインコード内は無視
      const lineWithoutCode = line.replace(/`[^`]*`/g, '')
      for (const match of lineWithoutCode.matchAll(mdLinkPattern)) {
        const url = match[1]
        // 外部URL は対象外
        if (/^(https?|mailto):/i.test(url)) continue
        // basename を取って拡張子を除き、文書名と照合
        const baseName = url.split(/[/\\]/).pop()?.replace(/\.md$/, '')
        if (!baseName) continue
        if (!docNames.has(baseName)) {
          issues.push({
            severity: 'warn',
            type: 'broken_md_link',
            message: `[${url}](...) のリンク先文書 ${baseName}.md が見つからない`,
            locations: [`${doc.name}.md:${i + 1}`],
          })
        }
      }
    }
  }

  return issues
}

/**
 * ユースケース ID（UC-N, AC-N）の欠番を検出する
 */
function checkUsecaseIds(docs: DocContent[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const ucIds = new Map<number, string>()
  const acIds = new Map<number, string>()

  const ucPattern = /\bUC-(\d+)\b/g
  const acPattern = /\bAC-(\d+)\b/g

  for (const doc of docs) {
    for (let i = 0; i < doc.lines.length; i++) {
      const line = doc.lines[i]
      for (const match of line.matchAll(ucPattern)) {
        ucIds.set(parseInt(match[1]), `${doc.name}.md:${i + 1}`)
      }
      for (const match of line.matchAll(acPattern)) {
        acIds.set(parseInt(match[1]), `${doc.name}.md:${i + 1}`)
      }
    }
  }

  // 連番チェック
  checkSequence(ucIds, 'UC', issues)
  checkSequence(acIds, 'AC', issues)

  return issues
}

function checkSequence(
  ids: Map<number, string>,
  prefix: string,
  issues: ValidationIssue[]
): void {
  if (ids.size === 0) return

  const sorted = [...ids.keys()].sort((a, b) => a - b)
  const max = sorted[sorted.length - 1]

  for (let i = 1; i <= max; i++) {
    if (!ids.has(i)) {
      issues.push({
        severity: 'warn',
        type: 'usecase_gap',
        message: `${prefix}-${i} が見つからない（${prefix}-1〜${max} の範囲で欠番）`,
        locations: [],
      })
    }
  }
}

/**
 * セクション参照（「§N」や「セクションN」）の整合性をチェック
 */
function checkSectionRefs(docs: DocContent[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  // 各文書のセクション見出しを収集
  const docSections = new Map<string, Set<string>>()
  for (const doc of docs) {
    const sections = new Set<string>()
    for (const line of doc.lines) {
      const headingMatch = line.match(/^#{1,6}\s+(.+)/)
      if (headingMatch) {
        sections.add(headingMatch[1].trim())
      }
    }
    docSections.set(doc.name, sections)
  }

  // 他文書のセクションへの参照をチェック
  // パターン: 「ファイル名 §セクション」「ファイル名 セクションN」
  const refPattern = /([a-zA-Z0-9_-]+(?:\.md)?)\s*§(\d+(?:\.\d+)*)/g

  for (const doc of docs) {
    for (let i = 0; i < doc.lines.length; i++) {
      const line = doc.lines[i]
      for (const match of line.matchAll(refPattern)) {
        const targetDoc = match[1].replace(/\.md$/, '')
        if (!docSections.has(targetDoc) && targetDoc !== doc.name) {
          issues.push({
            severity: 'info',
            type: 'section_ref_unresolved',
            message: `${targetDoc} §${match[2]} への参照があるが、文書が見つからない`,
            locations: [`${doc.name}.md:${i + 1}`],
          })
        }
      }
    }
  }

  return issues
}

// --- メイン ---

/**
 * 設計文書間の参照整合性をチェックする。
 * チャンク分割に必要な構造的整合性に絞ってチェックする。
 */
export async function validateRefs(docPaths: string[]): Promise<ValidationResult> {
  // 文書を読み込み
  const docs: DocContent[] = []
  for (const docPath of docPaths) {
    const absPath = resolve(docPath)
    const content = await readFile(absPath, 'utf-8')
    const name = basename(absPath, '.md')
    docs.push({
      path: absPath,
      name,
      content,
      lines: content.split('\n'),
    })
  }

  // 各チェッカーを実行
  const issues: ValidationIssue[] = [
    ...checkWikiLinks(docs),
    ...checkMarkdownLinks(docs),
    ...checkUsecaseIds(docs),
    ...checkSectionRefs(docs),
  ]

  // サマリーを集計
  const summary = {
    errors: issues.filter(i => i.severity === 'error').length,
    warnings: issues.filter(i => i.severity === 'warn').length,
    info: issues.filter(i => i.severity === 'info').length,
  }

  const status: ValidationResult['status'] =
    summary.errors > 0 ? 'error' :
    summary.warnings > 0 ? 'warn' : 'ok'

  return { status, issues, summary }
}
