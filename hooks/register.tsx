import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Catchup, Concept, Nudge, RepoInfo } from '../types'

// ── State ────────────────────────────────────────────────────────────────
const concepts = atom({ plugin: 'repo-sensei', key: 'concepts' } as const, [], {
  shape: 'concepts-1',
})
const learned = atom({ plugin: 'repo-sensei', key: 'learned' } as const, [], {
  shape: 'learned-1',
})
const nudge = atom({ plugin: 'repo-sensei', key: 'nudge' } as const, null)
const repo = atom({ plugin: 'repo-sensei', key: 'repo' } as const, null)
const offer = atom({ plugin: 'repo-sensei', key: 'offer' } as const, false)
const catchup = atom({ plugin: 'repo-sensei', key: 'catchup' } as const, null, {
  shape: 'catchup-1',
})

const PANE = 'repo-sensei'
const DIR = '.repo-sensei'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MANIFESTS = [
  'package.json', 'pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'tsconfig.json',
  'requirements.txt', 'pyproject.toml', 'setup.py', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json',
  'Dockerfile', 'docker-compose.yml', 'Makefile', 'CONTRIBUTING.md', 'README.md',
  'ARCHITECTURE.md', '.github/workflows',
]

type $T = EngineInterface
const nudgedThisSession = new Set<string>()

// ── Helpers ──────────────────────────────────────────────────────────────
const learnedKey = (root: string) => `learned:${root}`
const catchupKey = (root: string) => `catchup:${root}`
const offeredKey = (root: string) => `catchup-offered:${root}`
const touchedKey = (root: string) => `touched:${root}`
const DAY = 24 * 60 * 60 * 1000
type Touch = { path: string; at: number }

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
function ago(ms: number, now: number) {
  const h = Math.round((now - ms) / 3600000)
  if (h < 1) return 'less than an hour ago'
  if (h < 36) return `${h}h ago`
  return `${Math.round(h / 24)} days ago`
}

async function git($: $T, args: string[], root?: string): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', ...args], { cwd: root, timeoutMs: 20000 })
    return r.exitCode === 0 ? r.stdout : undefined
  } catch {
    return undefined
  }
}

async function findRepo($: $T): Promise<RepoInfo> {
  const cwd = await $.session.cwd()
  const top = (await git($, ['rev-parse', '--show-toplevel'], cwd))?.trim()
  const root = top || cwd
  const remote = (await git($, ['remote', 'get-url', 'origin'], root))?.trim() ?? ''
  const fromRemote = remote.replace(/\.git$/, '').split(/[/:]/).slice(-2).join('/')
  const name = fromRemote.includes('/') ? fromRemote : root.split('/').pop() || 'this repo'
  const hasPack = await $.fs.exists(`${root}/${DIR}/concepts.json`)
  return { root, name, hasPack }
}

function isConcept(x: unknown): x is Concept {
  const c = x as Concept
  return !!c && typeof c.id === 'string' && typeof c.name === 'string'
}

async function loadPack($: $T, root: string): Promise<number> {
  try {
    const raw = JSON.parse(await $.fs.read(`${root}/${DIR}/concepts.json`)) as unknown
    const list = (Array.isArray(raw) ? raw : (raw as { concepts?: unknown[] })?.concepts ?? [])
      .filter(isConcept)
      .map(c => ({
        id: c.id,
        name: c.name,
        level: (['basic', 'core', 'advanced'].includes(c.level) ? c.level : 'core') as Concept['level'],
        why: String(c.why ?? ''),
        files: Array.isArray(c.files) ? c.files.map(String) : [],
        signals: Array.isArray(c.signals) ? c.signals.map(String).filter(s => s.length >= 3) : [],
        explainer: String(c.explainer ?? ''),
      }))
    await update($, concepts, () => list)
    return list.length
  } catch {
    return 0
  }
}

async function loadLearned($: $T, root: string) {
  const saved = (await $.store.get(learnedKey(root))) as string[] | undefined
  await update($, learned, () => (Array.isArray(saved) ? saved : []))
}

async function setLearned($: $T, id: string, isLearned: boolean) {
  const info = await read($, repo)
  const next = await update($, learned, list => {
    const rest = list.filter(x => x !== id)
    return isLearned ? [...rest, id] : rest
  })
  if (info) await $.store.set(learnedKey(info.root), next)
  await refreshStatus($)
}

