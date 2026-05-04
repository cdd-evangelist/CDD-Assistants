import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CommitHint } from '../types.js'

const execFileAsync = promisify(execFile)

export interface CommitHintContext {
  reason: CommitHint['reason']
  suggested_message: string
}

export interface CommitHintOptions {
  maxPaths?: number
  timeoutMs?: number
}

const DEFAULT_MAX_PATHS = 20
const DEFAULT_TIMEOUT_MS = 5000

/**
 * `git status --porcelain` の 1 行から、変更後のパスだけを抜き出す。
 * リネーム（R/C）は `old -> new` 形式なので new を採用する。
 * クォート付きパス（空白を含む等）は中身を取り出す。
 */
function extractPath(line: string): string {
  // 先頭 3 文字（XY + space）を除去
  let raw = line.slice(3).trim()
  // リネーム / コピー: `old -> new`
  const arrowIdx = raw.indexOf(' -> ')
  if (arrowIdx !== -1) {
    raw = raw.slice(arrowIdx + 4).trim()
  }
  // クォート除去
  const quoted = raw.match(/^"(.*)"$/)
  if (quoted) return quoted[1]
  return raw
}

/**
 * 指定ディレクトリで `git status --porcelain` を呼び、未コミットの変更があれば
 * commit_hint を返す。変更なし / git リポジトリでない / git コマンド失敗の場合は null。
 *
 * Builder / Planner のツールが「自然な commit ポイント」をエージェントに知らせるための共通ヘルパー。
 * ツールはコミットそのものは行わず、エージェントが判断する材料だけを返す。
 */
export async function getCommitHint(
  workingDir: string,
  context: CommitHintContext,
  options: CommitHintOptions = {},
): Promise<CommitHint | null> {
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let stdout: string
  try {
    // --untracked-files=all で新規ディレクトリ配下のファイルも個別に列挙する。
    // デフォルト（normal）だと dir/ にまとめられて changed_paths が情報量を失う。
    const result = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: workingDir,
      timeout: timeoutMs,
    })
    stdout = result.stdout
  } catch {
    // git リポジトリでない / git 未インストール / タイムアウト等
    return null
  }

  const lines = stdout.split('\n').filter(line => line.length > 0)
  if (lines.length === 0) return null

  const changed_paths = lines.slice(0, maxPaths).map(extractPath)

  return {
    uncommitted_files: lines.length,
    changed_paths,
    suggested_message: context.suggested_message,
    reason: context.reason,
  }
}
