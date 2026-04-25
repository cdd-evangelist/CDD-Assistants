import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter } from '../utils/frontmatter.js'
import {
  extractSectionNames,
  extractWikiLinks,
  estimateTokens,
  inferDocStatus,
  extractOpenQuestions,
  inferLayer,
} from '../utils/markdown.js'
import { loadDecisions } from '../utils/decisions.js'
import type {
  DesignContextInput,
  DesignContextResult,
  DocumentSummary,
  OverallProgress,
  UnresolvedQuestion,
  ParsedDocument,
} from '../types.js'

const BUNDLED_STANDARD_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'templates',
  'design-doc-standard.md',
)

/**
 * 設計文書標準のパスを解決する。
 * プロジェクト内 docs/design-doc-standard.md → プロジェクト直下 → バンドル版 の順。
 * どこにも存在しなければ null を返す。
 */
function resolveStandardDocPath(projectDir: string): string | null {
  const candidates = [
    join(projectDir, 'docs', 'design-doc-standard.md'),
    join(projectDir, 'design-doc-standard.md'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c)
  }
  if (existsSync(BUNDLED_STANDARD_PATH)) return BUNDLED_STANDARD_PATH
  return null
}

/**
 * プロジェクトディレクトリ内の .md ファイルをパースする。
 */
async function parseDocuments(projectDir: string): Promise<ParsedDocument[]> {
  const entries = await readdir(projectDir)
  const mdFiles = entries.filter(f => f.endsWith('.md')).sort()

  const docs: ParsedDocument[] = []
  for (const file of mdFiles) {
    const filePath = join(projectDir, file)
    const content = await readFile(filePath, 'utf-8')
    const name = basename(file, '.md')
    const { frontmatter, body } = parseFrontmatter(content)

    docs.push({
      path: file,
      name,
      content,
      body,
      frontmatter,
      lines: content.split('\n').length,
      sections: extractSectionNames(body),
      wikiLinks: extractWikiLinks(body),
      estimatedTokens: estimateTokens(content),
    })
  }

  return docs
}

/**
 * 設計状況スナップショットを生成する。
 */
export async function designContext(input: DesignContextInput): Promise<DesignContextResult> {
  const { project_dir } = input
  const docs = await parseDocuments(project_dir)
  const decisions = await loadDecisions(project_dir)

  // 文書名セット（wiki-link 解決用）
  const docNameSet = new Set(docs.map(d => d.name))

  // 依存グラフ構築
  const dependencyGraph: Record<string, string[]> = {}
  for (const doc of docs) {
    const refs = doc.wikiLinks
      .filter(link => docNameSet.has(link) && link !== doc.name)
      .map(r => `${r}.md`)
    dependencyGraph[doc.path] = refs
  }

  // referenced_by 構築
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

  // 決定事項をパス別にまとめる
  const decisionsByDoc = new Map<string, string[]>()
  for (const dec of decisions) {
    for (const affectedDoc of dec.affects) {
      const existing = decisionsByDoc.get(affectedDoc) ?? []
      existing.push(dec.id)
      decisionsByDoc.set(affectedDoc, existing)
    }
  }

  // DocumentSummary 組み立て
  const documents: DocumentSummary[] = docs.map(doc => {
    const status = doc.frontmatter?.status ?? inferDocStatus(doc.body, doc.sections)
    const layer = doc.frontmatter?.layer ?? inferLayer(doc.name, doc.body)
    const fmDecisions = doc.frontmatter?.decisions ?? []
    const docDecisions = decisionsByDoc.get(doc.path) ?? []
    const allDecisions = [...new Set([...fmDecisions, ...docDecisions])]
    const fmQuestions = doc.frontmatter?.open_questions ?? []
    const bodyQuestions = extractOpenQuestions(doc.body)
    const allQuestions = [...new Set([...fmQuestions, ...bodyQuestions])]

    return {
      path: doc.path,
      status,
      layer,
      estimated_tokens: doc.estimatedTokens,
      sections: doc.sections,
      decisions: allDecisions,
      open_questions: allQuestions,
      references_to: dependencyGraph[doc.path] ?? [],
      referenced_by: referencedByMap.get(doc.path) ?? [],
      ...(doc.frontmatter?.last_reviewed ? { last_reviewed: doc.frontmatter.last_reviewed } : {}),
    }
  })

  // 進捗サマリー
  const progress: OverallProgress = {
    complete: documents.filter(d => d.status === 'complete').length,
    in_progress: documents.filter(d => d.status === 'in_progress').length,
    draft: documents.filter(d => d.status === 'draft').length,
    total: documents.length,
    readiness: 'not_ready',
  }

  // readiness 判定
  const hasBlockingQuestions = documents.some(d => d.open_questions.length > 0 && d.status !== 'complete')
  if (progress.complete === progress.total) {
    progress.readiness = 'ready'
  } else if (progress.draft === 0 && !hasBlockingQuestions) {
    progress.readiness = 'nearly_ready'
  }

  // 未解決質問の収集
  const unresolved_questions: UnresolvedQuestion[] = []
  for (const doc of documents) {
    for (const q of doc.open_questions) {
      unresolved_questions.push({
        source: doc.path,
        question: q,
        blocking: doc.status !== 'complete',
      })
    }
  }

  // プロジェクト名をディレクトリ名から推定
  const project = basename(project_dir)
  const totalTokens = docs.reduce((sum, d) => sum + d.estimatedTokens, 0)

  return {
    project,
    documents,
    overall_progress: progress,
    unresolved_questions,
    dependency_graph: dependencyGraph,
    total_tokens: totalTokens,
    standard_doc_path: resolveStandardDocPath(project_dir),
  }
}
