import type {
  ClarifyIdeaInput,
  ClarifyIdeaResult,
  ClarifyRoute,
  AxisKey,
  AxisStatus,
  TemplateQuestion,
  SimilarApproach,
} from '../types.js'

// --- 4軸テンプレート質問 ---

interface AxisDef {
  key: AxisKey
  label: string
  keywords: RegExp[]
  questions: TemplateQuestion[]
}

const AXES: AxisDef[] = [
  {
    key: 'target_user',
    label: '対象ユーザー',
    keywords: [/自分/, /チーム/, /誰/, /ユーザー/, /使う人/, /個人/, /組織/],
    questions: [
      {
        question: '誰が使いますか？ 自分だけ？ チームで共有？',
        why: 'ユーザー規模でアーキテクチャが変わる',
        axis: 'target_user',
      },
      {
        question: '技術者向け？ 非技術者も使う？',
        why: 'UI/UX の複雑さの基準が変わる',
        axis: 'target_user',
      },
    ],
  },
  {
    key: 'value',
    label: '価値',
    keywords: [/嬉しい/, /不満/, /面倒/, /ダルい/, /困/, /解決/, /楽/, /便利/, /効率/],
    questions: [
      {
        question: '今の何が一番不満ですか？',
        why: '核心の課題を特定するため',
        axis: 'value',
      },
      {
        question: 'これができたら何が嬉しいですか？',
        why: '価値の優先順位を決めるため',
        axis: 'value',
      },
    ],
  },
  {
    key: 'scope',
    label: 'スコープ',
    keywords: [/個人用/, /配布/, /公開/, /OSS/, /プロダクト/, /MVP/, /最小/, /まず/],
    questions: [
      {
        question: '個人用ツール？ それとも配布・公開する？',
        why: 'スコープで必要な品質レベルが変わる',
        axis: 'scope',
      },
      {
        question: 'まず最小限でいいなら、どこまでが「最小」？',
        why: 'MVP の境界線を決めるため',
        axis: 'scope',
      },
    ],
  },
  {
    key: 'constraints',
    label: '制約',
    keywords: [/技術/, /言語/, /TypeScript/, /Python/, /Obsidian/, /SQLite/, /既存/, /前提/, /縛り/],
    questions: [
      {
        question: '技術的な前提や縛りはありますか？（言語、フレームワーク、既存システムとの連携など）',
        why: '技術選定の自由度を把握するため',
        axis: 'constraints',
      },
      {
        question: '既に決まっていること・変えられないことはありますか？',
        why: '制約を早期に特定して手戻りを防ぐため',
        axis: 'constraints',
      },
    ],
  },
]

// --- 類似アプローチDB ---

interface ApproachEntry {
  name: string
  keywords: RegExp[]
  relevance: string
}

const SIMILAR_APPROACHES: ApproachEntry[] = [
  { name: 'mem0', keywords: [/記憶/, /覚え/, /メモリ/, /memory/i], relevance: 'LLM の記憶レイヤー。ホスト型サービス' },
  { name: 'Claude の auto-memory', keywords: [/記憶/, /覚え/, /Claude/], relevance: '最も近いが、カスタマイズ性が低い' },
  { name: 'Obsidian + Dataview', keywords: [/Obsidian/, /ノート/, /文書管理/], relevance: 'Markdown ベースの知識管理' },
  { name: 'LangChain Memory', keywords: [/会話/, /チャット/, /コンテキスト/], relevance: 'チャット履歴の永続化フレームワーク' },
  { name: 'llama-index', keywords: [/検索/, /インデックス/, /RAG/i], relevance: 'ドキュメント検索・RAG パイプライン' },
  { name: 'Letta (MemGPT)', keywords: [/エージェント/, /人格/, /長期記憶/], relevance: 'エージェントの長期記憶管理' },
  { name: 'OpenAI Assistants API', keywords: [/アシスタント/, /ツール/, /API/], relevance: 'ツール呼び出し + ファイル検索の統合' },
  { name: 'Notion API', keywords: [/タスク/, /プロジェクト管理/, /データベース/], relevance: '構造化データ + API によるプロジェクト管理' },
]

// --- 抽出ロジック ---

