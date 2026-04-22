import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type {
  ChunkExecutor,
  PreparedChunk,
  ExecutionResult,
  TestGenerationResult,
  DivergenceReport,
  Artifacts,
  InvestigationResult,
} from '../types.js'

const execFileAsync = promisify(execFile)

interface ClaudeCodeConfig {
  model?: string
  timeout?: number
  allowedTools?: string[]
}

const DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']
const DEFAULT_TIMEOUT = 5 * 60 * 1000  // 5分
const DEFAULT_MODEL   = 'sonnet'

// --- ファイル差分検出 ---

async function listFiles(dir: string): Promise<Map<string, number>> {
  const files = new Map<string, number>()

  async function walk(current: string): Promise<void> {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name)
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else {
        const s = await stat(fullPath)
        files.set(relative(dir, fullPath), s.mtimeMs)
      }
    }
  }

  await walk(dir)
  return files
}

function detectGeneratedFiles(
  before: Map<string, number>,
  after: Map<string, number>,
): string[] {
  const generated: string[] = []
  for (const [path, mtime] of after) {
    const beforeMtime = before.get(path)
    if (beforeMtime === undefined || mtime > beforeMtime) {
      generated.push(path)
    }
  }
  return generated
}

// --- テストファイル判定 ---

function isTestFile(path: string): boolean {
  return (
    path.includes('test/') ||
    path.includes('tests/') ||
    path.includes('spec/') ||
    /\.(test|spec)\.[^.]+$/.test(path)
  )
}

// --- プロンプト組み立て（agent-prompts.md §3.3 / §4.3 / §5.3） ---

/**
 * Test Agent プロンプトを組み立てる（agent-prompts.md §3.3）。
 * 設計文書と test_requirements のみをコンテキストに使い、実装コードを渡さない。
 */
export function buildTestAgentPrompt(chunk: PreparedChunk): string {
  const testFiles = chunk.expected_outputs.filter(isTestFile)
  const req = chunk.test_requirements

  const interfaceTests = req.interface_tests.length > 0
    ? req.interface_tests.map(t => `  - ${t}`).join('\n')
    : '  （なし）'
  const boundaryTests = req.boundary_tests.length > 0
    ? req.boundary_tests.map(t => `  - ${t}`).join('\n')
    : '  （なし）'
  const integrationRefs = req.integration_refs.length > 0
    ? req.integration_refs.map(t => `  - ${t}`).join('\n')
    : '  （なし）'

  return [
    'あなたは Test Agent です。設計文書とテスト要件から逆算してテストコードを書きます。',
    '実装コードは一切見ていません。これは意図的な分離で、共有バイアスを排除するためです。',
    '',
    '## 担当するチャンク',
    `${chunk.id}: ${chunk.name}`,
    '',
    '## 設計文書（該当セクション）',
    chunk.implementation_prompt,
    '',
    '## テスト要件',
    `- インターフェーステスト:\n${interfaceTests}`,
    `- 境界値テスト:\n${boundaryTests}`,
    `- 統合ポイント:\n${integrationRefs}`,
    '',
    '## 生成すべきテストファイル',
    ...testFiles.map(f => `- ${f}`),
    '',
    '## 指示',
    '1. 設計仕様から逆算してテストを書いてください',
    '2. 実装はまだ存在しないので、インポートパスは expected_outputs から推測してください',
    '3. 全テストが FAIL する状態で提出してください（Red フェーズ）',
    '4. `assert True` のような空テストは書かないでください — 設計要件を必ず検証してください',
  ].join('\n')
}

/**
 * Impl Agent プロンプトを組み立てる（agent-prompts.md §4.3）。
 * テストコード + 設計文書をコンテキストに使い、実装とリファレンスを生成する。
 */
