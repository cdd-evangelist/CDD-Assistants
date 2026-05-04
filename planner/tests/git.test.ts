import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getCommitHint } from '../src/utils/git.js'

const exec = promisify(execFile)

describe('getCommitHint', () => {
  let tmpDir: string

  async function git(...args: string[]) {
    return exec('git', args, { cwd: tmpDir })
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'git-hint-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('git リポジトリでなければ null を返す', async () => {
    const hint = await getCommitHint(tmpDir, {
      reason: 'decision_recorded',
      suggested_message: 'test',
    })
    expect(hint).toBeNull()
  })

  it('未コミットの変更がなければ null を返す', async () => {
    await git('init')
    await git('config', 'user.email', 'test@test.com')
    await git('config', 'user.name', 'Test')
    await writeFile(join(tmpDir, 'a.md'), 'a')
    await git('add', '.')
    await git('commit', '-m', 'init')

    const hint = await getCommitHint(tmpDir, {
      reason: 'decision_recorded',
      suggested_message: 'test',
    })
    expect(hint).toBeNull()
  })

  it('未コミット変更があれば commit_hint を返す', async () => {
    await git('init')
    await git('config', 'user.email', 'test@test.com')
    await git('config', 'user.name', 'Test')
    await writeFile(join(tmpDir, 'a.md'), 'a')
    await git('add', '.')
    await git('commit', '-m', 'init')

    // 変更を加える
    await writeFile(join(tmpDir, 'a.md'), 'a updated')
    await writeFile(join(tmpDir, 'b.md'), 'new file')

    const hint = await getCommitHint(tmpDir, {
      reason: 'decision_recorded',
      suggested_message: 'docs: D-001 example',
    })
    expect(hint).not.toBeNull()
    expect(hint!.uncommitted_files).toBe(2)
    expect(hint!.changed_paths).toContain('a.md')
    expect(hint!.changed_paths).toContain('b.md')
    expect(hint!.suggested_message).toBe('docs: D-001 example')
    expect(hint!.reason).toBe('decision_recorded')
  })

  it('changed_paths は maxPaths で打ち切られる', async () => {
    await git('init')
    await git('config', 'user.email', 'test@test.com')
    await git('config', 'user.name', 'Test')
    await writeFile(join(tmpDir, 'init.md'), 'init')
    await git('add', '.')
    await git('commit', '-m', 'init')

    // 5 ファイル追加
    for (let i = 0; i < 5; i++) {
      await writeFile(join(tmpDir, `f${i}.md`), `file ${i}`)
    }

    const hint = await getCommitHint(
      tmpDir,
      { reason: 'chunk_completed', suggested_message: 'test' },
      { maxPaths: 3 },
    )
    expect(hint).not.toBeNull()
    // 全 5 件のカウントは保持
    expect(hint!.uncommitted_files).toBe(5)
    // パス一覧は 3 件で切る
    expect(hint!.changed_paths).toHaveLength(3)
  })

  it('リネームでは新しいパスを返す', async () => {
    await git('init')
    await git('config', 'user.email', 'test@test.com')
    await git('config', 'user.name', 'Test')
    await writeFile(join(tmpDir, 'old.md'), 'content')
    await git('add', '.')
    await git('commit', '-m', 'init')

    // git mv でリネーム + ステージング
    await git('mv', 'old.md', 'new.md')

    const hint = await getCommitHint(tmpDir, {
      reason: 'chunk_completed',
      suggested_message: 'rename',
    })
    expect(hint).not.toBeNull()
    expect(hint!.changed_paths).toContain('new.md')
    expect(hint!.changed_paths).not.toContain('old.md')
  })

  it('空白を含むファイル名（クォート付き）に対応する', async () => {
    await git('init')
    await git('config', 'user.email', 'test@test.com')
    await git('config', 'user.name', 'Test')
    await writeFile(join(tmpDir, 'init.md'), 'init')
    await git('add', '.')
    await git('commit', '-m', 'init')

    await writeFile(join(tmpDir, 'with space.md'), 'has space')

    const hint = await getCommitHint(tmpDir, {
      reason: 'chunk_completed',
      suggested_message: 'spaces',
    })
    expect(hint).not.toBeNull()
    expect(hint!.changed_paths).toContain('with space.md')
  })
})
