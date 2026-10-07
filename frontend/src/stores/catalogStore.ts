/**
 * 名录室 store：维护分类名录、属名修订条目与修订版本号。
 * 与外业普查组分侧——本 store 只写名录侧三表（taxa / revisions / catalogMeta），
 * 对外业 corals 表只读（对账用），绝不回写：外业录的原始属名照旧保留。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, ensurePendingRevisions, watchTable } from '@/utils/db'
import type { CatalogMeta, GenusRevision, ReconcileRow, RevisionKind, TaxonEntry, TaxonStatus } from '@/types/catalog'
import { CATALOG_META_ID } from '@/types/catalog'
import { buildGenusResolver, type GenusResolver } from '@/utils/taxonomy'

export const useCatalogStore = defineStore('catalog', () => {
  const taxa = ref<TaxonEntry[]>([])
  const revisions = ref<GenusRevision[]>([])
  const meta = ref<CatalogMeta | null>(null)
  const ready = ref(false)
  const error = ref<string | null>(null)

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
    watchTable<CatalogMeta>(() => db.catalogMeta).subscribe((rows) => {
      meta.value = rows.find((row) => row.id === CATALOG_META_ID) ?? rows[0] ?? null
    })
  }

  /** 名录修订版本号（未初始化时为 0） */
  const version = computed<number>(() => meta.value?.version ?? 0)

  /** 定名解析器：页面汇总与导出走同一口径（utils/taxonomy.ts） */
  const resolver = computed<GenusResolver>(() => buildGenusResolver(revisions.value, taxa.value))

  function resolveGenus(genus: string): ReturnType<GenusResolver> {
    return resolver.value(genus)
  }

  /** 待处理修订条目（待修订 + 发布失败），按创建时间升序 */
  const openRevisions = computed<GenusRevision[]>(() =>
    revisions.value
      .filter((revision) => revision.status !== '已发布')
      .sort((a, b) => a.createdAt - b.createdAt)
  )

  /* ------------------------------- 对账 ------------------------------- */

  /**
   * 两边对账：外业 corals 的属名集合 vs 名录条目与修订条目。
   * 对不上的（未挂账）列出来等名录室处理；待修订的已挂账但未定名。
   */
  async function reconcile(): Promise<ReconcileRow[]> {
    const corals = await db.corals.toArray()
    const counts = new Map<string, number>()
    corals.forEach((coral) => {
      const name = coral.genus.trim()
      counts.set(name, (counts.get(name) ?? 0) + 1)
    })
    const resolve = resolver.value
    return Array.from(counts.entries())
      .map(([genus, recordCount]) => {
        const revision =
          revisions.value.find((item) => item.fromGenus.trim() === genus && item.status !== '已发布') ??
          revisions.value.find((item) => item.fromGenus.trim() === genus) ??
          null
        const resolution = resolve(genus)
        const state: ReconcileRow['state'] = resolution.cataloged ? '已定名' : revision ? '待修订' : '未挂账'
        return { genus, recordCount, state, resolvedGenus: resolution.genus, revision }
      })
      .sort((a, b) => {
        const order: Record<ReconcileRow['state'], number> = { 未挂账: 0, 待修订: 1, 已定名: 2 }
        const diff = order[a.state] - order[b.state]
        if (diff !== 0) return diff
        return b.recordCount - a.recordCount
      })
  }

  /** 一键挂账：把对不上的外业属名各挂一条「待修订」（幂等，与升级迁移共用 ensurePendingRevisions） */
  async function ensurePending(): Promise<number> {
    return ensurePendingRevisions()
  }

  /* ------------------------------ 名录条目 ------------------------------ */

  async function createTaxon(payload: { acceptedGenus: string; status: TaxonStatus; note: string }): Promise<TaxonEntry> {
    const now = Date.now()
    const row: TaxonEntry = {
      id: createId('tax'),
      acceptedGenus: payload.acceptedGenus.trim(),
      status: payload.status,
      sinceVersion: version.value,
      note: payload.note.trim(),
      createdAt: now,
      updatedAt: now
    }
    await db.taxa.put(row)
    return row
  }

  async function updateTaxon(id: string, patch: Partial<TaxonEntry>): Promise<void> {
    await db.taxa.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeTaxon(id: string): Promise<void> {
    await db.taxa.delete(id)
  }

  /* ------------------------------ 修订条目 ------------------------------ */

  async function createRevision(payload: {
    fromGenus: string
    toGenus: string | null
    kind: RevisionKind
  }): Promise<GenusRevision> {
    const now = Date.now()
    const row: GenusRevision = {
      id: createId('rev'),
      fromGenus: payload.fromGenus.trim(),
      toGenus: payload.toGenus?.trim() ? payload.toGenus.trim() : null,
      kind: payload.kind,
      status: '待修订',
      version: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now
    }
    await db.revisions.put(row)
    return row
  }

  /** 编辑修订条目：仅待修订 / 发布失败可改（已发布的进入名录历史，不再回改） */
  async function updateRevision(
    id: string,
    patch: Partial<Pick<GenusRevision, 'toGenus' | 'kind'>>
  ): Promise<void> {
    const target = revisions.value.find((item) => item.id === id)
    if (!target || target.status === '已发布') return
    await db.revisions.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /** 删除修订条目：仅待修订可删 */
  async function removeRevision(id: string): Promise<void> {
    const target = revisions.value.find((item) => item.id === id)
    if (!target || target.status !== '待修订') return
    await db.revisions.delete(id)
  }

  /**
   * 发布修订：名录侧单事务（taxa + revisions + catalogMeta），
   * 成功则版本号 +1、修订条目记为已发布、定名写入名录；
   * 失败只把本侧修订条目标记为「发布失败」并记录原因——外业 corals 表不参与事务，录的照旧。
   */
  async function publishRevision(id: string): Promise<{ ok: boolean; message: string }> {
    const target = revisions.value.find((item) => item.id === id)
    if (!target) return { ok: false, message: '修订条目不存在' }
    if (target.status === '已发布') return { ok: false, message: '该修订已发布，无需重复发布' }
    const toGenus = target.toGenus?.trim() ?? ''
    if (toGenus.length === 0) {
      const message = '尚未填写修订后定名，无法发布'
      await markPublishFailed(id, message)
      return { ok: false, message }
    }
    if (toGenus === target.fromGenus.trim()) {
      const message = '修订后定名与原属名相同，无需发布'
      await markPublishFailed(id, message)
      return { ok: false, message }
    }
    let publishedVersion = 0
    try {
      await db.transaction('rw', [db.taxa, db.revisions, db.catalogMeta], async () => {
        const now = Date.now()
        const current = await db.catalogMeta.get(CATALOG_META_ID)
        const nextVersion = (current?.version ?? 0) + 1
        publishedVersion = nextVersion
        // 定名写入名录（已存在则刷新时间，保留原引入版本）
        const existing = await db.taxa.where('acceptedGenus').equals(toGenus).first()
        if (existing) {
          await db.taxa.update(existing.id, { status: '有效', updatedAt: now } as never)
        } else {
          await db.taxa.put({
            id: createId('tax'),
            acceptedGenus: toGenus,
            status: '有效',
            sinceVersion: nextVersion,
            note: `由「${target.fromGenus}」${target.kind}修订发布`,
            createdAt: now,
            updatedAt: now
          })
        }
        // 原名若本身是有效名，拆分合并后降为异名
        const fromTaxon = await db.taxa.where('acceptedGenus').equals(target.fromGenus.trim()).first()
        if (fromTaxon && fromTaxon.status === '有效') {
          await db.taxa.update(fromTaxon.id, { status: '异名', updatedAt: now } as never)
        }
        await db.revisions.update(id, {
          status: '已发布',
          version: nextVersion,
          failureReason: null,
          updatedAt: now
        } as never)
        await db.catalogMeta.put({ id: CATALOG_META_ID, version: nextVersion, updatedAt: now })
      })
      return { ok: true, message: `「${target.fromGenus}」已定名为「${toGenus}」，名录版本升至 v${publishedVersion}` }
    } catch (err) {
      const message = `发布失败：${err instanceof Error ? err.message : String(err)}`
      await markPublishFailed(id, message)
      return { ok: false, message }
    }
  }

  /** 发布失败后只重试本侧：重跑名录侧发布事务，外业记录不动 */
  async function retryPublish(id: string): Promise<{ ok: boolean; message: string }> {
    const target = revisions.value.find((item) => item.id === id)
    if (!target) return { ok: false, message: '修订条目不存在' }
    if (target.status !== '发布失败') return { ok: false, message: '仅发布失败的条目可以重试' }
    return publishRevision(id)
  }

  /** 本侧失败标记：仅更新修订条目本身，不触碰其他任何表 */
  async function markPublishFailed(id: string, reason: string): Promise<void> {
    try {
      await db.revisions.update(id, { status: '发布失败', failureReason: reason, updatedAt: Date.now() } as never)
    } catch {
      // 标记本身失败时静默：对账页仍能看到该条目处于未发布状态
    }
  }

  return {
    taxa,
    revisions,
    meta,
    ready,
    error,
    version,
    resolver,
    openRevisions,
    start,
    resolveGenus,
    reconcile,
    ensurePending,
    createTaxon,
    updateTaxon,
    removeTaxon,
    createRevision,
    updateRevision,
    removeRevision,
    publishRevision,
    retryPublish
  }
})
