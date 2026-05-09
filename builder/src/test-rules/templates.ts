export interface RuleTemplate {
  id: string
  framework: string
  scope: 'global' | 'project'
  error_pattern: string
  description: string
  rule_template: string
  example_before?: string
  example_after?: string
}

export interface StoredRule {
  id: string
  template_id: string
  framework: string
  rule: string
  example_before?: string
  example_after?: string
  created_at: string
}

export const BUILTIN_TEMPLATES: RuleTemplate[] = [
  {
    id: 'mock-cjs-default',
    framework: 'vitest',
    scope: 'global',
    error_pattern: 'No "default" export is defined on the .* mock',
    description: 'CJS モジュールを default import するとき vi.mock は { default: {...} } でラップする必要がある',
    rule_template: '{{package}} を default import する場合、vi.mock ファクトリは `{ default: { ... } }` でラップする',
    example_before: "vi.mock('{{package}}', () => ({ fn: vi.fn() }))",
    example_after: "vi.mock('{{package}}', () => ({ default: { fn: vi.fn() } }))",
  },
  {
    id: 'mock-hoisting',
    framework: 'vitest',
    scope: 'global',
    error_pattern: 'vi\\.mock.*hoisting|hoisting.*vi\\.mock|Cannot access .* before initialization',
    description: 'vi.mock ファクトリ外の変数を参照するときは vi.hoisted() でラップする必要がある',
    rule_template: 'vi.mock ファクトリ内で外部変数を参照する場合は vi.hoisted() を使って変数を定義する',
    example_before: 'const mockFn = vi.fn()\nvi.mock("pkg", () => ({ fn: mockFn }))',
    example_after: 'const mockFn = vi.hoisted(() => vi.fn())\nvi.mock("pkg", () => ({ fn: mockFn }))',
  },
]