function extractFromInput(text: string): { core_desire: string | null; pain_point: string | null; implied_scope: string | null } {
  const sentences = text.split(/[。\n]+/).filter(s => s.trim())

  let core_desire: string | null = null
  let pain_point: string | null = null
  let implied_scope: string | null = null

  for (const s of sentences) {
    if (/したい|ほしい|欲しい|作りたい|できたら|want/i.test(s) && !core_desire) {
      core_desire = s.trim()
    }
    if (/不満|面倒|ダルい|困|つらい|問題|毎回|繰り返し/i.test(s) && !pain_point) {
      pain_point = s.trim()
    }
    if (/個人|チーム|配布|公開|ローカル|サーバー/i.test(s) && !implied_scope) {
      implied_scope = s.trim()
    }
  }

  // core_desire がなければ全文を要約的に使う
  if (!core_desire && sentences.length > 0) {
    core_desire = sentences[0].trim()
  }

  return { core_desire, pain_point, implied_scope }
}

function checkAxisFulfillment(text: string, context: string | null): AxisStatus[] {
  const combined = text + (context ? '\n' + context : '')

  return AXES.map(axis => {
    const matched = axis.keywords.some(kw => kw.test(combined))
    const extracted = matched
      ? combined.split(/[。\n]+/).find(s => axis.keywords.some(kw => kw.test(s)))?.trim()
      : undefined
    return {
      axis: axis.key,
      label: axis.label,
      filled: matched,
      ...(extracted ? { extracted } : {}),
    }
  })
}

function selectQuestions(axes: AxisStatus[]): TemplateQuestion[] {
  const questions: TemplateQuestion[] = []
  for (const axisStatus of axes) {
    if (!axisStatus.filled) {
      const axisDef = AXES.find(a => a.key === axisStatus.axis)
      if (axisDef && axisDef.questions.length > 0) {
        questions.push(axisDef.questions[0])
      }
    }
  }
  // 最大4問
  return questions.slice(0, 4)
}

function findSimilarApproaches(text: string): SimilarApproach[] {
  const matches: SimilarApproach[] = []
  for (const entry of SIMILAR_APPROACHES) {
    if (entry.keywords.some(kw => kw.test(text))) {
      matches.push({ name: entry.name, relevance: entry.relevance })
    }
  }
  return matches.slice(0, 3)
}

function determineMode(fulfillment: number): 'diverge' | 'converge' | 'transition' {
  if (fulfillment <= 1) return 'diverge'
  if (fulfillment <= 3) return 'converge'
  return 'transition'
}

// --- コンシェルジュ: 規模判定 ---

const ONE_SHOT_SIGNALS: RegExp[] = [
  /とりあえず/, /急ぎ/, /やっつけ/, /試し[にで]/, /さっと/, /ちゃっちゃ/,
  /スクリプト/, /関数/, /ワンライナー/, /変換/, /するやつ/, /1本/,
  /簡単[なに]/, /すぐ/, /パッと/, /ちょっと/,
]

const FULL_CDD_SIGNALS: RegExp[] = [
  /システム/, /アプリ/, /ツール群/, /設計/, /アーキテクチャ/,
  /チームで/, /配布/, /メンテ/, /運用/, /拡張/,
  /プロジェクト/, /長期/, /本格/, /プロダクト/,
]

function determineRoute(text: string): ClarifyRoute {
  const oneShotScore = ONE_SHOT_SIGNALS.filter(kw => kw.test(text)).length
  const fullScore = FULL_CDD_SIGNALS.filter(kw => kw.test(text)).length

  // ワンショットのシグナルが強く、フルのシグナルがない場合
  if (oneShotScore >= 1 && fullScore === 0) return 'one-shot'

  return 'full'
}

// --- エクスポート ---

export function clarifyIdea(input: ClarifyIdeaInput): ClarifyIdeaResult {
  const { raw_idea, existing_context } = input
  const combined = raw_idea + (existing_context ? '\n' + existing_context : '')
  const understood = extractFromInput(raw_idea)
  const route = determineRoute(combined)
  const axes = checkAxisFulfillment(raw_idea, existing_context ?? null)
  const fulfillment = axes.filter(a => a.filled).length
  const mode = determineMode(fulfillment)
  const questions = selectQuestions(axes)
  const similar_approaches = findSimilarApproaches(combined)

  const result: ClarifyIdeaResult = {
    route,
    understood,
    axes,
    fulfillment,
    mode,
    questions,
    similar_approaches,
  }

  if (route === 'one-shot') {
    result.one_shot_suggestion = '壁打ち不要で、そのまま実装に進めそうです。CDD で丁寧に設計しますか？'
  }

  return result
}
