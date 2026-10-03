import { defineStore } from 'pinia'
import type {
  AppliedPackage, ArchivedCue, Cue, EditorDocument, HistoryEntry, Locale, RevisionPackage, RevisionResult, Snapshot,
} from '../types'
import { loadDocument, saveDocument } from '../utils/db'
import { makeId } from '../utils/id'
import { parseScript, parseSrt, toSrt } from '../utils/subtitle'
import { buildRevisionPackageJson, parseRevisionPackage, revisionContentHash } from '../utils/revision'
import { translate, type MessageKey } from '../i18n'

const DOCUMENT_ID = 'subtitle-dubbing-document'
/** 旧稿没有记录原文字幕版本，升级后按当前版本回填 */
const BASELINE_SOURCE_VERSION = 'baseline'
const TIME_EPSILON = 0.001
let saveTimer: ReturnType<typeof setTimeout> | undefined
let channel: BroadcastChannel | undefined

const cloneCues = (cues: Cue[]): Cue[] => JSON.parse(JSON.stringify(cues)) as Cue[]
const plainDocument = (document: EditorDocument): EditorDocument => JSON.parse(JSON.stringify(document)) as EditorDocument

/** 旧稿升级：补齐新增的片方版本、存档与已应用修订包字段，返回是否发生回填 */
const migrateDocument = (document: EditorDocument): boolean => {
  let changed = false
  if (typeof document.sourceVersion !== 'string' || !document.sourceVersion) {
    document.sourceVersion = BASELINE_SOURCE_VERSION
    changed = true
  }
  if (!Array.isArray(document.archive)) { document.archive = []; changed = true }
  if (!Array.isArray(document.appliedPackages)) { document.appliedPackages = []; changed = true }
  if (changed) document.updatedAt = Date.now()
  return changed
}

const createDefaultDocument = (): EditorDocument => ({
  id: DOCUMENT_ID,
  title: '纪录片《开源之路》中文配音',
  language: 'zh-CN',
  revision: 0,
  updatedAt: Date.now(),
  lastWriter: '',
  actors: [
    { id: 'actor-narrator', name: '旁白 / Narrator', color: '#2f6fed', localeHint: 'zh-CN' },
    { id: 'actor-lin', name: '林博士 / Dr. Lin', color: '#cf5a39', localeHint: 'zh-CN' },
    { id: 'actor-chen', name: '陈工 / Engineer Chen', color: '#14866d', localeHint: 'zh-CN' },
    { id: 'actor-host', name: '主持人 / Host', color: '#7d53b8', localeHint: 'zh-CN' },
  ],
  terms: [
    { id: 'term-01', source: 'open source', target: '开源', note: '产品语境' },
    { id: 'term-02', source: 'maintainer', target: '维护者', note: '不使用“管理者”' },
    { id: 'term-03', source: 'pull request', target: '拉取请求', note: '首次出现保留英文缩写 PR' },
    { id: 'term-04', source: 'community', target: '社区', note: '泛指开发者社区' },
  ],
  cues: [
    { id: 'cue-demo-01', start: 0, end: 4.2, source: '开源并不是一项孤立的技术，而是一种持续协作的方式。', target: '开源并不是一项孤立的技术，而是一种持续协作的方式。', actorId: 'actor-narrator', speed: 1.02, termIds: ['term-01'], status: 'reviewed', locked: true },
    { id: 'cue-demo-02', start: 4.3, end: 8.6, source: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', target: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', actorId: 'actor-host', speed: 1, termIds: ['term-04', 'term-02'], status: 'reviewed', locked: false },
    { id: 'cue-demo-03', start: 8.8, end: 13.5, source: '每个拉取请求背后，都有一段需要被理解的上下文。', target: '每个拉取请求背后，都有一段需要被理解的上下文。', actorId: 'actor-lin', speed: 0.96, termIds: ['term-03'], status: 'reviewed', locked: false },
    { id: 'cue-demo-04', start: 13.7, end: 18.8, source: '请您先介绍一次印象最深的代码评审。', target: '请您先介绍一次印象最深的代码评审。', actorId: 'actor-host', speed: 1.03, termIds: [], status: 'draft', locked: false },
    { id: 'cue-demo-05', start: 19, end: 25.1, source: '那次修改很小，却让新用户第一次能够顺利完成安装。', target: '那次修改很小，却让新用户第一次顺利完成安装。', actorId: 'actor-lin', speed: 0.98, termIds: [], status: 'issue', locked: false },
    { id: 'cue-demo-06', start: 25.4, end: 31.2, source: '所以我们决定把安装说明拆开，并为每个平台补上验证步骤。', target: '因此，我们拆分安装说明，并为每个平台补上验证步骤。', actorId: 'actor-chen', speed: 1.05, termIds: [], status: 'draft', locked: false },
  ],
  snapshots: [],
  sourceVersion: BASELINE_SOURCE_VERSION,
  archive: [],
  appliedPackages: [],
})

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict'

