export type CueStatus = 'draft' | 'reviewed' | 'issue'
export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'

export interface Cue {
  id: string
  start: number
  end: number
  source: string
  target: string
  actorId: string
  speed: number
  termIds: string[]
  status: CueStatus
  locked: boolean
  /** 片方修订对账：原文或时码已变（重新确认校对后清除） */
  sourceChanged?: boolean
  /** 未锁定台词套用片方新版后，保留的旧原文（供新旧并排） */
  oldSource?: string
  oldStart?: number
  oldEnd?: number
  /** 锁定台词暂挂的片方新原文/新时码（台词本身照旧不动） */
  pendingSource?: string
  pendingStart?: number
  pendingEnd?: number
  /** 片方在新版中删除、但因锁定而保留在台本中的台词 */
  removedInRevision?: boolean
}

export interface Actor {
  id: string
  name: string
  color: string
  localeHint: string
}

export interface Term {
  id: string
  source: string
  target: string
  note: string
}

export interface Snapshot {
  id: string
  name: string
  createdAt: number
  cues: Cue[]
}

/** 片方去掉台词后，译文随原台词整体转入存档 */
export interface ArchivedCue {
  id: string
  cueNumber: number
  cue: Cue
  packageId: string
  sourceVersion: string
  archivedAt: number
}

/** 片方修订包中的单条台词（只含片方负责的字段：原文与时码） */
export interface RevisionPackageCue {
  /** 片方新版完整列表序号（从 1 连续编号） */
  number: number
  /** 台词稳定编号，跨版本不变，对账按此对位 */
  cueId: string
  start: number
  end: number
  source: string
}

export interface RevisionPackage {
  packageId: string
  sourceVersion: string
  issuedAt?: number
  cues: RevisionPackageCue[]
}

export interface AppliedPackage {
  packageId: string
  sourceVersion: string
  contentHash: string
  appliedAt: number
  changed: number
  added: number
  removed: number
  lockedPending: number
  unchanged: number
}

export interface RevisionResult {
  packageId: string
  sourceVersion: string
  changed: number
  added: number
  removed: number
  lockedPending: number
  unchanged: number
}

export interface EditorDocument {
  id: string
  title: string
  language: Locale
  cues: Cue[]
  actors: Actor[]
  terms: Term[]
  snapshots: Snapshot[]
  /** 当前原文字幕版本（片方侧），旧稿升级后回填为 baseline */
  sourceVersion: string
  archive: ArchivedCue[]
  appliedPackages: AppliedPackage[]
  updatedAt: number
  revision: number
  lastWriter: string
}

export interface CueConflict {
  cueId: string
  type: 'actor' | 'tone' | 'address'
  message: string
}

export interface HistoryEntry {
  label: string
  cues: Cue[]
  selectedCueId: string | null
  sourceVersion: string
  archive: ArchivedCue[]
  appliedPackages: AppliedPackage[]
}
