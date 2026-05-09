import { randomUUID } from 'node:crypto'
import { BUILTIN_TEMPLATES } from './templates.js'
import type { RuleTemplate, StoredRule } from './templates.js'

export function matchErrorToTemplate(errorOutput: string, framework: string): RuleTemplate | null {
  const candidates = BUILTIN_TEMPLATES.filter(t => t.framework === framework)
  for (const template of candidates) {
    if (new RegExp(template.error_pattern).test(errorOutput)) {
      return template
    }
  }
  return null
}

export function instantiateRule(template: RuleTemplate, errorContext: string): StoredRule {
  // errorContext からパッケージ名を抽出して {{package}} を置換する
  // 例: No "default" export is defined on the "web-push" mock.
  const packageMatch = errorContext.match(/"([^"]+)" mock/)
  const packageName = packageMatch ? packageMatch[1] : '{{package}}'

  const rule = template.rule_template.replaceAll('{{package}}', packageName)
  const exampleBefore = template.example_before?.replaceAll('{{package}}', packageName)
  const exampleAfter = template.example_after?.replaceAll('{{package}}', packageName)

  return {
    id: randomUUID(),
    template_id: template.id,
    framework: template.framework,
    rule,
    example_before: exampleBefore,
    example_after: exampleAfter,
    created_at: new Date().toISOString(),
  }
}