export const useEditorStore = defineStore('subtitle-editor', {
  state: () => ({
    document: createDefaultDocument(),
    selectedCueId: 'cue-demo-03' as string | null,
    actorFilter: 'all',
    timelineZoom: 1,
    saveState: 'saved' as SaveState,
    saving: false,
    initialized: false,
    conflict: false,
    online: navigator.onLine,
    tabId: makeId('tab'),
    lastSeenRevision: 0,
    mutationSerial: 0,
    past: [] as HistoryEntry[],
    future: [] as HistoryEntry[],
  }),
  getters: {
    t: (state) => (key: MessageKey, values?: Record<string, string | number>) => translate(state.document.language, key, values),
    selectedCue(state): Cue | undefined {
      return state.document.cues.find((cue) => cue.id === state.selectedCueId)
    },
    visibleCues(state): Cue[] {
      return state.actorFilter === 'all'
        ? state.document.cues
        : state.document.cues.filter((cue) => cue.actorId === state.actorFilter)
    },
    totalDuration(state): number {
      return Math.max(10, ...state.document.cues.map((cue) => cue.end)) * 1.04
    },
  },
  actions: {
    async initialize() {
      if (this.initialized) return
      this.online = navigator.onLine
      const stored = await loadDocument(DOCUMENT_ID)
      if (stored) {
        this.document = stored
        this.lastSeenRevision = stored.revision
        // 旧稿没记原文字幕版本：按当前版本回填并落库
        if (migrateDocument(stored)) {
          const saved = await saveDocument(plainDocument(this.document), this.lastSeenRevision)
          this.document = saved
          this.lastSeenRevision = saved.revision
        }
      } else {
        const saved = await saveDocument(plainDocument(this.document))
        this.document = saved
        this.lastSeenRevision = saved.revision
      }
      this.initialized = true
      if ('BroadcastChannel' in window) {
        channel = new BroadcastChannel('sologsb-1001-document')
        channel.onmessage = async (event) => {
          const message = event.data as { type: string; tabId: string; revision: number; documentId: string }
          if (message.type !== 'document-updated' || message.tabId === this.tabId || message.documentId !== DOCUMENT_ID) return
          if (message.revision <= this.lastSeenRevision) return
          if (this.saveState === 'dirty' || this.saveState === 'saving' || this.conflict) {
            this.conflict = true
            this.saveState = 'conflict'
            return
          }
          const latest = await loadDocument(DOCUMENT_ID)
          if (latest && latest.revision > this.lastSeenRevision) {
            this.document = latest
            this.lastSeenRevision = latest.revision
            this.saveState = 'saved'
          }
        }
      }
    },
    setOnline(value: boolean) {
      this.online = value
    },
    selectCue(id: string | null) {
      this.selectedCueId = id
    },
    setLocale(locale: Locale) {
      this.document.language = locale
      this.markChanged('language', true)
    },
    /** 片方侧快照：撤销修订包时连同版本号、存档、已应用记录一起回退 */
    revisionSnapshot(): HistoryEntry {
      return {
        label: '',
        cues: cloneCues(this.document.cues),
        selectedCueId: this.selectedCueId,
        sourceVersion: this.document.sourceVersion,
        archive: JSON.parse(JSON.stringify(this.document.archive)) as ArchivedCue[],
        appliedPackages: JSON.parse(JSON.stringify(this.document.appliedPackages)) as AppliedPackage[],
      }
    },
    restoreRevisionSnapshot(entry: HistoryEntry) {
      this.document.cues = cloneCues(entry.cues)
      this.selectedCueId = entry.selectedCueId
      this.document.sourceVersion = entry.sourceVersion
      this.document.archive = JSON.parse(JSON.stringify(entry.archive)) as ArchivedCue[]
      this.document.appliedPackages = JSON.parse(JSON.stringify(entry.appliedPackages)) as AppliedPackage[]
    },
    commit(label: string, mutate: (cues: Cue[]) => void, nextSelection?: string | null) {
      const before: HistoryEntry = {
        label,
        cues: cloneCues(this.document.cues),
        selectedCueId: this.selectedCueId,
        sourceVersion: this.document.sourceVersion,
        archive: JSON.parse(JSON.stringify(this.document.archive)) as ArchivedCue[],
        appliedPackages: JSON.parse(JSON.stringify(this.document.appliedPackages)) as AppliedPackage[],
      }
      const working = cloneCues(this.document.cues)
      mutate(working)
      this.past.push(before)
      if (this.past.length > 60) this.past.shift()
      this.future = []
      this.document.cues = working
      if (nextSelection !== undefined) this.selectedCueId = nextSelection
      this.markChanged(label)
    },
    markChanged(label: string, persist = true) {
      this.document.updatedAt = Date.now()
      if (persist) {
        this.saveState = 'dirty'
        this.mutationSerial += 1
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => void this.persist(label), 500)
      }
    },
    async persist(label = 'autosave') {
      if (!this.initialized || this.conflict || this.saveState === 'saving') return
      const serial = this.mutationSerial
      this.saveState = 'saving'
      this.saving = true
      try {
        const next = await saveDocument({ ...plainDocument(this.document), lastWriter: this.tabId }, this.lastSeenRevision)
        this.document.revision = next.revision
        this.document.updatedAt = next.updatedAt
        this.lastSeenRevision = next.revision
        if (serial === this.mutationSerial) {
          this.saveState = 'saved'
        } else {
          this.saveState = 'dirty'
        }
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: next.revision, documentId: DOCUMENT_ID })
      } catch (error) {
        if (error instanceof Error && error.message === 'REVISION_CONFLICT') {
          this.conflict = true
          this.saveState = 'conflict'
        } else {
          this.saveState = 'dirty'
          console.error(label, error)
        }
      } finally {
        this.saving = false
        if (this.saveState === 'dirty') {
          if (saveTimer) clearTimeout(saveTimer)
          saveTimer = setTimeout(() => void this.persist(label), 700)
        }
      }
    },
    async keepMine() {
      try {
        this.saving = true
        const latest = await loadDocument(DOCUMENT_ID)
        const expected = latest?.revision ?? this.lastSeenRevision
        const next = await saveDocument({ ...plainDocument(this.document), lastWriter: this.tabId }, expected)
        this.document.revision = next.revision
        this.lastSeenRevision = next.revision
        this.conflict = false
        this.saveState = 'saved'
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: next.revision, documentId: DOCUMENT_ID })
      } finally {
        this.saving = false
      }
    },
    async loadLatest() {
      const latest = await loadDocument(DOCUMENT_ID)
      if (!latest) return
      this.document = latest
      this.lastSeenRevision = latest.revision
      this.conflict = false
      this.saveState = 'saved'
      this.selectedCueId = latest.cues[0]?.id ?? null
    },
    undo() {
      const entry = this.past.pop()
      if (!entry) return
      const current = this.revisionSnapshot()
      current.label = entry.label
      this.future.push(current)
      this.restoreRevisionSnapshot(entry)
      this.markChanged(`undo:${entry.label}`)
    },
    redo() {
      const entry = this.future.pop()
      if (!entry) return
      const current = this.revisionSnapshot()
      current.label = entry.label
      this.past.push(current)
      this.restoreRevisionSnapshot(entry)
      this.markChanged(`redo:${entry.label}`)
    },
    updateCue(id: string, patch: Partial<Cue>, historyLabel = 'update-cue') {
      this.commit(historyLabel, (cues) => {
        const cue = cues.find((item) => item.id === id)
        if (!cue || cue.locked) return
        Object.assign(cue, patch)
      })
    },
    markStatus(id: string, status: Cue['status']) {
      this.commit(`status:${status}`, (cues) => {
        const cue = cues.find((item) => item.id === id)
        if (!cue || cue.locked) return
        cue.status = status
        // 重新确认校对后，清除"原文已变/片方已删"标记及并排旧值（未采纳的暂挂新稿保留）
        if (status === 'reviewed') {
          delete cue.sourceChanged
          delete cue.removedInRevision
          delete cue.oldSource
          delete cue.oldStart
          delete cue.oldEnd
        }
      })
    },
    toggleLock(id: string) {
      // 锁定状态翻转本身不受"锁定台词不可编辑"限制，否则无法解锁
      this.commit('toggle-lock', (cues) => {
        const cue = cues.find((item) => item.id === id)
        if (cue) cue.locked = !cue.locked
      })
    },
    splitCue(id: string) {
      const source = this.document.cues.find((cue) => cue.id === id)
      if (!source || source.locked) return
      const ratio = Math.max(0.25, Math.min(0.75, source.source.length ? 0.5 : 0.5))
      const middle = Number((source.start + (source.end - source.start) * ratio).toFixed(2))
      const sourceMid = Math.max(1, Math.round(source.source.length * ratio))
      const targetMid = Math.max(1, Math.round(source.target.length * ratio))
      const secondId = makeId('cue')
      this.commit('split', (cues) => {
        const index = cues.findIndex((cue) => cue.id === id)
        const cue = cues[index]
        const second: Cue = {
          ...cue,
          id: secondId,
          start: middle,
          source: cue.source.slice(sourceMid).trim(),
          target: cue.target.slice(targetMid).trim(),
          status: 'draft',
          locked: false,
        }
        cue.end = middle
        cue.source = cue.source.slice(0, sourceMid).trim()
        cue.target = cue.target.slice(0, targetMid).trim()
        cue.status = 'draft'
        cues.splice(index + 1, 0, second)
      }, secondId)
    },
    mergeNext(id: string) {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const current = this.document.cues[index]
      const next = this.document.cues[index + 1]
      if (!current || !next || current.locked || next.locked) return
      this.commit('merge', (cues) => {
        const item = cues[index]
        const following = cues[index + 1]
        item.end = following.end
        item.source = `${item.source} ${following.source}`.trim()
        item.target = `${item.target} ${following.target}`.trim()
        item.termIds = [...new Set([...item.termIds, ...following.termIds])]
        item.status = 'draft'
        cues.splice(index + 1, 1)
      }, id)
    },
    moveCue(id: string, direction: -1 | 1) {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= this.document.cues.length) return
      this.commit('move', (cues) => {
        const [item] = cues.splice(index, 1)
        cues.splice(target, 0, item)
      }, id)
    },
    deleteCue(id: string) {
      const cue = this.document.cues.find((item) => item.id === id)
      if (!cue || cue.locked) return
      this.commit('delete', (cues) => {
        const index = cues.findIndex((item) => item.id === id)
        if (index >= 0) cues.splice(index, 1)
      }, this.document.cues[Math.max(0, this.document.cues.findIndex((item) => item.id === id) - 1)]?.id ?? null)
    },
    createSnapshot(name: string) {
      const snapshot: Snapshot = { id: makeId('snapshot'), name: name.trim() || `v${this.document.snapshots.length + 1}`, createdAt: Date.now(), cues: cloneCues(this.document.cues) }
      this.document.snapshots.unshift(snapshot)
      this.markChanged('snapshot', true)
    },
    restoreSnapshot(id: string) {
      const snapshot = this.document.snapshots.find((item) => item.id === id)
      if (!snapshot) return
      this.past.push(this.revisionSnapshot())
      this.past[this.past.length - 1].label = 'restore-snapshot'
      this.future = []
      this.document.cues = cloneCues(snapshot.cues)
      this.selectedCueId = this.document.cues[0]?.id ?? null
      this.markChanged('restore-snapshot')
    },
    importText(text: string, filename: string) {
      const lower = filename.toLowerCase()
      const cues = lower.endsWith('.srt') ? parseSrt(text) : parseScript(text, this.document.actors)
      if (!cues.length) throw new Error('EMPTY_IMPORT')
      this.commit('import', (current) => {
        current.splice(0, current.length, ...cues)
      }, cues[0].id)
      return cues.length
    },
    exportSrt() {
      const blob = new Blob([toSrt(this.document.cues)], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${this.document.title || 'subtitle'}.srt`
      anchor.click()
      URL.revokeObjectURL(url)
    },
    /**
     * 套用片方修订包。按台词稳定编号（cueId）对账：
     * - 原文或时码改过的未锁定台词 → 套用片方新值、退回待校对、旧值并排保留；
     * - 锁定台词 → 照旧不动，片方新值暂挂并标出"原文已变"；
     * - 片方删除（包中不再出现该编号）→ 未锁定进译文存档，锁定保留并标"片方已删"；
     * - 包中出现台本没有的编号 → 新增台词（译文空、待校对）。
     * 解析失败：整包不生效，已应用的记录保留。重发同一批（包 ID 或内容 hash 命中）不重复套用。
     */
    applyRevisionPackage(text: string): RevisionResult {
      // 1. 先解析校验，任何失败都在写入前抛出，保证整包不生效
      const pkg: RevisionPackage = parseRevisionPackage(text)
      const contentHash = revisionContentHash(pkg)
      // 2. 幂等：同一包 ID，或换个 ID 但内容完全一致，都不重复套用
      if (this.document.appliedPackages.some((item) => item.packageId === pkg.packageId || item.contentHash === contentHash)) {
        throw new Error('REVISION_DUPLICATE')
      }

      const before = this.revisionSnapshot()
      before.label = 'apply-revision'
      const working = cloneCues(this.document.cues)
      const workingArchive = JSON.parse(JSON.stringify(this.document.archive)) as ArchivedCue[]
      const byId = new Map(working.map((cue) => [cue.id, cue]))
      const incomingIds = new Set(pkg.cues.map((cue) => cue.cueId))
      const stats = { changed: 0, added: 0, removed: 0, lockedPending: 0, unchanged: 0 }
      let firstChangedId: string | undefined
      const kept: Cue[] = []

      // 3. 按片方新版顺序逐条对账
      for (const incoming of pkg.cues) {
        const cue = byId.get(incoming.cueId)
        if (!cue) {
          // 台本中没有的编号：片方新增台词，译文侧字段留空待校对
          kept.push({
            id: incoming.cueId,
            start: incoming.start,
            end: incoming.end,
            source: incoming.source,
            target: '',
            actorId: this.document.actors[0]?.id ?? 'actor-narrator',
            speed: 1,
            termIds: [],
            status: 'draft',
            locked: false,
          })
          stats.added += 1
          continue
        }
        const sourceChanged = incoming.source !== cue.source
        const timeChanged = Math.abs(incoming.start - cue.start) > TIME_EPSILON || Math.abs(incoming.end - cue.end) > TIME_EPSILON
        // 锁定项已暂挂过新稿：包内容与暂挂一致也算未变
        if (cue.locked && cue.pendingSource !== undefined) {
          const sameAsPending = incoming.source === cue.pendingSource
            && Math.abs(incoming.start - (cue.pendingStart ?? cue.start)) <= TIME_EPSILON
            && Math.abs(incoming.end - (cue.pendingEnd ?? cue.end)) <= TIME_EPSILON
          if (sameAsPending) {
            stats.unchanged += 1
            kept.push(cue)
            continue
          }
        }
        if (!sourceChanged && !timeChanged) {
          // 片方在新版恢复了曾删除的台词：去掉"已删"标记
          if (cue.removedInRevision) {
            cue.removedInRevision = false
            cue.sourceChanged = false
          }
          stats.unchanged += 1
          kept.push(cue)
          continue
        }
        if (cue.locked) {
          // 锁定台词照旧不动：片方新值暂挂，标出原文已变
          cue.pendingSource = incoming.source
          cue.pendingStart = incoming.start
          cue.pendingEnd = incoming.end
          cue.sourceChanged = true
          cue.removedInRevision = false
          stats.lockedPending += 1
        } else {
          // 未锁定：片方字段覆盖（译文、语速、角色、术语、状态归译制台），退回待校对，旧值并排保留
          cue.oldSource = cue.source
          cue.oldStart = cue.start
          cue.oldEnd = cue.end
          cue.source = incoming.source
          cue.start = incoming.start
          cue.end = incoming.end
          cue.status = 'draft'
          cue.sourceChanged = true
          cue.removedInRevision = false
          delete cue.pendingSource
          delete cue.pendingStart
          delete cue.pendingEnd
          stats.changed += 1
        }
        firstChangedId ??= cue.id
        kept.push(cue)
      }

      // 4. 包中不再出现的现存台词：片方去掉。未锁定连译文进存档；锁定照旧留在末尾并标出
      working.forEach((cue) => {
        if (incomingIds.has(cue.id)) return
        const cueNumber = this.document.cues.findIndex((item) => item.id === cue.id) + 1
        if (cue.locked) {
          cue.removedInRevision = true
          cue.sourceChanged = true
          kept.push(cue)
        } else {
          workingArchive.push({
            id: makeId('archive'),
            cueNumber,
            cue: JSON.parse(JSON.stringify(cue)) as Cue,
            packageId: pkg.packageId,
            sourceVersion: pkg.sourceVersion,
            archivedAt: Date.now(),
          })
          stats.removed += 1
        }
      })

      // 5. 提交（撤销栈在写入前压入），记录已应用批次并推进原文字幕版本
      this.past.push(before)
      if (this.past.length > 60) this.past.shift()
      this.future = []
      this.document.cues = kept
      this.document.archive = workingArchive
      this.document.sourceVersion = pkg.sourceVersion
      const record: AppliedPackage = {
        packageId: pkg.packageId,
        sourceVersion: pkg.sourceVersion,
        contentHash,
        appliedAt: Date.now(),
        ...stats,
      }
      this.document.appliedPackages.unshift(record)
      this.selectedCueId = firstChangedId ?? kept[0]?.id ?? null
      this.markChanged('apply-revision')
      return { packageId: pkg.packageId, sourceVersion: pkg.sourceVersion, ...stats }
    },
    /** 锁定台词解锁后，手动采纳暂挂的片方新原文/新时码（同样退回待校对、旧值并排） */
    adoptPendingRevision(id: string) {
      const cue = this.document.cues.find((item) => item.id === id)
      if (!cue || cue.locked || cue.pendingSource === undefined) return
      this.commit('adopt-revision', (cues) => {
        const target = cues.find((item) => item.id === id)
        if (!target) return
        target.oldSource = target.source
        target.oldStart = target.start
        target.oldEnd = target.end
        target.source = cue.pendingSource as string
        target.start = cue.pendingStart as number
        target.end = cue.pendingEnd as number
        target.status = 'draft'
        target.sourceChanged = true
        target.removedInRevision = false
        delete target.pendingSource
        delete target.pendingStart
        delete target.pendingEnd
      }, id)
    },
    /** 下载与当前台本一致的修订包模板（按当前原文版本） */
    downloadRevisionTemplate() {
      const ordered = [...this.document.cues].sort((a, b) => a.start - b.start)
      const content = buildRevisionPackageJson(this.document.sourceVersion, ordered)
      const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `revision-package-template.json`
      anchor.click()
      URL.revokeObjectURL(url)
    },
  },
})