export function buildImplAgentPrompt(chunk: PreparedChunk, testCode: string): string {
  const implFiles = chunk.expected_outputs.filter(f => !isTestFile(f))

  const lines = [
    'あなたは Impl Agent です。Test Agent が書いたテストを全て PASS させる実装を書き、',
    '実装完了後にリファレンス（日本語文書）を生成します。',
    '',
    '## 担当するチャンク',
    `${chunk.id}: ${chunk.name}`,
    '',
    '## 実装プロンプト（設計文書由来）',
    chunk.implementation_prompt,
    '',
    '## 満たすべきテスト',
    testCode || '（テストコードなし）',
    '',
    '## 生成すべきファイル',
    ...implFiles.map(f => `- ${f}`),
    '',
    '## 完了条件',
    ...chunk.completion_criteria.map(c => `- ${c}`),
  ]

  if (chunk.coding_standards_digest) {
    lines.push('', '## コード規約', chunk.coding_standards_digest)
  }

  lines.push(
    '',
    '## 作業手順',
    '1. テストコードを読んで、何を実装すべきか把握する',
    '2. 実装を書く',
    '3. テストを実行して全 PASS を確認する',
    '4. リファレンスを生成する（詳細は下記）',
    '',
    '## リファレンス生成指示',
    '',
    `実装完了後、${chunk.reference_doc} に以下を日本語で記述してください:`,
    '',
    '1. モジュール構成の概要（ファイル構成と各モジュールの役割）',
    '2. 公開インターフェース（関数シグネチャ、入力型・出力型）',
    '3. 実装ロジック（処理の流れ、使用アルゴリズム・ヒューリスティクス）',
    '4. 型定義（主要な型とその関係）',
    '',
    '**重要な制約**:',
    '- リファレンスは**実装したコードだけを見て書いてください**',
    '- 設計文書やテストを参照しないでください',
    '- 推測を含めないでください（「こうだろう」ではなく「こうなっている」で書く）',
  )

  return lines.join('\n')
}

/**
 * Investigation Agent プロンプトを組み立てる（agent-prompts.md §5.3）。
 */
function buildInvestigationPrompt(
  chunk: PreparedChunk,
  divergence: DivergenceReport,
  artifacts: Artifacts,
): string {
  const divergenceText = divergence.items
    .map(item => `- [${item.severity}] ${item.category}: ${item.description}`)
    .join('\n')

  return [
    'あなたは Investigation Agent です。',
    'ラウンドトリップ照合で検出された乖離の真因を分類し、差し戻し先を決定します。',
    '',
    '## 担当チャンク',
    `${chunk.id}: ${chunk.name}`,
    '',
    '## 照合結果',
    divergenceText,
    '',
    '## 設計文書（該当セクション）',
    artifacts.design_doc,
    '',
    '## 実装コード',
    `（ファイル: ${artifacts.implementation.join(', ')}）`,
    '',
    '## テストコード',
    `（ファイル: ${artifacts.tests.join(', ')}）`,
    '',
    '## 判断材料（必ず全てチェックしてください）',
    '',
    '1. 設計文書の記述は一意に解釈できるか',
    '   → 複数解釈が可能なら「設計の曖昧さ」',
    '2. テストが設計要件を網羅しているか',
    '   → 網羅不足なら「テスト不足」',
    '3. 実装が設計に沿っているか',
    '   → 沿っていなければ「実装の問題」',
    '',
    '## 重要な注意',
    '',
    '「実装の問題」と判断しがちな誤判断を避けてください。',
    '設計が曖昧なのに Impl Agent に繰り返し差し戻すと、実装デッドロックが発生します。',
    '「1. 設計の一意性」を最初に評価し、曖昧なら迷わず「設計の曖昧さ」と判定してください。',
    '',
    '## 出力フォーマット',
    '',
    '以下の JSON で応答してください:',
    '',
    '{',
    '  "verdict": "implementation | design_ambiguity | test_insufficient",',
    '  "reasoning": "判定理由（日本語、2〜3文）",',
    '  "suggested_action": "差し戻し先への具体的な指示"',
    '}',
  ].join('\n')
}

// --- claude CLI 実行ユーティリティ ---