async function refreshStatus($: $T) {
  const list = await read($, concepts)
  if (list.length === 0) return $.ui.status(undefined)
  const done = (await read($, learned)).filter(id => list.some(c => c.id === id)).length
  $.ui.status(`🧭 ${done}/${list.length} concepts learned`)
}

function bar(done: number, total: number, width = 16) {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function findConcept(list: Concept[], query: string): Concept | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return undefined
  return (
    list.find(c => c.id.toLowerCase() === q) ??
    list.find(c => c.name.toLowerCase() === q) ??
    list.find(c => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
  )
}

function explainPrompt(c: Concept, file?: string) {
  return [
    `Repo Sensei: teach me "${c.name}" as it is used in THIS repository, as a 2-minute read for a newcomer.`,
    file ? `I just saw it in ${file}.` : '',
    `Context from the onboarding pack: ${c.why} ${c.explainer}`,
    `Likely places: ${c.files.slice(0, 6).join(', ') || 'search the repo'}.`,
    'Format: 1) what it is, in one line; 2) where this repo uses it, citing 2-3 real files with short snippets;',
    '3) the mistakes contributors usually make with it here; 4) end with ONE quick self-check question.',
    `Stay under 300 words. When I answer the question correctly, tell me to run /learned ${c.id}.`,
  ]
    .filter(Boolean)
    .join('\n')
}

async function gatherFacts($: $T, root: string) {
  const present: string[] = []
  for (const m of MANIFESTS) if (await $.fs.exists(`${root}/${m}`)) present.push(m)

  const files = (await git($, ['ls-files'], root))?.split('\n').filter(Boolean) ?? []
  const exts = new Map<string, number>()
  for (const f of files) {
    const ext = f.includes('.') ? f.split('.').pop()!.toLowerCase() : '(none)'
    exts.set(ext, (exts.get(ext) ?? 0) + 1)
  }
  const topExts = [...exts].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([e, n]) => `.${e} ×${n}`).join(', ')

  const log = await git($, ['log', '--since=6 months ago', '--name-only', '--pretty=format:'], root)
  const churn = new Map<string, number>()
  for (const f of log?.split('\n').filter(Boolean) ?? []) churn.set(f, (churn.get(f) ?? 0) + 1)
  const hot = [...churn].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([f, n]) => `${f} (${n} commits)`)

  const authors = await git($, ['shortlog', '-sn', '--since=6 months ago', 'HEAD'], root)
  const contributors = authors?.split('\n').filter(Boolean).length ?? 0

  let issues: string[] = []
  try {
    const r = await $.process.run(
      ['gh', 'issue', 'list', '--label', 'good first issue', '--state', 'open', '--limit', '8',
        '--json', 'number,title,url'],
      { cwd: root, timeoutMs: 20000 },
    )
    if (r.exitCode === 0) {
      issues = (JSON.parse(r.stdout) as { number: number; title: string; url: string }[])
        .map(i => `#${i.number} ${i.title} — ${i.url}`)
    }
  } catch {
    /* gh missing or not a GitHub repo: Claude will try on its own */
  }

  return { present, fileCount: files.length, topExts, hot, contributors, issues }
}

function buildPrompt(info: RepoInfo, f: Awaited<ReturnType<typeof gatherFacts>>) {
  return `Repo Sensei: build my onboarding pack for ${info.name}. I'm new to this codebase and want to contribute.

Facts the mod already gathered (trust them, don't re-run):
- Tracked files: ${f.fileCount} (${f.topExts || 'n/a'})
- Manifests/docs present: ${f.present.join(', ') || 'none found'}
- Active contributors (6 months): ${f.contributors}
- Hottest files (6 months): ${f.hot.join('; ') || 'n/a'}
- Good first issues: ${f.issues.length ? f.issues.join(' | ') : 'none fetched (try `gh issue list --label "good first issue"` yourself if this is a GitHub repo)'}

Explore efficiently: read the manifests, README/CONTRIBUTING, and entry points first. For a large repo, run 2-3 Explore subagents in parallel (e.g. one for architecture/data flow, one for build/test/tooling). Don't read everything.

Then write exactly two files:

1) ${DIR}/ONBOARDING.md with these sections:
   ## Stack — table: tech | version | what it does HERE (cite the file that proves it)
   ## How it flows — the main path of a request/command/action from entry point to output, as a mermaid flowchart plus 5-8 numbered steps naming real files
   ## Learning path — the concepts below in the order to learn them, each with "read these files first"
   ## Your first PR — 3-5 good first issues (or, if none, 3 small realistic improvements you spotted), each with the files it touches and which concepts it needs
   ## How to run & test — exact commands from the repo
   ## Repo glossary — 8-12 project-specific terms

2) ${DIR}/concepts.json — a JSON array of 8-14 concepts, ordered as the learning path, each:
   {"id":"kebab-case","name":"Short name","level":"basic|core|advanced",
    "why":"one sentence: why you need this to contribute HERE",
    "files":["repo-relative paths or folder prefixes where it lives"],
    "signals":["3-6 literal code strings that appear wherever this concept is used, e.g. an import specifier like \\"from 'zod'\\" or a call like \\"useQuery(\\" — exact substrings, no regex"],
    "explainer":"60-120 words, beginner friendly, referencing this repo's files"}
   Signals power live nudges, so make them precise and specific to this codebase.

Finish with a 5-line summary and tell me to open the panel with /sensei.`
}

