import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { TestRequirements } from '../types.js'

export interface TestQualityResult {
  passed: boolean
  issues: string[]
}

// 弱い assertion パターン（test-quality.md §3 の「何でも通る」検証）
const WEAK_ASSERTION_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /expect\s*\(\s*true\s*\)\.toBe\s*\(\s*true\s*\)/, description: 'expect(true).toBe(true)' },
  { pattern: /expect\s*\(\s*1\s*\)\.toBe\s*\(\s*1\s*\)/, description: 'expect(1).toBe(1)' },
  { pattern: /assert\s*\(\s*true\s*\)/, description: 'assert(true)' },
  { pattern: /assertTrue\s*\(\s*True\s*\)/, description: 'assertTrue(True)' },
]

// toBeDefined / not.toBeUndefined のみ（他の assert がない場合に弱いと判定）
const WEAK_ONLY_PATTERNS: RegExp[] = [
  /\.toBeDefined\s*\(/,
  /\.not\.toBeUndefined\s*\(/,
  /\.toBeTruthy\s*\(/,
]

// 異常系を示すキーワード（boundary_tests が定義されているときに探す）
const ERROR_TEST_PATTERNS: RegExp[] = [
  /\.toThrow\s*\(/,
  /\.toReject\s*\(/,
  /\brejects\.\w+/,
  /\bthrows?\b/i,
  /\berror\b/i,
  /\bエラー/,
  /\b例外/,
  /\b異常/,
  /\b不正/,
]

async function readTestFiles(testFiles: string[], workingDir: string): Promise<string> {
  const contents: string[] = []
  for (const f of testFiles) {
    const path = isAbsolute(f) ? f : join(workingDir, f)
    try {
      contents.push(await readFile(path, 'utf-8'))
    } catch {
      // 読めないファイルはスキップ
    }
  }
  return contents.join('\n')
}

/**
 * test_requirements 項目から重要そうなキーワードを抽出する。
 * 「parseConfig が動く」→ ["parseConfig"], 「chunk-01 との接続」→ ["chunk-01"]
 */
function extractKeywords(item: string): string[] {
  // 識別子っぽいトークン（英数字・ハイフン・アンダースコア、3文字以上）を抽出
  const matches = item.match(/[A-Za-z_][A-Za-z0-9_-]{2,}/g) ?? []
  return [...new Set(matches)]
}

/**
 * テスト本文にキーワードが含まれるかを判定する（prefix match）。
 * 右側の \b を外すことで camelCase / 接尾辞に対応する:
 *   "mock"   → "mockMermaidRender" / "vi.mock" / "mockImpl" すべてヒット
 *   "render" → "mermaid.render" / "rendering" 両方ヒット
 */
function containsKeyword(content: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}`).test(content)
}

// interface_tests のキーワード網羅率の最低閾値（半数以上ヒットしていれば pass）
const KEYWORD_MATCH_THRESHOLD = 0.5

/**
 * テスト品質を静的検証する。
 * - 弱い assertion → failed
 * - boundary_tests 定義時の異常系不足 → failed
 * - パラメータ網羅・統合ポイントの言及不足 → warning（passed には影響しない）
 */
export async function checkTestQuality(
  testFiles: string[],
  workingDir: string,
  requirements: TestRequirements
): Promise<TestQualityResult> {
  const issues: string[] = []
  let passed = true

  if (testFiles.length === 0) {
    return { passed: true, issues: [] }
  }

  const allContent = await readTestFiles(testFiles, workingDir)

  // 1. 弱い assertion パターン検出
  for (const { pattern, description } of WEAK_ASSERTION_PATTERNS) {
    if (pattern.test(allContent)) {
      issues.push(`弱い assertion を検出: ${description}`)
      passed = false
    }
  }

  // toBeDefined のみのテストを検出（他の強い assert がなければ弱い）
  // it/test ブロック単位で見るのは複雑なので、ファイル全体で
  // 「toBeDefined」だけが現れて他の値比較系（toBe/toEqual/toMatch等）が無ければ弱いと判定
  const hasStrongAssert = /\.toBe\s*\(|\.toEqual\s*\(|\.toMatch\s*\(|\.toContain\s*\(|\.toHaveLength\s*\(|\.toThrow\s*\(/.test(allContent)
  const hasOnlyWeakAssert = WEAK_ONLY_PATTERNS.some(p => p.test(allContent))
  if (hasOnlyWeakAssert && !hasStrongAssert) {
    issues.push('弱い assertion のみを検出: toBeDefined / toBeTruthy などの存在確認だけで具体的な値を検証していない')
    passed = false
  }

  // 2. 異常系の存在チェック（boundary_tests が定義されているとき）
  if (requirements.boundary_tests.length > 0) {
    const hasErrorTest = ERROR_TEST_PATTERNS.some(p => p.test(allContent))
    if (!hasErrorTest) {
      issues.push(
        `異常系テストが見当たらない（boundary_tests に ${requirements.boundary_tests.length} 項目あるが、` +
        `toThrow / error / 例外 等のキーワードがテストに現れない）`
      )
      passed = false
    }
  }

  // 3. パラメータ網羅（warning のみ）
  // 半数以上のキーワードがヒットしていれば pass。日本語化された英単語や camelCase で
  // 一部キーワードが落ちても拾える反面、真の漏れ（マッチ率 < 50%）は依然として警告する。
  for (const item of requirements.interface_tests) {
    const keywords = extractKeywords(item)
    if (keywords.length === 0) continue

    const matched = keywords.filter(k => containsKeyword(allContent, k))
    const ratio = matched.length / keywords.length
    if (ratio < KEYWORD_MATCH_THRESHOLD) {
      const matchedDesc = matched.length > 0 ? matched.join(', ') : 'なし'
      issues.push(
        `interface_tests "${item}" の網羅度が低い ` +
        `(マッチ ${matched.length}/${keywords.length}: ${matchedDesc} / 期待: ${keywords.join(', ')})`
      )
    }
  }

  // 4. 統合ポイント（warning のみ）
  // 接続先のキーワードが 1 つでもヒットすれば pass。
  for (const item of requirements.integration_refs) {
    const keywords = extractKeywords(item)
    if (keywords.length === 0) continue

    const anyFound = keywords.some(k => containsKeyword(allContent, k))
    if (!anyFound) {
      issues.push(`integration_refs "${item}" の統合テストが見当たらない（キーワード: ${keywords.join(', ')}）`)
    }
  }

  return { passed, issues }
}
