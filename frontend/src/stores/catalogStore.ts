/**
 * 名录室 store：维护分类名录条目、属名修订条目与修订版本号。
 * 名录室只动本侧两张表（taxa / revisions）；外业珊瑚记录照旧，
 * 覆盖率与白化指数在汇总时按本名录的定名归并（见 utils/catalog.ts）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { GenusRevision, RevisionStatus, TaxonEntry } from '@/types/catalog'
import type { CoralRecord } from '@/types/coralRecord'
import {
  buildGenusResolver,
  collectFieldGenera,
  reconcileGenera,
  type GenusResolver,
  type Reconciliation
} from '@/utils/catalog'

/** 名录页筛选条件 */
export interface CatalogFilterState {
  keyword: string
  revisionStatuses: RevisionStatus[]
}

export function createEmptyCatalogFilter(): CatalogFilterState {
  return { keyword: '', revisionStatuses: [] }
}

/** 发布修订的返回结果 */
export interface PublishResult {
  version: number
  resolved: number
  failed: number
}

export const useCatalogStore = defineStore('catalog', () => {
  const taxa = ref<TaxonEntry[]>([])
  const revisions = ref<GenusRevision[]>([])
  /** 外业珊瑚记录（只读）：对账与定名归并要用，名录室不写这一侧 */
  const corals = ref<CoralRecord[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<CatalogFilterState>(createEmptyCatalogFilter())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<TaxonEntry>(() => db.taxa).subscribe((rows) => {
      taxa.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<GenusRevision>(() => db.revisions).subscribe((rows) => {
      revisions.value = rows
    })
    watchTable<CoralRecord>(() => db.corals).subscribe((rows) => {
      corals.value = rows
    })
  }

  /** 当前修订版本号：已发布修订条目中的最大版本号 */
  const currentRevisionVersion = computed<number>(() =>
    revisions.value.reduce((max, revision) => Math.max(max, revision.revisionVersion), 0)
  )

  /** 定名器：汇总与导出共用同一口径（utils/catalog.ts） */
  const resolver = computed<GenusResolver>(() => buildGenusResolver(taxa.value, revisions.value))

  function resolveGenus(fieldGenus: string) {
    return resolver.value(fieldGenus)
  }

  /** 外业记录中出现的全部属名 */
  const fieldGenera = computed<string[]>(() => collectFieldGenera(corals.value))

  /** 两边对账：对不上的列出来等名录室处理 */
  const reconciliation = computed<Reconciliation>(() =>
    reconcileGenera(fieldGenera.value, taxa.value, revisions.value)
  )

  const pendingRevisions = computed<GenusRevision[]>(() =>
    revisions.value.filter((revision) => revision.status === 'pending')
  )

  const failedRevisions = computed<GenusRevision[]>(() =>
    revisions.value.filter((revision) => revision.status === 'failed')
  )

  /** 待名录室处理的总数（导航徽标用）：待修订 + 发布失败 + 对不上 */
  const todoCount = computed<number>(
    () => pendingRevisions.value.length + failedRevisions.value.length + reconciliation.value.unmatchedGenera.length
  )

  /** 按筛选条件过滤后的修订条目（新的在前） */
  const filteredRevisions = computed<GenusRevision[]>(() =>
    revisions.value
      .filter((revision) => {
        const keyword = filter.value.keyword.trim()
        if (keyword.length > 0) {
          const haystack = `${revision.fieldGenus}${revision.acceptedGenus}${revision.note}`
          if (!haystack.includes(keyword)) return false
        }
        if (filter.value.revisionStatuses.length > 0 && !filter.value.revisionStatuses.includes(revision.status)) {
          return false
        }
        return true
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )

  /** 按筛选条件过滤后的名录条目（有效在前、按属名排序） */
  const filteredTaxa = computed<TaxonEntry[]>(() =>
    taxa.value
      .filter((taxon) => {
        const keyword = filter.value.keyword.trim()
        if (keyword.length > 0) {
          const haystack = `${taxon.genus}${taxon.latinName}${taxon.note}`
          if (!haystack.includes(keyword)) return false
        }
        return true
      })
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === '有效' ? -1 : 1
        return a.genus.localeCompare(b.genus, 'zh-Hans-CN')
      })
  )

  /** 有效名录属名（定名下拉用） */
  const acceptedGenera = computed<string[]>(() =>
    taxa.value
      .filter((taxon) => taxon.status === '有效')
      .map((taxon) => taxon.genus)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  )

  function patchFilter(patch: Partial<CatalogFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyCatalogFilter()
  }

  /* ------------------------------ 名录条目 ------------------------------ */

  async function createTaxon(payload: Omit<TaxonEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<TaxonEntry> {
    const genus = payload.genus.trim()
    if (taxa.value.some((taxon) => taxon.genus === genus)) {
      throw new Error(`名录中已存在属名「${genus}」`)
    }
    const now = Date.now()
    const row: TaxonEntry = { ...payload, genus, id: createId('tax'), createdAt: now, updatedAt: now }
    await db.taxa.put(row)
    return row
  }

  async function updateTaxon(id: string, patch: Partial<TaxonEntry>): Promise<void> {
    await db.taxa.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /** 删除名录条目：有已定名修订指向该属名时拒绝，避免定名悬空 */
  async function removeTaxon(id: string): Promise<void> {
    const taxon = taxa.value.find((item) => item.id === id)
    if (!taxon) return
    const referenced = revisions.value.some(
      (revision) => revision.status === 'resolved' && revision.acceptedGenus.trim() === taxon.genus.trim()
    )
    if (referenced) {
      throw new Error(`「${taxon.genus}」已被已定名的修订条目引用，请先处理修订条目`)
    }
    await db.taxa.delete(id)
  }

  /* ------------------------------ 修订条目 ------------------------------ */

  /** 为外业属名挂一条待修订（已存在同名条目则跳过），返回新挂条数 */
  async function attachPendingRevisions(genera: string[], note = '对账挂起：待名录室定名'): Promise<number> {
    const known = new Set(revisions.value.map((revision) => revision.fieldGenus.trim()))
    const missing = genera.map((genus) => genus.trim()).filter((genus) => genus.length > 0 && !known.has(genus))
    if (missing.length === 0) return 0
    const now = Date.now()
    const rows: GenusRevision[] = missing.map((fieldGenus, index) => ({
      id: createId('rev'),
      fieldGenus,
      acceptedGenus: '',
      status: 'pending',
      revisionVersion: 0,
      note,
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.revisions.bulkPut(rows)
    return rows.length
  }

  /** 名录室填写名录定名（发布前可反复修改） */
  async function updateRevision(id: string, patch: Partial<GenusRevision>): Promise<void> {
    await db.revisions.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeRevision(id: string): Promise<void> {
    await db.revisions.delete(id)
  }

  /**
   * 名录室发布修订：只动本侧修订条目，外业录的珊瑚记录照旧。
   * 逐条校验名录定名：为空或不在有效名录里 → 标发布失败，等名录室修正后重试；
   * 校验通过 → 已定名并写入新修订版本号（当前版本 + 1，本批共用一个版本号）。
   */
  async function publishRevisions(ids: string[]): Promise<PublishResult> {
    const version = currentRevisionVersion.value + 1
    const accepted = new Set(
      taxa.value.filter((taxon) => taxon.status === '有效').map((taxon) => taxon.genus.trim())
    )
    const now = Date.now()
    let resolved = 0
    let failed = 0
    await db.transaction('rw', [db.revisions], async () => {
      for (const id of ids) {
        const revision = await db.revisions.get(id)
        if (!revision || revision.status === 'resolved') continue
        const target = revision.acceptedGenus.trim()
        if (target.length === 0) {
          failed += 1
          await db.revisions.update(id, {
            status: 'failed',
            note: appendNote(revision.note, `第 ${version} 版发布失败：名录定名为空`),
            updatedAt: now
          } as never)
          continue
        }
        if (!accepted.has(target)) {
          failed += 1
          await db.revisions.update(id, {
            status: 'failed',
            note: appendNote(revision.note, `第 ${version} 版发布失败：「${target}」不在有效名录中`),
            updatedAt: now
          } as never)
          continue
        }
        resolved += 1
        await db.revisions.update(id, {
          status: 'resolved',
          acceptedGenus: target,
          revisionVersion: version,
          updatedAt: now
        } as never)
      }
    })
    return { version, resolved, failed }
  }

  /** 发布全部待修订条目 */
  async function publishAllPending(): Promise<PublishResult> {
    return publishRevisions(pendingRevisions.value.map((revision) => revision.id))
  }

  /** 发布失败后只重试本侧失败条目，外业录的照旧 */
  async function retryFailed(): Promise<PublishResult> {
    return publishRevisions(failedRevisions.value.map((revision) => revision.id))
  }

  return {
    taxa,
    revisions,
    corals,
    ready,
    error,
    filter,
    currentRevisionVersion,
    resolver,
    fieldGenera,
    reconciliation,
    pendingRevisions,
    failedRevisions,
    todoCount,
    filteredRevisions,
    filteredTaxa,
    acceptedGenera,
    start,
    resolveGenus,
    patchFilter,
    resetFilter,
    createTaxon,
    updateTaxon,
    removeTaxon,
    attachPendingRevisions,
    updateRevision,
    removeRevision,
    publishRevisions,
    publishAllPending,
    retryFailed
  }
})

/** 在修订说明后追加一行处理记录（去重） */
function appendNote(note: string, line: string): string {
  const base = note.trim()
  if (base.includes(line)) return base
  return base.length > 0 ? `${base}；${line}` : line
}
