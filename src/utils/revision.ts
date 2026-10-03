import type {
  ArchivedCue, Cue, EditorDocument, RevisionPackage, RevisionPackageCue, RevisionStats,
} from '../types'
import { makeId } from './id'
import { parseTime } from './subtitle'

/** 时码按毫秒对齐，小于 1ms 的差异视为未改 */
const TIMING_EPSILON = 0.001
export const BASELINE_SOURCE_VERSION = 'baseline'
export const REVISION_PARSE_ERROR = 'REVISION_PARSE_ERROR'
export const REVISION_DUPLICATE = 'REVISION_DUPLICATE'

/**
 * 解析片方修订包。任何字段不合规都视为“修订包解析失败”，
 * 由调用方整包拒绝，不产生任何改动。
 */
export function parseRevisionPackage(text: string): RevisionPackage {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(REVISION_PARSE_ERROR)
  }
  if (typeof raw !== 'object' || raw === null) throw new Error(REVISION_PARSE_ERROR)
  const obj = raw as Record<string, unknown>
  const packageId = obj.packageId ?? obj.id
  const version = obj.version
  const cueList = obj.cues
  if (typeof packageId !== 'string' || !packageId.trim()) throw new Error(REVISION_PARSE_ERROR)
  if (typeof version !== 'string' || !version.trim()) throw new Error(REVISION_PARSE_ERROR)
  if (!Array.isArray(cueList) || cueList.length === 0) throw new Error(REVISION_PARSE_ERROR)

  const seen = new Set<number>()
  const cues: RevisionPackageCue[] = cueList.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(REVISION_PARSE_ERROR)
    const item = entry as Record<string, unknown>
    const lineNo = Number(item.lineNo)
    if (!Number.isInteger(lineNo) || lineNo <= 0 || seen.has(lineNo)) throw new Error(REVISION_PARSE_ERROR)
    seen.add(lineNo)
    const start = readRevisionTime(item.start)
    const end = readRevisionTime(item.end)
    if (start === null || end === null || end <= start) throw new Error(REVISION_PARSE_ERROR)
    if (typeof item.source !== 'string' || !item.source.trim()) throw new Error(REVISION_PARSE_ERROR)
    return { lineNo, start, end, source: item.source.replace(/\s+/g, ' ').trim() }
  })

  return { packageId: packageId.trim(), version: version.trim(), cues }
}

const readRevisionTime = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Number(value.toFixed(3))
  if (typeof value === 'string' && /\d/.test(value)) {
    const parsed = parseTime(value)
    return Number.isFinite(parsed) ? Number(parsed.toFixed(3)) : null
  }
  return null
}

/** 修订包内容指纹：编号 + 时码 + 原文，用于识别换编号重发的同一批 */
export const revisionContentHash = (revision: RevisionPackage): string =>
  revision.cues
    .map((cue) => `${cue.lineNo}:${cue.start.toFixed(3)}-${cue.end.toFixed(3)}:${cue.source}`)
    .join('|')

const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
const sameTiming = (a: number, b: number) => Math.abs(a - b) < TIMING_EPSILON

export interface RevisionApplication {
  cues: Cue[]
  archived: ArchivedCue[]
  stats: RevisionStats
}

/**
 * 纯函数对账：按台词编号比对当前工作稿与修订包。
 * - 原文或时码改过的非锁定台词 → 更新、退回待校对、新旧原文并列
 * - 锁定台词照旧不动，标出原文/时码已变，新内容挂起待解锁
 * - 片方去掉的编号 → 译文转入存档
 * - 片方新增的编号 → 新建待校对台词
 */