// ── Daily catch-up ───────────────────────────────────────────────────────
function parseSince(args: string, last: number | null, now: number): { since: number; label: string } {
  const a = args.trim().toLowerCase()
  const days = a.match(/(\d+)\s*d/)?.[1]
  if (days) return { since: now - Number(days) * DAY, label: `the last ${days} days` }
  if (a.startsWith('week')) return { since: now - 7 * DAY, label: 'the last 7 days' }
  if (a.startsWith('yesterday') || a.startsWith('today')) return { since: now - DAY, label: 'the last 24 hours' }
  if (last) return { since: last, label: `your last catch-up (${ago(last, now)})` }
  return { since: now - DAY, label: 'the last 24 hours' }
}

async function readTouched($: $T, root: string): Promise<Touch[]> {
  const list = (await $.store.get(touchedKey(root))) as Touch[] | undefined
  return Array.isArray(list) ? list : []
}

/** Cheap counts for the daily offer: no fetch, no model call. */
async function quickCounts($: $T, root: string, since: number) {
  const sec = Math.floor(since / 1000)
  const commits = Number((await git($, ['rev-list', '--count', `--since=@${sec}`, 'HEAD'], root))?.trim() ?? 0) || 0
  const names = (await git($, ['log', `--since=@${sec}`, '--name-only', '--pretty=format:'], root)) ?? ''
  const files = new Set(names.split('\n').filter(Boolean)).size
  const dirty = ((await git($, ['status', '--porcelain'], root)) ?? '').split('\n').filter(Boolean).length
  const touched = new Set((await readTouched($, root)).filter(t => t.at >= since).map(t => t.path)).size
  return { commits, files: files + dirty, touched }
}

async function catchupFacts($: $T, root: string, since: number) {
  const sec = Math.floor(since / 1000)
  // Best effort: see teammates' work too. Never fails the catch-up.
  const fetched = (await git($, ['fetch', '--quiet', '--no-tags'], root)) !== undefined
  const fmt = '--pretty=format:%h | %an | %ar | %s'
  const mine = (await git($, ['log', `--since=@${sec}`, fmt, '-n', '60'], root))?.split('\n').filter(Boolean) ?? []
  const incoming = fetched
    ? (await git($, ['log', 'HEAD..@{u}', fmt, '-n', '40'], root))?.split('\n').filter(Boolean) ?? []
    : []
  const names = (await git($, ['log', `--since=@${sec}`, '--name-only', '--pretty=format:'], root)) ?? ''
  const churn = new Map<string, number>()
  for (const f of names.split('\n').filter(Boolean)) churn.set(f, (churn.get(f) ?? 0) + 1)
  const hot = [...churn].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([f, n]) => `${f} (${n})`)
  const dirty = ((await git($, ['status', '--porcelain'], root)) ?? '').split('\n').filter(Boolean).slice(0, 40)
  const touched = [...new Set((await readTouched($, root)).filter(t => t.at >= since).map(t => t.path))].slice(0, 40)
  return { mine, incoming, hot, dirty, touched, fetched }
}

