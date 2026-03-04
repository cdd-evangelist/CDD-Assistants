import type {
  SuggestApproachInput,
  SuggestApproachResult,
  Approach,
} from '../types.js'

// --- コアテンプレート（常時返却） ---

const CORE_APPROACHES: Approach[] = [
  {
    name: 'ユースケース駆動',
    description: '誰が何をするかから攻める。機能の抜け漏れが出にくい',
    source: 'core',
    suggested_documents: ['ユーザー側ユースケース一覧', 'AI側ユースケース一覧'],
    good_for: '要件が曖昧な初期段階',
  },
  {
    name: 'データモデル駆動',
    description: '何を保存するかから攻める。データ構造が核心なら最も効率的',
    source: 'core',
    suggested_documents: ['ER図 / テーブル定義', 'データフロー図'],
    good_for: 'データ構造が核心のシステム',
  },
  {
    name: 'インターフェース駆動',
    description: '外から見た振る舞いから攻める。API やCLI の仕様を先に決める',
    source: 'core',
    suggested_documents: ['API / CLI 仕様書', '操作フロー図'],
    good_for: '操作体験が重要なツール',
  },
]

// --- 拡張テンプレート（キーワードマッチで選択） ---

interface ExtendedEntry {
  approach: Approach
  keywords: RegExp[]
}

const EXTENDED_APPROACHES: ExtendedEntry[] = [
  {
    approach: {
      name: 'ポリシー駆動',
      description: '何を許し何を禁じるかから攻める。権限モデルを最初に設計する',
      source: 'extended',
      suggested_documents: ['ポリシー定義書', 'アクセス制御仕様'],
      good_for: '権限・制約が多いシステム',
    },
    keywords: [/ポリシー/, /権限/, /セキュリティ/, /制限/, /許可/, /禁止/, /アクセス制御/, /認証/, /認可/],
  },
  {
    approach: {
      name: '脅威駆動',
      description: 'セキュリティの観点から攻める。攻撃面の分析を先行させる',
      source: 'extended',
      suggested_documents: ['脅威モデル', 'セキュリティ設計書'],
      good_for: '外部入力を扱うシステム',
    },
    keywords: [/脅威/, /攻撃/, /セキュリティ/, /脆弱/, /サンドボックス/, /外部入力/, /バリデーション/],
  },
  {
    approach: {
      name: '比較駆動',
      description: '既存プロダクトとの差分から攻める。「何が違うか」で独自性を明確にする',
      source: 'extended',
      suggested_documents: ['既存ツール比較表', '差別化ポイント整理'],
      good_for: '類似サービスが存在する領域',
    },
    keywords: [/既存/, /比較/, /差別化/, /競合/, /類似/, /代替/, /との違い/],
  },
  {
    approach: {
      name: 'イベント駆動',
      description: '何が起きたら何をするかから攻める。リアクティブなシステムに向く',
      source: 'extended',
      suggested_documents: ['イベントカタログ', '状態遷移図'],
      good_for: 'リアクティブ・非同期処理が多いシステム',
    },
    keywords: [/イベント/, /トリガー/, /リアクティブ/, /非同期/, /Webhook/, /通知/, /サブスクリ/],
  },
  {
    approach: {
      name: 'ワークフロー駆動',
      description: '業務の流れから攻める。人間の作業手順を起点に設計する',
      source: 'extended',
      suggested_documents: ['業務フロー図', 'ステップ定義書'],
      good_for: '人間の作業フローを自動化するシステム',
    },
    keywords: [/ワークフロー/, /業務/, /手順/, /フロー/, /パイプライン/, /自動化/, /ステップ/],
  },
]

// --- レコメンデーション生成 ---

function generateRecommendation(
  matchedExtended: Approach[],
  idea: string,
  constraints: string[],
): string {
  // 制約に Obsidian が含まれていたらドキュメント系を推奨
  const hasObsidian = constraints.some(c => /Obsidian/i.test(c))

  if (matchedExtended.length === 0) {
    if (hasObsidian) {
      return 'ユースケース駆動 → データモデル → インターフェースの順がおすすめ。Obsidian で文書を管理するなら、ユースケース一覧から始めると全体像を把握しやすい'
    }
    return 'ユースケース駆動 → データモデル → インターフェースの順がおすすめ'
  }

  const extNames = matchedExtended.map(a => a.name).join('、')
  return `ユースケース駆動で全体像を掴んだ後、${extNames}で深掘りするのが効果的`
}

// --- エクスポート ---

export function suggestApproach(input: SuggestApproachInput): SuggestApproachResult {
  const { idea, context, constraints = [] } = input
  const combined = [idea, context ?? '', ...constraints].join(' ')

  // コアは常時返却
  const approaches: Approach[] = [...CORE_APPROACHES]

  // 拡張テンプレートをキーワードマッチで選択
  const matchedExtended: Approach[] = []
  for (const entry of EXTENDED_APPROACHES) {
    if (entry.keywords.some(kw => kw.test(combined))) {
      approaches.push(entry.approach)
      matchedExtended.push(entry.approach)
    }
  }

  const recommendation = generateRecommendation(matchedExtended, idea, constraints)

  return { approaches, recommendation }
}