export function applyRevisionToCues(
  cues: Cue[],
  archived: ArchivedCue[],
  revision: RevisionPackage,
  defaultActorId: string,
): RevisionApplication {
  const working = cues.map((cue) => ({ ...cue }))
  const nextArchived = archived.map((cue) => ({ ...cue }))
  const incoming = new Map(revision.cues.map((cue) => [cue.lineNo, cue]))
  const stats: RevisionStats = { changed: 0, added: 0, removed: 0 }

  // 片方去掉的台词（修订包里没有的编号）→ 译文转入存档
  for (const cue of [...working]) {
    if (cue.lineNo === null || incoming.has(cue.lineNo)) continue
    const index = working.findIndex((item) => item.id === cue.id)
    const [removed] = working.splice(index, 1)
    nextArchived.unshift({
      ...removed,
      status: 'draft',
      previousSource: undefined,
      previousStart: undefined,
      previousEnd: undefined,
      sourceChanged: undefined,
      timingChanged: undefined,
      pendingSource: undefined,
      pendingStart: undefined,
      pendingEnd: undefined,
      sourceVersion: undefined,
      archivedAt: Date.now(),
      removedByPackageId: revision.packageId,
      removedAt: Date.now(),
      restored: false,
    })
    stats.removed += 1
  }

  // 同编号：原文或时码变过 → 退回待校对
  for (const cue of working) {
    if (cue.lineNo === null) continue
    const update = incoming.get(cue.lineNo)
    if (!update) continue
    const textChanged = !sameText(cue.source, update.source)
    const timingChanged = !sameTiming(cue.start, update.start) || !sameTiming(cue.end, update.end)
    if (!textChanged && !timingChanged) continue

    if (cue.locked) {
      // 锁定台词照旧不动，仅标出原文已变；新内容挂起，解锁后由译制台决定采用
      cue.previousSource = cue.source
      if (timingChanged) {
        cue.previousStart = cue.start
        cue.previousEnd = cue.end
      }
      cue.sourceChanged = textChanged
      cue.timingChanged = timingChanged
      cue.pendingSource = update.source
      cue.pendingStart = update.start
      cue.pendingEnd = update.end
      cue.revisionPackageId = revision.packageId
    } else {
      cue.previousSource = cue.source
      if (timingChanged) {
        cue.previousStart = cue.start
        cue.previousEnd = cue.end
        cue.start = update.start
        cue.end = update.end
      }
      cue.source = update.source
      cue.sourceChanged = textChanged
      cue.timingChanged = timingChanged
      cue.pendingSource = undefined
      cue.pendingStart = undefined
      cue.pendingEnd = undefined
      cue.status = 'draft'
      cue.sourceVersion = revision.version
      cue.revisionPackageId = revision.packageId
    }
    stats.changed += 1
  }

  // 片方新增的台词编号
  const known = new Set(working.filter((cue) => cue.lineNo !== null).map((cue) => cue.lineNo as number))
  for (const update of revision.cues) {
    if (known.has(update.lineNo)) continue
    const cue: Cue = {
      id: makeId('cue'),
      lineNo: update.lineNo,
      start: update.start,
      end: update.end,
      source: update.source,
      target: '',
      actorId: defaultActorId,
      speed: 1,
      termIds: [],
      status: 'draft',
      locked: false,
      sourceVersion: revision.version,
      revisionPackageId: revision.packageId,
    }
    insertByLineNo(working, cue)
    stats.added += 1
  }

  return { cues: working, archived: nextArchived, stats }
}

/** 新编号按编号顺序插入到第一个编号更大的活动台词之前，找不到则追加到末尾 */
const insertByLineNo = (cues: Cue[], cue: Cue) => {
  const index = cues.findIndex((item) => item.lineNo !== null && (item.lineNo as number) > (cue.lineNo as number))
  if (index >= 0) cues.splice(index, 0, cue)
  else cues.push(cue)
}

/** 导出当前活动稿为修订包格式（便于片方基线流转与演示） */
export function buildRevisionPackage(cues: Cue[], version: string, packageId = makeId('rev')): RevisionPackage {
  const numbered = cues
    .filter((cue) => cue.lineNo !== null)
    .sort((a, b) => (a.lineNo as number) - (b.lineNo as number))
  const list: RevisionPackageCue[] = numbered.length
    ? numbered.map((cue) => ({ lineNo: cue.lineNo as number, start: cue.start, end: cue.end, source: cue.source }))
    : cues.map((cue, index) => ({ lineNo: index + 1, start: cue.start, end: cue.end, source: cue.source }))
  return { packageId, version, cues: list }
}

/**
 * 旧稿升级：没记原文字幕版本的文档按当前版本回填。
 * 旧台词没有编号时，按列表顺序补 1..N 的片方编号。
 * 返回是否发生过迁移。
 */
export function migrateDocument(document: EditorDocument, currentVersion: string): boolean {
  let migrated = false
  if (!document.sourceVersion) {
    document.sourceVersion = currentVersion
    migrated = true
  }
  if (!Array.isArray(document.archivedCues)) {
    document.archivedCues = []
    migrated = true
  }
  if (!Array.isArray(document.appliedRevisions)) {
    document.appliedRevisions = []
    migrated = true
  }
  document.cues.forEach((cue, index) => {
    if (cue.lineNo === undefined) {
      cue.lineNo = index + 1
      migrated = true
    }
    if (!cue.sourceVersion) {
      cue.sourceVersion = currentVersion
      migrated = true
    }
  })
  return migrated
}
