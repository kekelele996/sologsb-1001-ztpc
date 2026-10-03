import { defineStore } from 'pinia'
import type { ArchivedCue, Cue, EditorDocument, HistoryEntry, Locale, RevisionStats, Snapshot } from '../types'
import { loadDocument, saveDocument } from '../utils/db'
import { makeId } from '../utils/id'
import { parseScript, parseSrt, toSrt } from '../utils/subtitle'
import {
  applyRevisionToCues, BASELINE_SOURCE_VERSION, buildRevisionPackage, migrateDocument,
  parseRevisionPackage, REVISION_DUPLICATE, REVISION_PARSE_ERROR, revisionContentHash,
} from '../utils/revision'
import { translate, type MessageKey } from '../i18n'

const DOCUMENT_ID = 'subtitle-dubbing-document'
let saveTimer: ReturnType<typeof setTimeout> | undefined
let channel: BroadcastChannel | undefined

const cloneCues = (cues: Cue[]): Cue[] => JSON.parse(JSON.stringify(cues)) as Cue[]
const plainDocument = (document: EditorDocument): EditorDocument => JSON.parse(JSON.stringify(document)) as EditorDocument

const createDefaultDocument = (): EditorDocument => ({
  id: DOCUMENT_ID,
  title: '纪录片《开源之路》中文配音',
  language: 'zh-CN',
  sourceVersion: BASELINE_SOURCE_VERSION,
  archivedCues: [],
  appliedRevisions: [],
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
    { id: 'cue-demo-01', lineNo: 1, start: 0, end: 4.2, source: '开源并不是一项孤立的技术，而是一种持续协作的方式。', target: '开源并不是一项孤立的技术，而是一种持续协作的方式。', actorId: 'actor-narrator', speed: 1.02, termIds: ['term-01'], status: 'reviewed', locked: true, sourceVersion: BASELINE_SOURCE_VERSION },
    { id: 'cue-demo-02', lineNo: 2, start: 4.3, end: 8.6, source: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', target: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', actorId: 'actor-host', speed: 1, termIds: ['term-04', 'term-02'], status: 'reviewed', locked: false, sourceVersion: BASELINE_SOURCE_VERSION },
    { id: 'cue-demo-03', lineNo: 3, start: 8.8, end: 13.5, source: '每个拉取请求背后，都有一段需要被理解的上下文。', target: '每个拉取请求背后，都有一段需要被理解的上下文。', actorId: 'actor-lin', speed: 0.96, termIds: ['term-03'], status: 'reviewed', locked: false, sourceVersion: BASELINE_SOURCE_VERSION },
    { id: 'cue-demo-04', lineNo: 4, start: 13.7, end: 18.8, source: '请您先介绍一次印象最深的代码评审。', target: '请您先介绍一次印象最深的代码评审。', actorId: 'actor-host', speed: 1.03, termIds: [], status: 'draft', locked: false, sourceVersion: BASELINE_SOURCE_VERSION },
    { id: 'cue-demo-05', lineNo: 5, start: 19, end: 25.1, source: '那次修改很小，却让新用户第一次能够顺利完成安装。', target: '那次修改很小，却让新用户第一次顺利完成安装。', actorId: 'actor-lin', speed: 0.98, termIds: [], status: 'issue', locked: false, sourceVersion: BASELINE_SOURCE_VERSION },
    { id: 'cue-demo-06', lineNo: 6, start: 25.4, end: 31.2, source: '所以我们决定把安装说明拆开，并为每个平台补上验证步骤。', target: '因此，我们拆分安装说明，并为每个平台补上验证步骤。', actorId: 'actor-chen', speed: 1.05, termIds: [], status: 'draft', locked: false, sourceVersion: BASELINE_SOURCE_VERSION },
  ],
  snapshots: [],
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
        // 旧稿没记原文字幕版本：升级后按当前版本回填
        if (migrateDocument(this.document, BASELINE_SOURCE_VERSION)) {
          this.persist('migrate-source-version').catch((error) => console.error('migrate', error))
        }
      } else {
        migrateDocument(this.document, BASELINE_SOURCE_VERSION)
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
    commit(label: string, mutate: (cues: Cue[]) => void, nextSelection?: string | null) {
      const before = cloneCues(this.document.cues)
      const working = cloneCues(this.document.cues)
      mutate(working)
      this.past.push({
        label,
        cues: before,
        selectedCueId: this.selectedCueId,
        sourceVersion: this.document.sourceVersion,
        archivedCues: cloneCues(this.document.archivedCues) as ArchivedCue[],
      })
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
      this.future.push({
        label: entry.label,
        cues: cloneCues(this.document.cues),
        selectedCueId: this.selectedCueId,
        sourceVersion: this.document.sourceVersion,
        archivedCues: cloneCues(this.document.archivedCues) as ArchivedCue[],
      })
      this.document.cues = this.normalizeCueVersions(cloneCues(entry.cues))
      this.selectedCueId = entry.selectedCueId
      if (entry.sourceVersion !== undefined) this.document.sourceVersion = entry.sourceVersion
      if (entry.archivedCues) this.document.archivedCues = cloneCues(entry.archivedCues) as ArchivedCue[]
      this.markChanged(`undo:${entry.label}`)
    },
    redo() {
      const entry = this.future.pop()
      if (!entry) return
      this.past.push({
        label: entry.label,
        cues: cloneCues(this.document.cues),
        selectedCueId: this.selectedCueId,
        sourceVersion: this.document.sourceVersion,
        archivedCues: cloneCues(this.document.archivedCues) as ArchivedCue[],
      })
      this.document.cues = this.normalizeCueVersions(cloneCues(entry.cues))
      this.selectedCueId = entry.selectedCueId
      if (entry.sourceVersion !== undefined) this.document.sourceVersion = entry.sourceVersion
      if (entry.archivedCues) this.document.archivedCues = cloneCues(entry.archivedCues) as ArchivedCue[]
      this.markChanged(`redo:${entry.label}`)
    },
    /** 老快照/撤销栈里的台词可能没有编号或原文字幕版本，按当前版本回填 */
    normalizeCueVersions(cues: Cue[]): Cue[] {
      cues.forEach((cue, index) => {
        if (cue.lineNo === undefined) cue.lineNo = index + 1
        if (!cue.sourceVersion) cue.sourceVersion = this.document.sourceVersion || BASELINE_SOURCE_VERSION
      })
      return cues
    },
    updateCue(id: string, patch: Partial<Cue>, historyLabel = 'update-cue') {
      this.commit(historyLabel, (cues) => {
        const cue = cues.find((item) => item.id === id)
        if (!cue || cue.locked) return
        Object.assign(cue, patch)
      })
    },
    markStatus(id: string, status: Cue['status']) {
      this.updateCue(id, { status }, `status:${status}`)
    },
    toggleLock(id: string) {
      this.updateCue(id, { locked: !this.document.cues.find((cue) => cue.id === id)?.locked }, 'toggle-lock')
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
          lineNo: null,
          start: middle,
          source: cue.source.slice(sourceMid).trim(),
          target: cue.target.slice(targetMid).trim(),
          status: 'draft',
          locked: false,
          sourceChanged: undefined,
          timingChanged: undefined,
          previousSource: undefined,
          previousStart: undefined,
          previousEnd: undefined,
          pendingSource: undefined,
          pendingStart: undefined,
          pendingEnd: undefined,
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
      this.past.push({
        label: 'restore-snapshot',
        cues: cloneCues(this.document.cues),
        selectedCueId: this.selectedCueId,
        sourceVersion: this.document.sourceVersion,
        archivedCues: cloneCues(this.document.archivedCues) as ArchivedCue[],
      })
      this.future = []
      this.document.cues = this.normalizeCueVersions(cloneCues(snapshot.cues))
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
      // 全新原文导入视为新的片方基线，旧的修订记录与存档不再参与对账
      this.document.sourceVersion = BASELINE_SOURCE_VERSION
      this.document.appliedRevisions = []
      this.document.archivedCues = []
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
     * 应用片方修订包。
     * - 解析失败：整包不生效，已应用的那次留着
     * - 同一批重发（编号或内容指纹相同）：不重复套用
     */
    applyRevisionText(text: string): { version: string; stats: RevisionStats } {
      const revision = parseRevisionPackage(text)
      const hash = revisionContentHash(revision)
      const already = this.document.appliedRevisions.some(
        (entry) => entry.packageId === revision.packageId || entry.contentHash === hash,
      )
      if (already) throw new Error(REVISION_DUPLICATE)

      // 先在拷贝上完成对账，任何异常都不会触碰当前稿，保证整包原子生效
      const result = applyRevisionToCues(
        cloneCues(this.document.cues),
        cloneCues(this.document.archivedCues) as ArchivedCue[],
        revision,
        this.document.actors[0]?.id ?? 'actor-narrator',
      )

      this.past.push({
        label: `revision:${revision.version}`,
        cues: cloneCues(this.document.cues),
        selectedCueId: this.selectedCueId,
        sourceVersion: this.document.sourceVersion,
        archivedCues: cloneCues(this.document.archivedCues) as ArchivedCue[],
      })
      if (this.past.length > 60) this.past.shift()
      this.future = []
      this.document.cues = result.cues
      this.document.archivedCues = result.archived
      this.document.sourceVersion = revision.version
      this.document.appliedRevisions.unshift({
        packageId: revision.packageId,
        version: revision.version,
        appliedAt: Date.now(),
        contentHash: hash,
        changed: result.stats.changed,
        added: result.stats.added,
        removed: result.stats.removed,
      })
      this.selectedCueId = result.cues.find((cue) => cue.sourceChanged || cue.timingChanged)?.id ?? this.selectedCueId
      this.markChanged('apply-revision')
      return { version: revision.version, stats: result.stats }
    },
    /** 导出当前活动稿原文为修订包格式 */
    exportRevisionTemplate(version: string) {
      const revision = buildRevisionPackage(this.document.cues, version.trim() || this.document.sourceVersion)
      const blob = new Blob([JSON.stringify(revision, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `source-${revision.version}.json`
      anchor.click()
      URL.revokeObjectURL(url)
    },
    /** 校对完成，收起新旧原文并列标记 */
    dismissCueRevision(id: string) {
      this.commit('dismiss-revision', (cues) => {
        const cue = cues.find((item) => item.id === id)
        if (!cue || cue.locked) return
        cue.sourceChanged = undefined
        cue.timingChanged = undefined
        cue.previousSource = undefined
        cue.previousStart = undefined
        cue.previousEnd = undefined
        cue.pendingSource = undefined
        cue.pendingStart = undefined
        cue.pendingEnd = undefined
      })
    },
    /** 锁定台词解锁后，采用片方挂起的新原文/时码 */
    adoptPendingSource(id: string) {
      this.commit('adopt-pending', (cues) => {
        const cue = cues.find((item) => item.id === id)
        if (!cue || cue.locked || cue.pendingSource === undefined) return
        cue.source = cue.pendingSource
        if (cue.pendingStart !== undefined && cue.pendingEnd !== undefined) {
          cue.start = cue.pendingStart
          cue.end = cue.pendingEnd
        }
        cue.pendingSource = undefined
        cue.pendingStart = undefined
        cue.pendingEnd = undefined
        cue.status = 'draft'
      })
    },
    /** 从存档恢复片方去掉的台词（译文随之找回） */
    restoreArchived(archiveId: string) {
      const archived = this.document.archivedCues.find((item) => item.id === archiveId)
      if (!archived) throw new Error('ARCHIVE_NOT_FOUND')
      const lineTaken = archived.lineNo !== null
        && this.document.cues.some((cue) => cue.lineNo === archived.lineNo)
      if (lineTaken) throw new Error('LINE_NO_TAKEN')
      const restored: Cue = { ...archived, archivedAt: undefined }
      delete (restored as Partial<ArchivedCue>).removedByPackageId
      delete (restored as Partial<ArchivedCue>).removedAt
      delete (restored as Partial<ArchivedCue>).restored
      this.commit('restore-archived', (cues) => {
        if (restored.lineNo === null) cues.push(restored)
        else {
          const index = cues.findIndex((cue) => cue.lineNo !== null && (cue.lineNo as number) > (restored.lineNo as number))
          index >= 0 ? cues.splice(index, 0, restored) : cues.push(restored)
        }
      }, restored.id)
      const index = this.document.archivedCues.findIndex((item) => item.id === archiveId)
      if (index >= 0) {
        this.document.archivedCues[index].restored = true
        this.markChanged('restore-archived')
      }
    },
    /** 彻底删除存档中的译文 */
    deleteArchived(archiveId: string) {
      const index = this.document.archivedCues.findIndex((item) => item.id === archiveId)
      if (index < 0) return
      this.document.archivedCues.splice(index, 1)
      this.markChanged('delete-archived')
    },
  },
})
