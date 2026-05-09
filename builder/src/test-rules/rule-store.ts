import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { StoredRule } from './templates.js'

function globalRulesPath(framework: string): string {
  return join(homedir(), '.cdd', 'test-rules', `${framework}.jsonl`)
}

function projectRulesPath(projectDir: string, framework: string): string {
  return join(projectDir, 'docs', '4-ref', 'test-rules', `${framework}.jsonl`)
}

async function readRules(path: string): Promise<StoredRule[]> {
  if (!existsSync(path)) return []
  try {
    const raw = await readFile(path, 'utf-8')
    return raw.trim().split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as StoredRule)
  } catch {
    return []
  }
}

export async function loadRules(framework: string, projectDir: string): Promise<StoredRule[]> {
  const [globalRules, projectRules] = await Promise.all([
    readRules(globalRulesPath(framework)),
    readRules(projectRulesPath(projectDir, framework)),
  ])

  const seen = new Set<string>()
  const merged: StoredRule[] = []
  for (const rule of [...globalRules, ...projectRules]) {
    if (!seen.has(rule.id)) {
      seen.add(rule.id)
      merged.push(rule)
    }
  }
  return merged
}

export async function appendRule(
  rule: StoredRule,
  scope: 'global' | 'project',
  projectDir: string,
): Promise<void> {
  const path = scope === 'global'
    ? globalRulesPath(rule.framework)
    : projectRulesPath(projectDir, rule.framework)

  const existing = await readRules(path)
  const alreadyExists = existing.some(r => r.template_id === rule.template_id)
  if (alreadyExists) return

  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(rule) + '\n', 'utf-8')
}
