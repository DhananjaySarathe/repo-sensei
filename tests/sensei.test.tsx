import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/work/cal'
const PACK = JSON.stringify([
  { id: 'zod-schemas', name: 'Zod schemas', level: 'core', why: 'Every API input is validated with Zod.', files: ['src/schemas'], signals: ["from 'zod'", 'z.object('], explainer: 'Zod...' },
  { id: 'trpc-routers', name: 'tRPC routers', level: 'core', why: 'All endpoints are tRPC procedures.', files: ['src/server/routers'], signals: ['publicProcedure'], explainer: 'tRPC...' },
])

function world(on: On, opts: { hasPack: boolean; now?: number }) {
  const clock = mock.clock(on, { now: opts.now ?? Date.UTC(2026, 10, 7, 9) })
  const files = new Map<string, string>()
  if (opts.hasPack) files.set(`${ROOT}/.repo-sensei/concepts.json`, PACK)
  files.set(`${ROOT}/src/api/user.ts`, "import { z } from 'zod'\nexport const User = z.object({})")
  const store = new Map<string, unknown>()
  const submitted: string[] = []
  const toasts: string[] = []

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: ROOT }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => { toasts.push(String((e as { text: string }).text)); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    if (a === 'git rev-parse --show-toplevel') return { value: { exitCode: 0, stdout: ROOT + '\n', stderr: '' } }
    if (a === 'git remote get-url origin') return { value: { exitCode: 0, stdout: 'https://github.com/calcom/cal.com.git\n', stderr: '' } }
    if (a === 'git ls-files') return { value: { exitCode: 0, stdout: 'a.ts\nb.ts\nREADME.md\n', stderr: '' } }
    if (a.startsWith('git rev-list --count')) return { value: { exitCode: 0, stdout: '3\n', stderr: '' } }
    if (a.startsWith('git log --since') && a.includes('--name-only')) return { value: { exitCode: 0, stdout: 'src/api/user.ts\nsrc/server/routers/user.ts\n', stderr: '' } }
    if (a.startsWith('git log --since') && a.includes('%h')) return { value: { exitCode: 0, stdout: 'a1b2c3 | Asha | 3 hours ago | feat: add user schema\n', stderr: '' } }
    if (a === 'git status --porcelain') return { value: { exitCode: 0, stdout: ' M src/api/user.ts\n', stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || e.path === `${ROOT}/.git` || e.path === `${ROOT}/package.json` }))
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text } as never })
  on('tool.call', () => ({ result: {} }))
  return { files, store, submitted, toasts, clock }
}

const BAND = { plugin: 'repo-sensei', component: 'AbovePrompt', props: { hasSurvey: false } } as const

test('a new repo gets the onboarding offer, and /learn-repo queues the analysis', async ($, on) => {
  const w = world(on, { hasPack: false })
  const clock = w.clock
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  expect(w.toasts.some(t => t.includes('New codebase'))).toBe(true)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  expect((await ui.find({ type: 'Text', text: /New codebase/ }))).toBeDefined()
  await ui.unmount()

  const { text } = await $.command.run({ command: 'learn-repo', args: '' })
  expect(text).toContain('calcom/cal.com')
  await clock.advance(100)
  expect(w.submitted[0]).toContain('.repo-sensei/concepts.json')
})

test('an edit using an unlearned concept raises a nudge; "I know this" learns it', async ($, on) => {
  const w = world(on, { hasPack: true })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/api/user.ts`, old_string: 'a', new_string: 'b' } as never)
  expect(w.toasts.some(t => t.includes('Zod schemas'))).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    const found = await ui.find({ type: 'Text', text: /Zod schemas/ })
    if (surface === 'desktop') {
      expect(found).toBeDefined()
      await ui.press({ key: 'know' })
    }
    await ui.unmount()
  }
  expect(w.store.get(`learned:${ROOT}`)).toEqual(['zod-schemas'])

  const { text } = await $.command.run({ command: 'sensei-export', args: '' })
  expect(text).toContain('1/2 learned')
  expect(w.files.get(`${ROOT}/.repo-sensei/flashcards.csv`)).toContain('Zod schemas')
})

test('the panel shows progress on every surface', async ($, on) => {
  const w = world(on, { hasPack: true })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'learned', args: 'trpc' })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'repo-sensei', component: 'Pane', requestId: 'repo-sensei', surface,
      props: { title: 'Repo Sensei', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    } as never)
    expect(await ui.find({ type: 'Text', text: /1\/2 concepts learned/ })).toBeDefined()
    if (surface === 'desktop') {
      await ui.press({ key: 'explain-zod-schemas' })
      expect(w.submitted.at(-1)).toContain('Zod schemas')
    }
    await ui.unmount()
  }
})

test('daily catch-up: offered once a day when something changed, then summary + quiz is queued', async ($, on) => {
  const w = world(on, { hasPack: true })
  const clock = w.clock
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  expect(w.toasts.some(t => t.includes('3 commits'))).toBe(true)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  expect(await ui.find({ type: 'Text', text: /Daily catch-up/ })).toBeDefined()
  await ui.press({ key: 'catchup' })
  await ui.unmount()
  await clock.advance(100)

  const prompt = w.submitted.at(-1) ?? ''
  expect(prompt).toContain('daily catch-up')
  expect(prompt).toContain('feat: add user schema')
  expect(prompt).toContain('.repo-sensei/catchup/2026-11-07.md')
  expect(prompt).toContain('Zod schemas [NOT learned]')
  expect(w.store.get(`catchup:${ROOT}`)).toBe(Date.UTC(2026, 10, 7, 9))

  // Same day, new session: no second offer.
  const before = w.toasts.length
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  expect(w.toasts.slice(before).some(t => t.includes('commits'))).toBe(false)
})
