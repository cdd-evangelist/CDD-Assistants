import { describe, it, expect } from 'vitest'
import { suggestApproach } from '../src/tools/suggest-approach.js'

describe('suggestApproach', () => {
  it('コア3テンプレートを常に返す', () => {
    const result = suggestApproach({
      idea: '何か作りたい',
    })

    expect(result.approaches.length).toBeGreaterThanOrEqual(3)
    const names = result.approaches.map(a => a.name)
    expect(names).toContain('ユースケース駆動')
    expect(names).toContain('データモデル駆動')
    expect(names).toContain('インターフェース駆動')
  })

  it('コアテンプレートの source は core', () => {
    const result = suggestApproach({ idea: 'ツール作成' })
    const core = result.approaches.filter(a => a.source === 'core')
    expect(core.length).toBe(3)
  })

  it('セキュリティ関連のキーワードで脅威駆動を追加', () => {
    const result = suggestApproach({
      idea: 'セキュリティが重要な外部入力を扱うシステム',
    })

    const names = result.approaches.map(a => a.name)
    expect(names).toContain('脅威駆動')
  })

  it('権限関連のキーワードでポリシー駆動を追加', () => {
    const result = suggestApproach({
      idea: 'アクセス制御と権限管理が必要なシステム',
    })

    const names = result.approaches.map(a => a.name)
    expect(names).toContain('ポリシー駆動')
  })

  it('比較関連のキーワードで比較駆動を追加', () => {
    const result = suggestApproach({
      idea: '既存の類似ツールとの差別化が大事',
    })

    const names = result.approaches.map(a => a.name)
    expect(names).toContain('比較駆動')
  })

  it('constraints もキーワードマッチに含める', () => {
    const result = suggestApproach({
      idea: 'ツールを作りたい',
      constraints: ['セキュリティが最重要'],
    })

    const names = result.approaches.map(a => a.name)
    expect(names).toContain('脅威駆動')
  })

  it('recommendation が文字列で返る', () => {
    const result = suggestApproach({
      idea: 'データ管理ツール',
    })

    expect(typeof result.recommendation).toBe('string')
    expect(result.recommendation.length).toBeGreaterThan(0)
  })

  it('拡張テンプレートの source は extended', () => {
    const result = suggestApproach({
      idea: 'セキュリティと権限管理が重要',
    })

    const extended = result.approaches.filter(a => a.source === 'extended')
    expect(extended.length).toBeGreaterThan(0)
    for (const a of extended) {
      expect(a.source).toBe('extended')
    }
  })

  it('各 approach に suggested_documents がある', () => {
    const result = suggestApproach({ idea: 'ツール' })
    for (const a of result.approaches) {
      expect(a.suggested_documents.length).toBeGreaterThan(0)
    }
  })
})
