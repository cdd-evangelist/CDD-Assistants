import { readdir, readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { parseFrontmatter } from '../utils/frontmatter.js'
import { extractSectionNames, extractWikiLinks } from '../utils/markdown.js'
import { loadDecisions } from '../utils/decisions.js'
import type {
  CheckConsistencyInput,
  CheckConsistencyResult,
  ConsistencyCategory,
  Issue,
  IssueSeverity,
  Decision,
  DocFrontmatter,
} from '../types.js'

// --- 内部型 ---

interface DocContent {
  path: string
  name: string
  content: string
  body: string
  lines: string[]
  frontmatter: DocFrontmatter | null
  sections: string[]
  wikiLinks: string[]
}

// --- チェッカー: terminology ---

/**
 * バッククォート内用語 + CamelCase の揺れを検出する。
 */
function checkTerminology(docs: DocContent[]): Issue[] {
  const issues: Issue[] = []

  // バッククォート内の用語を収集
  const termsByDoc = new Map<string, Map<string, number[]>>() // term → doc → lines

  for (const doc of docs) {
    const terms = new Map<string, number[]>()
    for (let i = 0; i < doc.lines.length; i++) {
      const backtickPattern = /`([^`]+)`/g
      for (const match of doc.lines[i].matchAll(backtickPattern)) {
        const term = match[1].trim()
        if (term.length < 2) continue
        const existing = terms.get(term) ?? []
        existing.push(i + 1)
        terms.set(term, existing)
      }
    }
    termsByDoc.set(doc.path, terms)
  }

  // 全文書の用語を統合
  const allTerms = new Map<string, string[]>() // normalized → [original variants]
  for (const [, terms] of termsByDoc) {
    for (const term of terms.keys()) {
      const normalized = term.toLowerCase().replace(/[_\-\s]/g, '')
      const variants = allTerms.get(normalized) ?? []
      if (!variants.includes(term)) {
        variants.push(term)
      }
      allTerms.set(normalized, variants)
    }
  }

  // 2つ以上のバリアントがあれば揺れとして報告
  for (const [, variants] of allTerms) {
    if (variants.length >= 2) {
      // どの文書で使われているかを収集
      const locations: string[] = []
      for (const variant of variants) {
        for (const [docPath, terms] of termsByDoc) {
          const lineNums = terms.get(variant)
          if (lineNums) {
            locations.push(`${docPath}:${lineNums[0]} (${variant})`)
          }
        }
      }

      issues.push({
        category: 'terminology',
        severity: 'warn',
        message: `用語の揺れ: ${variants.map(v => `\`${v}\``).join(' vs ')}`,
        suggestion: `いずれかに統一してください`,
        locations,
      })
    }
  }

  return issues
}

// --- チェッカー: references ---

/**
 * wiki-link リンク切れ、UC/AC 欠番を検出する。
 */
function checkReferences(docs: DocContent[]): Issue[] {
  const issues: Issue[] = []
  const docNames = new Set(docs.map(d => d.name))

  // wiki-link リンク切れ
  for (const doc of docs) {
    for (const link of doc.wikiLinks) {
      if (!docNames.has(link)) {
        // リンクが出現する行を検索
        const lineNum = doc.lines.findIndex(l => l.includes(`[[${link}`)) + 1
        issues.push({
          category: 'references',
          severity: 'warn',
          message: `[[${link}]] のリンク先が見つからない`,
          locations: [`${doc.path}:${lineNum || 1}`],
        })
      }
    }
  }

  // UC/AC 欠番
  const ucIds = new Map<number, string>()
  const acIds = new Map<number, string>()

  for (const doc of docs) {
    for (let i = 0; i < doc.lines.length; i++) {
      const line = doc.lines[i]
      for (const match of line.matchAll(/\bUC-(\d+)\b/g)) {
        ucIds.set(parseInt(match[1]), `${doc.path}:${i + 1}`)
      }
      for (const match of line.matchAll(/\bAC-(\d+)\b/g)) {
        acIds.set(parseInt(match[1]), `${doc.path}:${i + 1}`)
      }
    }
  }

  checkSequenceGaps(ucIds, 'UC', issues)
  checkSequenceGaps(acIds, 'AC', issues)

  return issues
}

function checkSequenceGaps(
  ids: Map<number, string>,
  prefix: string,
  issues: Issue[],
): void {
  if (ids.size === 0) return
  const sorted = [...ids.keys()].sort((a, b) => a - b)
  const max = sorted[sorted.length - 1]
  for (let i = 1; i <= max; i++) {
    if (!ids.has(i)) {
      issues.push({
        category: 'references',
        severity: 'warn',
        message: `${prefix}-${i} が欠番（${prefix}-1〜${max} の範囲）`,
        locations: [],
      })
    }
  }
}

// --- チェッカー: coverage ---

/**
 * ユースケース ↔ 設計文書の対応をチェックする。
 */
function checkCoverage(docs: DocContent[]): Issue[] {
  const issues: Issue[] = []

  // ユースケースを含む文書を特定
  const usecaseDocs = docs.filter(d =>
    d.lines.some(l => /\bUC-\d+\b/.test(l) || /\bAC-\d+\b/.test(l))
  )

  // ユースケースを含まない文書（設計文書）
  const designDocs = docs.filter(d =>
    !usecaseDocs.includes(d) && d.sections.length > 0
  )

  // ユースケース文書がなければ warn
  if (usecaseDocs.length === 0 && docs.length > 1) {
    issues.push({
      category: 'coverage',
      severity: 'info',
      message: 'ユースケース定義（UC-*, AC-*）を含む文書がない',
      suggestion: 'ユースケース一覧を作成すると設計の抜け漏れを防げます',
    })
  }

  // 設計文書がユースケース文書から参照されているかチェック
  if (usecaseDocs.length > 0) {
    const referencedFromUsecase = new Set<string>()
    for (const ucDoc of usecaseDocs) {
      for (const link of ucDoc.wikiLinks) {
        referencedFromUsecase.add(link)
      }
    }

    for (const designDoc of designDocs) {
      if (!referencedFromUsecase.has(designDoc.name)) {
        issues.push({
          category: 'coverage',
          severity: 'info',
          message: `${designDoc.path} はどのユースケース文書からも参照されていない`,
          suggestion: 'ユースケースとの対応を明示すると整合性が保ちやすくなります',
        })
      }
    }
  }

  return issues
}

// --- チェッカー: decisions ---

/**
 * decisions.jsonl と文書内容の乖離を検出する。
 */
function checkDecisions(docs: DocContent[], decisions: Decision[]): Issue[] {
  const issues: Issue[] = []
  const docNames = new Set(docs.map(d => d.path))

  for (const dec of decisions) {
    // 影響文書が存在するかチェック
    for (const affectedDoc of dec.affects) {
      if (!docNames.has(affectedDoc)) {
        issues.push({
          category: 'decisions',
          severity: 'warn',
          message: `${dec.id} の影響文書 ${affectedDoc} が見つからない`,
          suggestion: `文書が移動・削除されていないか確認してください`,
        })
      }
    }

    // 影響文書のフロントマターに決定IDが記載されているかチェック
    for (const affectedDoc of dec.affects) {
      const doc = docs.find(d => d.path === affectedDoc)
      if (doc && doc.frontmatter?.decisions) {
        if (!doc.frontmatter.decisions.includes(dec.id)) {
          issues.push({
            category: 'decisions',
            severity: 'info',
            message: `${affectedDoc} のフロントマターに ${dec.id} が記載されていない`,
            suggestion: `decisions: に ${dec.id} を追加してください`,
          })
        }
      }
    }
  }

  // 文書のフロントマターに記載されているが decisions.jsonl にない ID
  const decisionIds = new Set(decisions.map(d => d.id))
  for (const doc of docs) {
    if (doc.frontmatter?.decisions) {
      for (const id of doc.frontmatter.decisions) {
        if (!decisionIds.has(id)) {
          issues.push({
            category: 'decisions',
            severity: 'warn',
            message: `${doc.path} のフロントマターに記載された ${id} が decisions.jsonl に存在しない`,
            suggestion: 'decisions.jsonl を確認するか、フロントマターから削除してください',
          })
        }
      }
    }
  }

  return issues
}

// --- チェッカー: staleness ---

/**
 * last_reviewed vs 決定日時で、更新が必要な文書を検出する。
 */
function checkStaleness(docs: DocContent[], decisions: Decision[]): Issue[] {
  const issues: Issue[] = []

  for (const doc of docs) {
    const lastReviewed = doc.frontmatter?.last_reviewed
    if (!lastReviewed) continue

    const reviewDate = new Date(lastReviewed)

    // この文書に影響する決定のうち、レビュー日より後のものを検出
    const newerDecisions = decisions.filter(dec =>
      dec.affects.includes(doc.path) &&
      new Date(dec.created_at) > reviewDate
    )

    if (newerDecisions.length > 0) {
      const decIds = newerDecisions.map(d => d.id).join(', ')
      issues.push({
        category: 'staleness',
        severity: 'warn',
        message: `${doc.path} の last_reviewed (${lastReviewed}) より後に ${decIds} が記録されている`,
        suggestion: `${doc.path} を最新の決定に合わせて更新してください`,
      })
    }
  }

  return issues
}

// --- ドキュメント読み込み ---

async function loadDocs(projectDir: string): Promise<DocContent[]> {
  const entries = await readdir(projectDir)
  const mdFiles = entries.filter(f => f.endsWith('.md')).sort()

  const docs: DocContent[] = []
  for (const file of mdFiles) {
    const content = await readFile(join(projectDir, file), 'utf-8')
    const name = basename(file, '.md')
    const { frontmatter, body } = parseFrontmatter(content)

    docs.push({
      path: file,
      name,
      content,
      body,
      lines: content.split('\n'),
      frontmatter,
      sections: extractSectionNames(body),
      wikiLinks: extractWikiLinks(body),
    })
  }
  return docs
}

// --- メイン ---

const ALL_CATEGORIES: ConsistencyCategory[] = [
  'terminology', 'references', 'coverage', 'decisions', 'staleness',
]

export async function checkConsistency(input: CheckConsistencyInput): Promise<CheckConsistencyResult> {
  const { project_dir, focus } = input
  const categories = focus && focus.length > 0 ? focus : ALL_CATEGORIES

  const docs = await loadDocs(project_dir)
  const decisions = await loadDecisions(project_dir)

  const issues: Issue[] = []

  for (const category of categories) {
    switch (category) {
      case 'terminology':
        issues.push(...checkTerminology(docs))
        break
      case 'references':
        issues.push(...checkReferences(docs))
        break
      case 'coverage':
        issues.push(...checkCoverage(docs))
        break
      case 'decisions':
        issues.push(...checkDecisions(docs, decisions))
        break
      case 'staleness':
        issues.push(...checkStaleness(docs, decisions))
        break
    }
  }

  const summary = {
    errors: issues.filter(i => i.severity === 'error').length,
    warnings: issues.filter(i => i.severity === 'warn').length,
    info: issues.filter(i => i.severity === 'info').length,
  }

  const status: CheckConsistencyResult['status'] =
    summary.errors > 0 ? 'error' :
    summary.warnings > 0 ? 'warn' : 'ok'

  return { status, issues, summary }
}
