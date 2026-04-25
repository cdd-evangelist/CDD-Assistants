import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
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

export interface FolderStructureValidation {
  blockers: Blocker[]
  warnings: Warning[]
}

// DI 用の依存型
export interface ReadinessDeps {
  getDesignContext: (projectDir: string) => Promise<DesignContextResult>
  getConsistency: (projectDir: string) => Promise<CheckConsistencyResult>
  validateFolderStructure: (projectDir: string) => Promise<FolderStructureValidation>
}

/**
 * 設計文書標準 §5.1 のフォルダ構成に従っているかを検証する。
 *
 * 構成種別:
 * - 単一構成: project_dir 直下に basic-design.md がある
 * - 複数コンポーネント構成: サブフォルダのいずれかが basic-design.md を持つ（§5.4）
 *
 * Builder 必須項目（basic-design.md, 3-details/）の欠落は blocker、
 * 推奨項目（1-usecases/, 2-features/）の欠落は warning。
 */
export async function defaultValidateFolderStructure(
  projectDir: string,
): Promise<FolderStructureValidation> {
  const blockers: Blocker[] = []
  const warnings: Warning[] = []

  type Target = { name: string | null; dir: string }

  const directBasic = existsSync(join(projectDir, 'basic-design.md'))
  let targets: Target[] = []

  if (directBasic) {
    targets = [{ name: null, dir: projectDir }]
  } else {
    let entries: Dirent[] = []
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    } catch {
      // ディレクトリが読めない場合は components 空のまま進める
    }
    const components: Target[] = entries
      .filter(e => e.isDirectory() && existsSync(join(projectDir, e.name, 'basic-design.md')))
      .map(e => ({ name: e.name, dir: join(projectDir, e.name) }))

    if (components.length === 0) {
      blockers.push({
        type: 'missing_basic_design',
        message: 'basic-design.md が見つからない',
        suggestion:
          'project_dir 直下、またはコンポーネントフォルダ直下に basic-design.md を配置してください（設計文書標準 §5.1 参照）',
      })
      return { blockers, warnings }
    }
    targets = components
  }

  for (const t of targets) {
    const ctx = t.name ? `（component: ${t.name}）` : ''

    if (!existsSync(join(t.dir, '3-details'))) {
      blockers.push({
        type: 'missing_details_dir',
        message: `Builder のチャンク化対象フォルダ 3-details/ が存在しない${ctx}`,
        suggestion: `${t.dir}/3-details/ を作成し、詳細設計文書を配置してください（設計文書標準 §5.1 参照）`,
      })
    }

    if (!existsSync(join(t.dir, '1-usecases'))) {
      warnings.push({
        type: 'missing_usecases_dir',
        message: `推奨フォルダ 1-usecases/ が存在しない${ctx}`,
      })
    }

    if (!existsSync(join(t.dir, '2-features'))) {
      warnings.push({
        type: 'missing_features_dir',
        message: `推奨フォルダ 2-features/ が存在しない${ctx}`,
      })
    }
  }

  return { blockers, warnings }
}

const defaultDeps: ReadinessDeps = {
  getDesignContext: (dir) => designContext({ project_dir: dir }),
  getConsistency: (dir) => checkConsistency({ project_dir: dir }),
  validateFolderStructure: defaultValidateFolderStructure,
}

/**
 * 設計文書群が Builder に渡せる状態か判定する。
 */
export async function checkReadiness(
  input: CheckReadinessInput,
  deps: ReadinessDeps = defaultDeps,
): Promise<CheckReadinessResult> {
  const { project_dir, required_coverage = [] } = input

  const [ctx, consistency, folderStructure] = await Promise.all([
    deps.getDesignContext(project_dir),
    deps.getConsistency(project_dir),
    deps.validateFolderStructure(project_dir),
  ])

  const blockers: Blocker[] = [...folderStructure.blockers]
  const warnings: Warning[] = [...folderStructure.warnings]

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
