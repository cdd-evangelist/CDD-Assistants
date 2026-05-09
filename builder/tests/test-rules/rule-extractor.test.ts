import { describe, it, expect } from 'vitest'
import { matchErrorToTemplate, instantiateRule } from '../../src/test-rules/rule-extractor.js'
import { BUILTIN_TEMPLATES } from '../../src/test-rules/templates.js'

const CJS_ERROR = 'No "default" export is defined on the "web-push" mock.'
const HOISTING_ERROR = 'Cannot access "mockFn" before initialization'
const UNRELATED_ERROR = 'TypeError: Cannot read properties of undefined (reading "foo")'

describe('matchErrorToTemplate', () => {
  it('RuleTemplate | null を返す', () => {
    const result = matchErrorToTemplate(CJS_ERROR, 'vitest')
    expect(result === null || typeof result === 'object').toBe(true)
  })

  it('vitest の CJS エラーで mock-cjs-default がマッチする', () => {
    const result = matchErrorToTemplate(CJS_ERROR, 'vitest')
    expect(result).not.toBeNull()
    expect(result!.id).toBe('mock-cjs-default')
  })

  it('hoisting エラーで mock-hoisting がマッチする', () => {
    const result = matchErrorToTemplate(HOISTING_ERROR, 'vitest')
    expect(result).not.toBeNull()
    expect(result!.id).toBe('mock-hoisting')
  })

  it('無関係なエラーで null が返る', () => {
    const result = matchErrorToTemplate(UNRELATED_ERROR, 'vitest')
    expect(result).toBeNull()
  })

  it('framework が jest のとき vitest テンプレートがマッチしない', () => {
    const result = matchErrorToTemplate(CJS_ERROR, 'jest')
    expect(result).toBeNull()
  })

  it('空文字エラーで null が返る', () => {
    const result = matchErrorToTemplate('', 'vitest')
    expect(result).toBeNull()
  })

  it('framework が空文字のとき null が返る', () => {
    const result = matchErrorToTemplate(CJS_ERROR, '')
    expect(result).toBeNull()
  })
})

describe('instantiateRule', () => {
  const template = BUILTIN_TEMPLATES.find(t => t.id === 'mock-cjs-default')!

  it('StoredRule を返す', () => {
    const rule = instantiateRule(template, CJS_ERROR)
    expect(rule).toBeDefined()
    expect(typeof rule.id).toBe('string')
    expect(typeof rule.template_id).toBe('string')
    expect(typeof rule.framework).toBe('string')
    expect(typeof rule.rule).toBe('string')
    expect(typeof rule.created_at).toBe('string')
  })

  it('template_id が元テンプレートの id と一致する', () => {
    const rule = instantiateRule(template, CJS_ERROR)
    expect(rule.template_id).toBe('mock-cjs-default')
  })

  it('framework が元テンプレートの framework と一致する', () => {
    const rule = instantiateRule(template, CJS_ERROR)
    expect(rule.framework).toBe('vitest')
  })

  it('エラーコンテキストからパッケージ名を抽出して置換する', () => {
    const rule = instantiateRule(template, CJS_ERROR)
    expect(rule.rule).toContain('web-push')
    expect(rule.example_before).toContain('web-push')
    expect(rule.example_after).toContain('web-push')
  })

  it('パッケージ名が抽出できない場合はプレースホルダのままにする', () => {
    const rule = instantiateRule(template, UNRELATED_ERROR)
    expect(rule.rule).toContain('{{package}}')
  })

  it('created_at が ISO 8601 形式である', () => {
    const rule = instantiateRule(template, CJS_ERROR)
    expect(() => new Date(rule.created_at)).not.toThrow()
    expect(new Date(rule.created_at).toISOString()).toBe(rule.created_at)
  })

  it('id が毎回異なる（uuid）', () => {
    const rule1 = instantiateRule(template, CJS_ERROR)
    const rule2 = instantiateRule(template, CJS_ERROR)
    expect(rule1.id).not.toBe(rule2.id)
  })
})
