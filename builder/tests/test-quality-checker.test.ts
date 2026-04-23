import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkTestQuality } from '../src/execution-engine/test-quality-checker.js'
import type { TestRequirements } from '../src/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'test-quality-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

const emptyReq: TestRequirements = {
  interface_tests: [],
  boundary_tests: [],
  integration_refs: [],
}

async function writeTest(name: string, content: string): Promise<string> {
  const path = join(tmpDir, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  return path
}

describe('Assertion 品質チェック', () => {
  it('expect(true).toBe(true) は弱い assertion として検出する', async () => {
    const path = await writeTest('weak.test.ts', `
      import { it, expect } from 'vitest'
      it('test1', () => {
        expect(true).toBe(true)
      })
    `)
    const result = await checkTestQuality([path], tmpDir, emptyReq)
    expect(result.passed).toBe(false)
    expect(result.issues.some(i => i.includes('expect(true)'))).toBe(true)
  })

  it('toBeDefined() のみは弱い assertion として検出する', async () => {
    const path = await writeTest('weak2.test.ts', `
      it('test1', () => {
        const result = parse('x')
        expect(result).toBeDefined()
      })
    `)
    const result = await checkTestQuality([path], tmpDir, emptyReq)
    expect(result.passed).toBe(false)
    expect(result.issues.some(i => i.includes('toBeDefined'))).toBe(true)
  })

  it('まともな assertion なら passed', async () => {
    const path = await writeTest('good.test.ts', `
      it('parses correctly', () => {
        const result = parse('abc')
        expect(result.value).toBe(42)
        expect(result.tokens).toEqual(['a', 'b', 'c'])
      })
    `)
    const result = await checkTestQuality([path], tmpDir, emptyReq)
    expect(result.passed).toBe(true)
  })
})

describe('異常系の存在チェック', () => {
  it('boundary_tests が定義されているのに異常系テストが0個なら failed', async () => {
    const path = await writeTest('only-happy.test.ts', `
      it('happy path', () => {
        expect(parse('valid')).toBe(42)
      })
    `)
    const reqs: TestRequirements = {
      interface_tests: [],
      boundary_tests: ['不正な入力でエラー'],
      integration_refs: [],
    }
    const result = await checkTestQuality([path], tmpDir, reqs)
    expect(result.passed).toBe(false)
    expect(result.issues.some(i => i.includes('異常系'))).toBe(true)
  })

  it('toThrow を含むテストがあれば異常系として認める', async () => {
    const path = await writeTest('with-throw.test.ts', `
      it('parses', () => {
        expect(parse('x')).toBe(1)
      })
      it('throws on invalid', () => {
        expect(() => parse('')).toThrow()
      })
    `)
    const reqs: TestRequirements = {
      interface_tests: [],
      boundary_tests: ['空文字でエラー'],
      integration_refs: [],
    }
    const result = await checkTestQuality([path], tmpDir, reqs)
    expect(result.passed).toBe(true)
  })

  it('boundary_tests が空なら異常系チェックはスキップ', async () => {
    const path = await writeTest('only-happy2.test.ts', `
      it('happy', () => { expect(parse('x')).toBe('PARSED') })
    `)
    const result = await checkTestQuality([path], tmpDir, emptyReq)
    // 異常系不足は failed に含めない（boundary_tests が空）
    expect(result.passed).toBe(true)
  })
})

describe('パラメータ網羅・統合ポイント（警告）', () => {
  it('interface_tests のキーワードがテストに現れなければ warning に追加', async () => {
    const path = await writeTest('partial.test.ts', `
      it('foo works', () => { expect(foo()).toBe(1) })
    `)
    const reqs: TestRequirements = {
      interface_tests: ['parseConfig が動く'],
      boundary_tests: [],
      integration_refs: [],
    }
    const result = await checkTestQuality([path], tmpDir, reqs)
    // パラメータ網羅は failed にしない
    expect(result.passed).toBe(true)
    expect(result.issues.some(i => i.includes('parseConfig'))).toBe(true)
  })

  it('integration_refs のキーワードが現れなければ warning に追加', async () => {
    const path = await writeTest('iso.test.ts', `
      it('a', () => { expect(foo()).toBe('bar') })
    `)
    const reqs: TestRequirements = {
      interface_tests: [],
      boundary_tests: [],
      integration_refs: ['chunk-01 の出力との接続'],
    }
    const result = await checkTestQuality([path], tmpDir, reqs)
    expect(result.passed).toBe(true)
    expect(result.issues.some(i => i.includes('chunk-01'))).toBe(true)
  })
})

describe('テストファイル不在', () => {
  it('テストファイルが空配列なら passed（チェック対象なし）', async () => {
    const result = await checkTestQuality([], tmpDir, emptyReq)
    expect(result.passed).toBe(true)
    expect(result.issues).toHaveLength(0)
  })
})
