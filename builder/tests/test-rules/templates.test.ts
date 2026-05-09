import { describe, it, expect } from 'vitest'
import { BUILTIN_TEMPLATES } from '../../src/test-rules/templates.js'
import type { RuleTemplate } from '../../src/test-rules/templates.js'

describe('BUILTIN_TEMPLATES', () => {
  it('RuleTemplate[] 型に適合する', () => {
    const templates: RuleTemplate[] = BUILTIN_TEMPLATES
    expect(templates).toBeDefined()
    expect(Array.isArray(templates)).toBe(true)
  })

  it('mock-cjs-default と mock-hoisting の2件を含む', () => {
    const ids = BUILTIN_TEMPLATES.map(t => t.id)
    expect(ids).toContain('mock-cjs-default')
    expect(ids).toContain('mock-hoisting')
    expect(BUILTIN_TEMPLATES).toHaveLength(2)
  })

  it('各テンプレートの必須フィールドが揃っている', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.id).toBeTruthy()
      expect(t.framework).toBeTruthy()
      expect(t.scope).toBeTruthy()
      expect(t.error_pattern).toBeTruthy()
      expect(t.description).toBeTruthy()
      expect(t.rule_template).toBeTruthy()
    }
  })

  it('error_pattern が空でない', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.error_pattern.length).toBeGreaterThan(0)
    }
  })

  it('error_pattern が有効な正規表現である（無効なら RegExp コンストラクタが例外を投げる）', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(() => new RegExp(t.error_pattern)).not.toThrow()
    }
  })

  it('scope が global | project のいずれかである', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(['global', 'project']).toContain(t.scope)
    }
  })

  describe('mock-cjs-default', () => {
    const tmpl = BUILTIN_TEMPLATES.find(t => t.id === 'mock-cjs-default')!

    it('framework が vitest', () => {
      expect(tmpl.framework).toBe('vitest')
    })

    it('scope が global', () => {
      expect(tmpl.scope).toBe('global')
    })

    it('error_pattern が vitest の CJS エラーにマッチする', () => {
      const re = new RegExp(tmpl.error_pattern)
      expect(re.test('No "default" export is defined on the "web-push" mock.')).toBe(true)
    })
  })

  describe('mock-hoisting', () => {
    const tmpl = BUILTIN_TEMPLATES.find(t => t.id === 'mock-hoisting')!

    it('framework が vitest', () => {
      expect(tmpl.framework).toBe('vitest')
    })

    it('scope が global', () => {
      expect(tmpl.scope).toBe('global')
    })

    it('error_pattern が hoisting エラーにマッチする', () => {
      const re = new RegExp(tmpl.error_pattern)
      expect(re.test('Cannot access "mockFn" before initialization')).toBe(true)
    })
  })
})
