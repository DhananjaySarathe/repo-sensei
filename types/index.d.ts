/** One thing a newcomer must understand to contribute to the repo. */
export type Concept = {
  id: string
  name: string
  level: 'basic' | 'core' | 'advanced'
  why: string
  files: string[]
  signals: string[]
  explainer: string
}

/** A live "you haven't learned this yet" moment raised by an edit. */
export type Nudge = { conceptId: string; name: string; file: string; why: string }

/** The repository the session is in. */
export type RepoInfo = { root: string; name: string; hasPack: boolean }

/** The daily catch-up: what changed since the last one, and whether to offer it. */
export type Catchup = {
  commits: number
  files: number
  touched: number
  sinceLabel: string
  lastAt: number | null
  isOffered: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'repo-sensei': {
      concepts: Shaped<Concept[]>
      learned: Shaped<string[]>
      nudge: Nudge | null
      repo: RepoInfo | null
      offer: boolean
      catchup: Shaped<Catchup | null>
    }
  }
}