function buildCatchupPrompt(info: RepoInfo, label: string, date: string, f: Awaited<ReturnType<typeof catchupFacts>>, list: Concept[], done: Set<string>) {
  const concepts = list.length
    ? list.map(c => `${c.name} [${done.has(c.id) ? 'learned' : 'NOT learned'}] files: ${c.files.slice(0, 3).join(', ')}`).join('; ')
    : 'no onboarding pack yet'
  return `Repo Sensei daily catch-up for ${info.name}, covering ${label}. Help me catch up on everything that changed, so I understand it, not just see it.

Facts the mod gathered:
- Commits in this period (${f.mine.length}): ${f.mine.join(' || ') || 'none'}
- Incoming from the remote, not pulled yet (${f.incoming.length}): ${f.incoming.join(' || ') || (f.fetched ? 'none' : 'could not fetch')}
- Most-changed files: ${f.hot.join(', ') || 'none'}
- Uncommitted changes: ${f.dirty.join(', ') || 'none'}
- Files Claude edited in my sessions: ${f.touched.join(', ') || 'none'}
- My learning path: ${concepts}

Read the diffs that matter (git show / git diff on the important commits and files; skip lockfiles, snapshots and generated code). Then write ${DIR}/catchup/${date}.md with:
## TL;DR — 3 bullets
## What changed — grouped by feature/area: what changed, who, why it matters, commit refs
## Files to look at — table: file | what changed | why you should care (max 10, most important first)
## Concepts touched — which ones from my learning path these changes use; flag the ones I have NOT learned
## 5-minute lesson — teach the single most important change, with a short snippet from the real diff
## Quiz — 5 questions (mix of multiple choice and "what would happen if…"), each answer hidden in a <details> block
## Next step — one concrete thing to read or try

Then in this chat: show the TL;DR, and quiz me interactively — ask Q1, wait for my answer, grade it in one line, then the next — and give my score out of 5 at the end. If I miss a question about a concept from my learning path, tell me to use /sensei to study it.`
}

async function runCatchup($: $T, args: string): Promise<string> {
  const info = (await read($, repo)) ?? (await findRepo($))
  const now = await $.clock.now()
  const last = ((await $.store.get(catchupKey(info.root))) as number | undefined) ?? null
  const { since, label } = parseSince(args, last, now)
  const f = await catchupFacts($, info.root, since)
  const total = f.mine.length + f.incoming.length + f.dirty.length + f.touched.length
  await $.store.set(offeredKey(info.root), dayOf(now))
  await update($, catchup, c => (c ? { ...c, isOffered: false } : c))
  if (total === 0) return `☀️ Nothing changed in ${info.name} since ${label}. You're caught up.`
  await $.store.set(catchupKey(info.root), now)
  await update($, catchup, () => ({ commits: f.mine.length + f.incoming.length, files: f.hot.length + f.dirty.length, touched: f.touched.length, sinceLabel: label, lastAt: now, isOffered: false }))
  const prompt = buildCatchupPrompt(info, label, dayOf(now), f, await read($, concepts), new Set(await read($, learned)))
  // A command can't start a turn itself: queue it right after this command ends.
  $.clock.after(50, () => void $.prompt.submit({ text: prompt }))
  return `☀️ Catching you up on ${info.name} since ${label}: ${f.mine.length} commits, ${f.incoming.length} incoming, ${f.dirty.length} uncommitted, ${f.touched.length} files Claude edited. Writing ${DIR}/catchup/${dayOf(now)}.md and your quiz…`
}

async function runLearnRepo($: $T): Promise<string> {
  const info = (await read($, repo)) ?? (await findRepo($))
  await update($, offer, () => false)
  const facts = await gatherFacts($, info.root)
  // A command can't start a turn itself: queue it right after this command ends.
  const prompt = buildPrompt(info, facts)
  $.clock.after(50, () => void $.prompt.submit({ text: prompt }))
  return `🧭 Repo Sensei is mapping ${info.name}: ${facts.fileCount} files, ${facts.contributors} active contributors, ${facts.issues.length} good first issues found. Building your pack…`
}

async function openPane($: $T) {
  await $.ui.open({ id: PANE, title: 'Repo Sensei' })
}

