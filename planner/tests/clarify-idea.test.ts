import { describe, it, expect } from 'vitest'
import { clarifyIdea } from '../src/tools/clarify-idea.js'

describe('clarifyIdea', () => {
  it('曖昧なアイデアから core_desire を抽出する', () => {
    const result = clarifyIdea({
      raw_idea: 'AIと話してると毎回同じ説明するのがダルい。覚えててほしい',
    })

    expect(result.understood.core_desire).toBeTruthy()
    expect(result.understood.pain_point).toBeTruthy()
    expect(result.understood.pain_point).toContain('ダルい')
  })

  it('4軸の充足度を判定する', () => {
    const result = clarifyIdea({
      raw_idea: '自分だけが使う個人用ツールを作りたい。TypeScriptで書く',
    })

    const targetUser = result.axes.find(a => a.axis === 'target_user')
    expect(targetUser?.filled).toBe(true)

    const scope = result.axes.find(a => a.axis === 'scope')
    expect(scope?.filled).toBe(true)

    const constraints = result.axes.find(a => a.axis === 'constraints')
    expect(constraints?.filled).toBe(true)

    expect(result.fulfillment).toBeGreaterThanOrEqual(3)
  })

  it('充足度 0〜1 では diverge モード', () => {
    const result = clarifyIdea({
      raw_idea: 'なんか面白いもの作りたい',
    })

    expect(result.fulfillment).toBeLessThanOrEqual(1)
    expect(result.mode).toBe('diverge')
  })

  it('充足度 2〜3 では converge モード', () => {
    const result = clarifyIdea({
      raw_idea: '自分用のAI記憶ツールを作りたい。毎回同じ説明するのが面倒',
    })

    // target_user(自分), value(面倒) で 2軸以上
    expect(result.mode).toBe('converge')
  })

  it('全4軸充足で transition モード', () => {
    const result = clarifyIdea({
      raw_idea: '自分だけが使う個人用のAI記憶管理ツールを作りたい。毎回コンテキストを説明し直すのが不満。TypeScriptとSQLiteで作る',
    })

    expect(result.fulfillment).toBe(4)
    expect(result.mode).toBe('transition')
  })

  it('未充足軸に対するテンプレート質問を返す', () => {
    const result = clarifyIdea({
      raw_idea: 'なんか便利なツール作りたい',
    })

    // value 軸は「便利」で充足するが、他が未充足
    expect(result.questions.length).toBeGreaterThan(0)
    // 未充足軸の質問のみ
    const filledAxes = new Set(result.axes.filter(a => a.filled).map(a => a.axis))
    for (const q of result.questions) {
      expect(filledAxes.has(q.axis)).toBe(false)
    }
  })

  it('existing_context も充足判定に含める', () => {
    const result = clarifyIdea({
      raw_idea: 'ツールを作りたい',
      existing_context: '自分だけが使う。TypeScriptで実装する予定',
    })

    const targetUser = result.axes.find(a => a.axis === 'target_user')
    expect(targetUser?.filled).toBe(true)

    const constraints = result.axes.find(a => a.axis === 'constraints')
    expect(constraints?.filled).toBe(true)
  })

  it('記憶関連のキーワードで類似アプローチを返す', () => {
    const result = clarifyIdea({
      raw_idea: 'AIの記憶を管理するツールを作りたい',
    })

    expect(result.similar_approaches.length).toBeGreaterThan(0)
    const names = result.similar_approaches.map(a => a.name)
    expect(names.some(n => /mem0|memory|Letta/i.test(n))).toBe(true)
  })

  it('質問は最大4問まで', () => {
    const result = clarifyIdea({
      raw_idea: 'あ',
    })

    expect(result.questions.length).toBeLessThanOrEqual(4)
  })

  // --- コンシェルジュ（規模判定）---

  it('ワンショットのシグナルで route: "one-shot" を返す', () => {
    const result = clarifyIdea({
      raw_idea: 'CSVを日付でソートするスクリプトをさっと書いて',
    })

    expect(result.route).toBe('one-shot')
    expect(result.one_shot_suggestion).toBeTruthy()
  })

  it('プロジェクト規模の要求で route: "full" を返す', () => {
    const result = clarifyIdea({
      raw_idea: 'AIの人格設定を管理・配布するシステムを作りたい。チームで運用する予定',
    })

    expect(result.route).toBe('full')
    expect(result.one_shot_suggestion).toBeUndefined()
  })

  it('シグナルが混在する場合は route: "full" を返す', () => {
    const result = clarifyIdea({
      raw_idea: 'とりあえずプロジェクト管理システムのプロトタイプを作りたい',
    })

    // 「とりあえず」はワンショットだが「システム」「プロジェクト」はフル
    expect(result.route).toBe('full')
  })

  it('シグナルがない場合は route: "full" を返す', () => {
    const result = clarifyIdea({
      raw_idea: 'AIと話してると毎回同じ説明するのがダルい。覚えててほしい',
    })

    expect(result.route).toBe('full')
  })

  it('existing_context のワンショットシグナルも判定に含める', () => {
    const result = clarifyIdea({
      raw_idea: 'ファイル変換するやつほしい',
      existing_context: 'さっと動けばいい',
    })

    expect(result.route).toBe('one-shot')
  })
})
