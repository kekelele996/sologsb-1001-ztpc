export type CueStatus = 'draft' | 'reviewed' | 'issue'
export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'

export interface Cue {
  id: string
  /** 片方台词编号，用于修订包对账；本地拆分产生的台词为 null */
  lineNo: number | null
  start: number
  end: number
  source: string
  target: string
  actorId: string
  speed: number
  termIds: string[]
  status: CueStatus
  locked: boolean
  /** 该条当前原文/时码对应的片方字幕版本 */
  sourceVersion?: string
  /** 片方更新前的原文（新旧原文并列展示用） */
  previousSource?: string
  /** 片方更新前的起始时码（秒） */
  previousStart?: number
  /** 片方更新前的结束时码（秒） */
  previousEnd?: number
  /** 原文是否已被片方修改（锁定台词照旧不动，仅标出） */
  sourceChanged?: boolean
  /** 时码是否已被片方修改 */
  timingChanged?: boolean
  /** 锁定台词暂不套用的新原文，解锁后可采用 */
  pendingSource?: string
  pendingStart?: number
  pendingEnd?: number
  /** 引起本次变更的修订包编号 */
  revisionPackageId?: string
  archivedAt?: number
}

export interface ArchivedCue extends Cue {
  /** 被哪个修订包移除并归档 */
  removedByPackageId: string
  removedAt: number
  restored?: boolean
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

/** 已应用的片方修订包记录（重发同一批不重复套用） */
export interface AppliedRevision {
  packageId: string
  version: string
  appliedAt: number
  /** 修订包内容指纹，防止换个编号重发 */
  contentHash: string
  changed: number
  added: number
  removed: number
}

export interface EditorDocument {
  id: string
  title: string
  language: Locale
  cues: Cue[]
  actors: Actor[]
  terms: Term[]
  snapshots: Snapshot[]
  /** 当前已对账到的片方原文字幕版本 */
  sourceVersion: string
  archivedCues: ArchivedCue[]
  appliedRevisions: AppliedRevision[]
  updatedAt: number
  revision: number
  lastWriter: string
}

export interface RevisionPackageCue {
  lineNo: number
  start: number
  end: number
  source: string
}

export interface RevisionPackage {
  packageId: string
  version: string
  cues: RevisionPackageCue[]
}

export interface RevisionStats {
  changed: number
  added: number
  removed: number
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
  sourceVersion?: string
  archivedCues?: ArchivedCue[]
}