async function exportPack($: $T): Promise<string> {
  const info = await read($, repo)
  const list = await read($, concepts)
  if (!info || list.length === 0) return 'No onboarding pack yet. Run /learn-repo first.'
  const done = new Set(await read($, learned))
  const q = (s: string) => `"${s.replaceAll('"', '""').replaceAll('\n', ' ')}"`
  const csv = list
    .map(c => [
      q(`[${info.name}] What is "${c.name}" and why does it matter here?`),
      q(`${c.why} ${c.explainer} Files: ${c.files.slice(0, 4).join(', ')}`),
      q(`repo-sensei ${c.level}`),
    ].join(','))
    .join('\n')
  const total = list.length
  const count = list.filter(c => done.has(c.id)).length
  const md = [
    `# ${info.name}: learning progress`,
    '',
    `\`${bar(count, total, 20)}\` **${count}/${total}** concepts learned`,
    '',
    '| # | Concept | Level | Status | Start with |',
    '|---|---|---|---|---|',
    ...list.map((c, i) =>
      `| ${i + 1} | ${c.name} | ${c.level} | ${done.has(c.id) ? '✅ learned' : '⬜ to learn'} | ${c.files.slice(0, 2).join(', ')} |`),
    '',
    `Next up: **${list.find(c => !done.has(c.id))?.name ?? 'all done, pick a medium issue!'}**`,
  ].join('\n')
  await $.fs.write(`${info.root}/${DIR}/flashcards.csv`, csv + '\n')
  await $.fs.write(`${info.root}/${DIR}/PROGRESS.md`, md + '\n')
  return `Exported ${DIR}/flashcards.csv (import into Anki: Front, Back, Tags) and ${DIR}/PROGRESS.md (${count}/${total} learned).`
}

