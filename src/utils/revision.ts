import type { RevisionPackage } from '../types'

/** 解析失败一律抛 REVISION_PARSE_ERROR，调用方据此保证整包不生效 */
export class RevisionParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RevisionParseError'
  }
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * 解析片方修订包（JSON）。
 * 规则：
 * - 必须有 packageId / sourceVersion；
 * - 编号 number 为从 1 起的连续整数（片方新版完整列表序号）；
 * - cueId 为台词稳定编号（跨版本不变，对账以此对位），必填且不重复；
 * - 时码合法（0 ≤ start < end）；原文非空。
 * 任何一项不满足即整包解析失败。
 */
export const parseRevisionPackage = (text: string): RevisionPackage => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new RevisionParseError('REVISION_PARSE_ERROR')
  }
  if (typeof raw !== 'object' || raw === null) throw new RevisionParseError('REVISION_PARSE_ERROR')
  const obj = raw as Record<string, unknown>
  const packageId = typeof obj.packageId === 'string' ? obj.packageId.trim() : ''
  const sourceVersion = typeof obj.sourceVersion === 'string' ? obj.sourceVersion.trim() : ''
  if (!packageId || !sourceVersion) throw new RevisionParseError('REVISION_PARSE_ERROR')
  if (!Array.isArray(obj.cues) || obj.cues.length === 0) throw new RevisionParseError('REVISION_PARSE_ERROR')

  const cues = obj.cues.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new RevisionParseError('REVISION_PARSE_ERROR')
    const cue = entry as Record<string, unknown>
    if (!isFiniteNumber(cue.number) || !Number.isInteger(cue.number) || cue.number < 1) {
      throw new RevisionParseError('REVISION_PARSE_ERROR')
    }
    if (cue.number !== index + 1) throw new RevisionParseError('REVISION_PARSE_ERROR')
    const cueId = typeof cue.cueId === 'string' ? cue.cueId.trim() : ''
    if (!cueId) throw new RevisionParseError('REVISION_PARSE_ERROR')
    if (!isFiniteNumber(cue.start) || !isFiniteNumber(cue.end) || cue.start < 0 || cue.end <= cue.start) {
      throw new RevisionParseError('REVISION_PARSE_ERROR')
    }
    const source = typeof cue.source === 'string' ? cue.source.trim() : ''
    if (!source) throw new RevisionParseError('REVISION_PARSE_ERROR')
    return { number: cue.number, cueId, start: cue.start, end: cue.end, source }
  })

  if (new Set(cues.map((cue) => cue.cueId)).size !== cues.length) {
    throw new RevisionParseError('REVISION_PARSE_ERROR')
  }
  return {
    packageId,
    sourceVersion,
    issuedAt: isFiniteNumber(obj.issuedAt) ? obj.issuedAt : undefined,
    cues,
  }
}

/** FNV-1a 32 位哈希，只对包内容（稳定编号、序号、时码、原文）与目标版本计算，不含 packageId */
export const revisionContentHash = (pkg: RevisionPackage): string => {
  const payload = JSON.stringify({
    sourceVersion: pkg.sourceVersion,
    cues: pkg.cues.map((cue) => [cue.cueId, cue.number, Number(cue.start.toFixed(3)), Number(cue.end.toFixed(3)), cue.source]),
  })
  let hash = 0x811c9dc5
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 生成一份与当前台本对应的修订包样例，供下载模板/演示 */
export const buildRevisionPackageJson = (
  sourceVersion: string,
  cues: { id: string; start: number; end: number; source: string }[],
): string => {
  const pkg: RevisionPackage = {
    packageId: `studio-rev-${Date.now()}`,
    sourceVersion,
    issuedAt: Date.now(),
    cues: cues.map((cue, index) => ({ number: index + 1, cueId: cue.id, start: cue.start, end: cue.end, source: cue.source })),
  }
  return JSON.stringify(pkg, null, 2)
}