async function runClaude(
  prompt: string,
  workingDir: string,
  config: Required<ClaudeCodeConfig>,
): Promise<{ stdout: string; error?: string }> {
  const args = [
    '-p', prompt,
    '--output-format', 'text',
    '--model', config.model,
    '--max-turns', '30',
  ]
  for (const tool of config.allowedTools) {
    args.push('--allowedTools', tool)
  }

  try {
    const result = await execFileAsync('claude', args, {
      cwd: workingDir,
      timeout: config.timeout,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { stdout: (result as { stdout: string }).stdout ?? '' }
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    return { stdout: '', error: e.stderr || e.message || '実行失敗' }
  }
}

// --- ClaudeCodeExecutor ---

export class ClaudeCodeExecutor implements ChunkExecutor {
  private config: Required<ClaudeCodeConfig>

  constructor(config: ClaudeCodeConfig = {}) {
    this.config = {
      model:        config.model        ?? DEFAULT_MODEL,
      timeout:      config.timeout      ?? DEFAULT_TIMEOUT,
      allowedTools: config.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
    }
  }

  async generateTests(chunk: PreparedChunk): Promise<TestGenerationResult> {
    const prompt = buildTestAgentPrompt(chunk)
    const before = await listFiles(chunk.working_dir)

    const { error } = await runClaude(prompt, chunk.working_dir, this.config)
    if (error) return { success: false, test_files: [], error }

    const after = await listFiles(chunk.working_dir)
    const generated = detectGeneratedFiles(before, after)
    const testFiles = generated.filter(isTestFile)

    return { success: true, test_files: testFiles }
  }

  async implement(chunk: PreparedChunk, testFiles: string[]): Promise<ExecutionResult> {
    // テストコードを読み込む
    const testCodeParts: string[] = []
    for (const tf of testFiles) {
      try {
        const content = await readFile(join(chunk.working_dir, tf), 'utf-8')
        testCodeParts.push(`// --- ${tf} ---\n${content}`)
      } catch {
        testCodeParts.push(`// --- ${tf} (読み込み失敗) ---`)
      }
    }
    const testCode = testCodeParts.join('\n\n')

    const prompt = buildImplAgentPrompt(chunk, testCode)
    const before = await listFiles(chunk.working_dir)

    const { error } = await runClaude(prompt, chunk.working_dir, this.config)
    if (error) return { success: false, generated_files: [], error }

    const after = await listFiles(chunk.working_dir)
    const generated = detectGeneratedFiles(before, after)
    const referenceDoc = generated.find(f => f === chunk.reference_doc)

    return { success: true, generated_files: generated, reference_doc: referenceDoc }
  }

  async investigate(
    chunk: PreparedChunk,
    divergence: DivergenceReport,
    artifacts: Artifacts,
  ): Promise<InvestigationResult> {
    const prompt = buildInvestigationPrompt(chunk, divergence, artifacts)

    const { stdout, error } = await runClaude(prompt, chunk.working_dir, this.config)
    if (error) {
      return {
        verdict: 'implementation',
        reasoning: `Investigation Agent の実行に失敗: ${error}`,
        suggested_action: '人が手動で確認してください',
      }
    }

    // JSON ブロックを抽出して解析
    const jsonMatch = stdout.match(/\{[\s\S]*"verdict"[\s\S]*\}/)
    if (!jsonMatch) {
      return {
        verdict: 'implementation',
        reasoning: `Investigation Agent の出力が JSON 形式でない: ${stdout.slice(0, 200)}`,
        suggested_action: '人が手動で確認してください',
      }
    }

    try {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        verdict: parsed.verdict ?? 'implementation',
        reasoning: parsed.reasoning ?? parsed.reason ?? '',
        suggested_action: parsed.suggested_action ?? parsed.next_action ?? '',
      }
    } catch {
      return {
        verdict: 'implementation',
        reasoning: `JSON パース失敗: ${jsonMatch[0].slice(0, 200)}`,
        suggested_action: '人が手動で確認してください',
      }
    }
  }
}
