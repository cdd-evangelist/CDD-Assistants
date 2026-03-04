import type {
  CheckReadinessInput,
  CheckReadinessResult,
  Blocker,
  Warning,
  DesignContextResult,
  CheckConsistencyResult,
} from '../types.js'
import { designContext } from './design-context.js'
import { checkConsistency } from './check-consistency.js'

// DI 用の依存型
export interface ReadinessDeps {
  getDesignContext: (projectDir: string) => Promise<DesignContextResult>
  getConsistency: (projectDir: string) => Promise<CheckConsistencyResult>
}

const defaultDeps: ReadinessDeps = {
  getDesignContext: (dir) => designContext({ project_dir: dir }),
  getConsistency: (dir) => checkConsistency({ project_dir: dir }),
}

/**
 * 設計文書群が Builder に渡せる状態か判定する。
 */
export async function checkReadiness(
  input: CheckReadinessInput,
  deps: ReadinessDeps = defaultDeps,
): Promise<CheckReadinessResult> {
  const { project_dir, required_coverage = [] } = input

  const [ctx, consistency] = await Promise.all([
    deps.getDesignContext(project_dir),
    deps.getConsistency(project_dir),
  ])

  const blockers: Blocker[] = []
  const warnings: Warning[] = []

  // 1. 文書完了チェック
  const incomplete = ctx.documents.filter(d => d.status !== 'complete')
  if (incomplete.length > 0) {
    const names = incomplete.map(d => d.path).join(', ')
    blockers.push({
      type: 'incomplete_documents',
      message: `未完了の文書が ${incomplete.length} 件: ${names}`,
      suggestion: '全文書の status を complete にしてください',
    })
  }

  // 2. 未決事項チェック
  const blockingQuestions = ctx.unresolved_questions.filter(q => q.blocking)
  if (blockingQuestions.length > 0) {
    blockers.push({
      type: 'blocking_questions',
      message: `ブロッキングな未決事項が ${blockingQuestions.length} 件`,
      suggestion: blockingQuestions.map(q => `${q.source}: ${q.question}`).join('; '),
    })
  }

  // 3. 整合性チェック
  const consistencyErrors = consistency.issues.filter(i => i.severity === 'error')
  if (consistencyErrors.length > 0) {
    blockers.push({
      type: 'consistency_errors',
      message: `整合性エラーが ${consistencyErrors.length} 件`,
      suggestion: consistencyErrors.map(i => i.message).join('; '),
    })
  }

  const consistencyWarnings = consistency.issues.filter(i => i.severity === 'warn')
  if (consistencyWarnings.length > 0) {
    warnings.push({
      type: 'consistency',
      message: `整合性の警告が ${consistencyWarnings.length} 件`,
    })
  }

  // 4. カバレッジチェック
  if (required_coverage.length > 0) {
    const docLayers = new Set(ctx.documents.map(d => d.layer))
    const sections = new Set(ctx.documents.flatMap(d => d.sections.map(s => s.toLowerCase())))
    const allContent = ctx.documents.map(d => d.path.toLowerCase()).join(' ')

    for (const req of required_coverage) {
      const reqLower = req.toLowerCase()
      const found =
        docLayers.has(reqLower as any) ||
        sections.has(reqLower) ||
        allContent.includes(reqLower)

      if (!found) {
        blockers.push({
          type: 'missing_coverage',
          message: `必要な設計領域 "${req}" が文書化されていない`,
          suggestion: `${req} に関する文書を作成してください`,
        })
      }
    }
  }

  // 5. 技術選定チェック — 最低限の確認
  const hasLang = ctx.documents.some(d =>
    d.sections.some(s => /技術|tech|言語|language/i.test(s)) ||
    /TypeScript|Python|Rust|Go|Java/i.test(d.path)
  )
  if (!hasLang && ctx.documents.length >= 3) {
    warnings.push({
      type: 'tech_stack',
      message: '技術選定（言語・フレームワーク）に関する記述が見つからない',
    })
  }

  const ready = blockers.length === 0

  // ハンドオフサマリー生成
  const total = ctx.overall_progress.total
  const complete = ctx.overall_progress.complete
  let handoff_summary: string

  if (ready) {
    handoff_summary = `${total}文書すべて完了。Builder に渡せる状態です`
    if (warnings.length > 0) {
      handoff_summary += `（警告 ${warnings.length} 件あり）`
    }
  } else {
    handoff_summary = `${total}文書中${complete}完了、ブロッカー${blockers.length}件を解消すれば Builder に渡せます`
  }

  return { ready, blockers, warnings, handoff_summary }
}
