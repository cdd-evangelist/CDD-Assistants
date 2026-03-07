import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ChunkExecutor, PreparedChunk, ExecutionResult } from '../types.js'

const execFileAsync = promisify(execFile)

interface ClaudeCodeConfig {
  model?: string // "sonnet", "haiku", "opus" など
  timeout?: number // ミリ秒（デフォルト: 5分）
  allowedTools?: string[] // 許可するツール
}

/**
 * 実装前のファイル一覧を取得する（差分検出用）
 */
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

/**
 * claude-code アダプタ
 *
 * claude CLI をサブプロセスで起動し、各チャンクを独立した
 * Claude Code セッションで実行する。
 */
export class ClaudeCodeExecutor implements ChunkExecutor {
  private config: Required<ClaudeCodeConfig>

  constructor(config: ClaudeCodeConfig = {}) {
    this.config = {
      model: config.model ?? 'sonnet',
      timeout: config.timeout ?? 5 * 60 * 1000,
      allowedTools: config.allowedTools ?? [
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
      ],
    }
  }

  async execute(chunk: PreparedChunk): Promise<ExecutionResult> {
    // 実装前のファイル一覧を取得
    const beforeFiles = await listFiles(chunk.working_dir)

    // プロンプトを組み立て
    const prompt = this.buildPrompt(chunk)

    try {
      // claude CLI を非対話モードで実行
      const args = [
        '-p', prompt,
        '--output-format', 'text',
        '--model', this.config.model,
        '--max-turns', '30',
      ]

      // allowedTools を追加
      for (const tool of this.config.allowedTools) {
        args.push('--allowedTools', tool)
      }

      await execFileAsync('claude', args, {
        cwd: chunk.working_dir,
        timeout: this.config.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      })

      // 実装後のファイル一覧を取得し、差分を検出
      const afterFiles = await listFiles(chunk.working_dir)
      const generatedFiles: string[] = []

      for (const [path, mtime] of afterFiles) {
        const beforeMtime = beforeFiles.get(path)
        if (beforeMtime === undefined || mtime > beforeMtime) {
          generatedFiles.push(path)
        }
      }

      // リファレンスドキュメントを generated_files から分離
      const referenceDoc = generatedFiles.find(f => f === chunk.reference_doc)

      return {
        success: true,
        generated_files: generatedFiles,
        reference_doc: referenceDoc,
      }
    } catch (err: unknown) {
      const error = err as { stderr?: string; stdout?: string; message?: string }
      return {
        success: false,
        generated_files: [],
        error: error.stderr || error.message || '実行に失敗',
      }
    }
  }

  private buildPrompt(chunk: PreparedChunk): string {
    const sections = [
      `# 実装指示: ${chunk.name}`,
      '',
      chunk.implementation_prompt,
      '',
      '## 生成するファイル',
      ...chunk.expected_outputs.map(f => `- ${f}`),
      '',
      '## 完了条件',
      ...chunk.completion_criteria.map(c => `- ${c}`),
      '',
      '## リファレンスドキュメント',
      '',
      `実装が完了したら、以下のパスにリファレンスドキュメントを作成してください: \`${chunk.reference_doc}\``,
      '',
      'リファレンスには以下を日本語で記述してください:',
      '- 実装したモジュール・関数の概要と役割',
      '- 公開インターフェース（型、引数、戻り値）',
      '- 設計文書のどの部分を実装したか',
      '- 実装上の判断や補足事項',
      '',
      '重要: 上記のファイルとリファレンスドキュメントを全て生成し、完了条件を満たすコードを書いてください。',
      'テストファイルが含まれる場合は、テストが通ることを確認してください。',
    ]

    return sections.join('\n')
  }
}