// ── Hooks ────────────────────────────────────────────────────────────────
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'learn-repo', description: 'Repo Sensei: map this codebase and build your onboarding pack' })
    await $.command.register({ name: 'sensei', description: 'Repo Sensei: open your learning panel' })
    await $.command.register({ name: 'learned', description: 'Repo Sensei: mark a concept as learned (or "undo <concept>")', argumentHint: '<concept>' })
    await $.command.register({ name: 'sensei-export', description: 'Repo Sensei: export flashcards (Anki CSV) and a progress report' })
    await $.command.register({ name: 'catchup', description: 'Repo Sensei: summary, files to read, a lesson and a quiz on what changed (since your last catch-up)', argumentHint: '[yesterday | 3d | week]' })

    const info = await findRepo($)
    await update($, repo, () => info)
    await loadLearned($, info.root)

    // Daily catch-up: offered at most once a day, only when something changed.
    const now = await $.clock.now()
    const last = ((await $.store.get(catchupKey(info.root))) as number | undefined) ?? null
    const offeredToday = (await $.store.get(offeredKey(info.root))) === dayOf(now)
    const isSeen = info.hasPack || (((await $.store.get('seen')) as string[] | undefined) ?? []).includes(info.root)
    if (isSeen && !offeredToday && (await $.fs.exists(`${info.root}/.git`))) {
      const since = last ?? now - DAY
      const n = await quickCounts($, info.root, since)
      const isOffered = n.commits + n.files + n.touched > 0
      await update($, catchup, () => ({ ...n, sinceLabel: last ? `your last catch-up (${ago(last, now)})` : 'the last 24 hours', lastAt: last, isOffered }))
      if (isOffered) {
        await $.store.set(offeredKey(info.root), dayOf(now))
        $.ui.toast(`☀️ ${n.commits} commits, ${n.files} files changed in ${info.name} since you last caught up. /catchup`)
      }
    } else {
      await update($, catchup, () => ({ commits: 0, files: 0, touched: 0, sinceLabel: '', lastAt: last, isOffered: false }))
    }

    if (info.hasPack) {
      await loadPack($, info.root)
      await refreshStatus($)
    } else if (await $.fs.exists(`${info.root}/.git`)) {
      const seen = ((await $.store.get('seen')) as string[] | undefined) ?? []
      if (!seen.includes(info.root)) {
        await $.store.set('seen', [...seen, info.root].slice(-200))
        await update($, offer, () => true)
        $.ui.toast(`🧭 New codebase: ${info.name}. Run /learn-repo for your onboarding pack.`)
      }
    }
    return started
  })

  on('command.run', { command: 'learn-repo' }, async $ => ({ text: await runLearnRepo($) }))

  on('command.run', { command: 'sensei' }, async $ => {
    const info = await read($, repo)
    if (info) await loadPack($, info.root)
    await openPane($)
    return { text: 'Repo Sensei panel opened.' }
  })

  on('command.run', { command: 'learned' }, async ($, e) => {
    const list = await read($, concepts)
    const isUndo = /^undo\s+/i.test(e.args)
    const c = findConcept(list, e.args.replace(/^undo\s+/i, ''))
    if (!c) {
      return { text: list.length ? `No concept matches "${e.args}". Try one of: ${list.map(x => x.id).join(', ')}` : 'No onboarding pack yet. Run /learn-repo first.' }
    }
    await setLearned($, c.id, !isUndo)
    const done = (await read($, learned)).length
    return { text: isUndo ? `↩︎ "${c.name}" moved back to your learning list.` : `✅ "${c.name}" learned. ${done}/${list.length} done.` }
  })

  on('command.run', { command: 'sensei-export' }, async $ => ({ text: await exportPack($) }))

  on('command.run', { command: 'catchup' }, async ($, e) => ({ text: await runCatchup($, e.args) }))

  // When Claude writes the pack, load it and open the panel.
  // Every other edit: check whether it touches a concept you haven't learned.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    if (!EDIT_TOOLS.has(tool) || ran.deny !== undefined || ran.isError === true) return ran

    const input = e as unknown as { file_path?: string; notebook_path?: string; new_string?: string; content?: string; edits?: { new_string?: string }[] }
    const path = input.file_path ?? input.notebook_path ?? ''
    const info = await read($, repo)
    if (!info || !path) return ran

    if (path.endsWith(`${DIR}/concepts.json`)) {
      const n = await loadPack($, info.root)
      if (n > 0) {
        await update($, repo, r => (r ? { ...r, hasPack: true } : r))
        await refreshStatus($)
        $.ui.toast(`🧭 Onboarding pack ready: ${n} concepts on your learning path.`)
        void openPane($)
      }
      return ran
    }
    if (path.includes(`/${DIR}/`)) return ran

    // Remember what Claude changed, for the daily catch-up.
    const rel0 = path.startsWith(info.root) ? path.slice(info.root.length + 1) : path
    const at = await $.clock.now()
    await $.store.set(touchedKey(info.root), [...(await readTouched($, info.root)), { path: rel0, at }].filter(t => at - t.at < 14 * DAY).slice(-500))

    const list = await read($, concepts)
    if (list.length === 0) return ran
    const done = new Set(await read($, learned))
    const rel = path.startsWith(info.root) ? path.slice(info.root.length + 1) : path
    let text = [input.new_string, input.content, ...(input.edits ?? []).map(x => x.new_string)].filter(Boolean).join('\n')
    try {
      text += '\n' + (await $.fs.read(path))
    } catch {
      /* file unreadable: judge by the edit alone */
    }

    const hit = list.find(c =>
      !done.has(c.id) && !nudgedThisSession.has(c.id) &&
      (c.signals.some(s => text.includes(s)) ||
        c.files.some(f => f.length > 2 && (rel === f || rel.startsWith(f.endsWith('/') ? f : `${f}/`)))))
    if (hit) {
      nudgedThisSession.add(hit.id)
      const n: Nudge = { conceptId: hit.id, name: hit.name, file: rel, why: hit.why }
      await update($, nudge, () => n)
      $.ui.toast(`🧭 This edit uses ${hit.name}, which you haven't learned yet.`)
    }
    return ran
  }).catch(($, e, next) => next(e)) // never block an edit because the mentor failed

  // The band above the prompt: a live nudge, or the new-codebase offer.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const n = await read($, nudge)
    const isOffer = await read($, offer)
    const cu = await read($, catchup)
    const isCatchup = cu?.isOffered === true
    if (!n && !isOffer && !isCatchup) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (n) {
      const c = (await read($, concepts)).find(x => x.id === n.conceptId)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
          <Text>
            <Text bold>🧭 Repo Sensei</Text>  This change in <Text bold>{n.file}</Text> uses <Text bold color="suggestion">{n.name}</Text>, which you haven't learned yet.
          </Text>
          <Text dimColor>{n.why}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="explain" variant="primary" hotkey="e" onPress={async () => {
              await update($, nudge, () => null)
              if (c) void $.prompt.submit({ text: explainPrompt(c, n.file) })
            }}>Explain in 2 min</Button>
            <Button key="know" hotkey="k" onPress={async () => {
              await update($, nudge, () => null)
              await setLearned($, n.conceptId, true)
            }}>I know this</Button>
            <Button key="later" role="dismiss" dimColor onPress={() => update($, nudge, () => null)}>Later</Button>
          </Box>
        </Box>
      )
    }

    const info = await read($, repo)
    if (isCatchup && cu && !isOffer) {
      return (
        <Box flexDirection="row" gap={1} borderStyle="round" borderColor="warning" paddingX={1}>
          <Text><Text bold>☀️ Daily catch-up:</Text> {cu.commits} commits · {cu.files} files changed{cu.touched ? ` · ${cu.touched} edited by Claude` : ''} since {cu.sinceLabel}.</Text>
          <Button key="catchup" variant="primary" hotkey="c" onPress={async () => {
            await update($, catchup, c => (c ? { ...c, isOffered: false } : c))
            void runCatchup($, '').then(t => $.ui.toast(t))
          }}>Catch me up + quiz</Button>
          <Button key="skip" role="dismiss" dimColor onPress={() => update($, catchup, c => (c ? { ...c, isOffered: false } : c))}>Skip today</Button>
        </Box>
      )
    }
    return (
      <Box flexDirection="row" gap={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
        <Text><Text bold>🧭 New codebase:</Text> {info?.name ?? 'this repo'}. Get the stack, the flow and your learning path?</Text>
        <Button key="build" variant="primary" hotkey="b" onPress={async () => {
          await update($, offer, () => false)
          void runLearnRepo($).then(t => $.ui.toast(t))
        }}>Build my onboarding pack</Button>
        <Button key="no" role="dismiss" dimColor onPress={() => update($, offer, () => false)}>Not now</Button>
      </Box>
    )
  })

  // The learning panel.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const info = await read($, repo)
    const list = await read($, concepts)
    const done = new Set(await read($, learned))

    if (list.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>🧭 Repo Sensei</Text>
          <Text dimColor>No onboarding pack for {info?.name ?? 'this repo'} yet.</Text>
          <Button key="build" variant="primary" onPress={() => void runLearnRepo($).then(t => $.ui.toast(t))}>Build my onboarding pack</Button>
          <Button key="pane-catchup" onPress={() => void runCatchup($, '').then(t => $.ui.toast(t))}>☀️ Catch me up on recent changes</Button>
        </Box>
      )
    }

    const lastCatchup = (await read($, catchup))?.lastAt ?? null
    const nowMs = await $.clock.now()
    const count = list.filter(c => done.has(c.id)).length
    const nextUp = list.find(c => !done.has(c.id))
    const ready = count / list.length >= 0.6
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 30) - 10) / 2))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>🧭 {info?.name}</Text>
          <Text><Text color="success">{bar(count, list.length)}</Text>  {count}/{list.length} concepts learned</Text>
          <Text dimColor>
            {nextUp ? `Next up: ${nextUp.name}` : 'Path complete!'}{ready ? '  ·  Ready for a medium issue 🚀' : ''}
          </Text>
          <Text dimColor>☀️ Last catch-up: {lastCatchup ? ago(lastCatchup, nowMs) : 'never'}</Text>
        </Box>
        <Box flexDirection="column">
          {list.slice(0, room).map((c, i) => {
            const isDone = done.has(c.id)
            return (
              <Box key={c.id} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={isDone ? 'success' : undefined}>{isDone ? '✓' : '○'} {i + 1}. </Text>
                  <Text bold={!isDone} strikethrough={false} dimColor={isDone}>{c.name}</Text>
                  <Text dimColor>[{c.level}]</Text>
                  <Button key={`explain-${c.id}`} dimColor onPress={() => void $.prompt.submit({ text: explainPrompt(c) })}>Explain</Button>
                  <Button key={`toggle-${c.id}`} dimColor onPress={() => setLearned($, c.id, !isDone)}>{isDone ? 'Undo' : 'Learned'}</Button>
                </Box>
                <Text dimColor wrap="truncate-end">   {c.why}</Text>
              </Box>
            )
          })}
          {list.length > room && <Text dimColor>…and {list.length - room} more (see {DIR}/ONBOARDING.md)</Text>}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="pane-catchup" variant="primary" onPress={() => void runCatchup($, '').then(t => $.ui.toast(t))}>☀️ Catch me up</Button>
          <Button key="export" onPress={async () => $.ui.toast(await exportPack($))}>Export flashcards</Button>
          <Button key="rebuild" dimColor onPress={() => void runLearnRepo($).then(t => $.ui.toast(t))}>Rebuild pack</Button>
        </Box>
      </Box>
    )
  })
}
