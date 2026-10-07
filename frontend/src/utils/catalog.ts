/**
 * 名录定名归并（唯一口径）：汇总（store / hook / 页面）与导出（utils/export.ts）
 * 共用本文件的归并函数，保证两边按同一名录定名统计覆盖率与白化指数。
 *
 * 口径约定：名录还没改到的属名，先按外业名字照常计入，并标记「待定名」；
 * 名录室发布修订后，同一外业属名自动归并到名录定名，外业原始记录不改动。
 */
import { db, createId } from '@/utils/db'
import type { GenusRevision, TaxonEntry } from '@/types/catalog'
import { round } from '@/utils/bleach'

/** 单个外业属名的定名结果 */
export interface GenusResolution {
  /** 归并后用于汇总与导出的属名 */
  name: string
  /** 名录还没改到：按外业名字照常计入并标出 */
  pending: boolean
  /** 定名来源：修订条目 / 名录直接命中 / 外业原名（待定） */
  source: 'revision' | 'catalog' | 'field'
  /** 命中修订条目的版本号（未命中为 0） */
  revisionVersion: number
}

export type GenusResolver = (fieldGenus: string) => GenusResolution

/**
 * 由名录条目与修订条目构造定名器：
 * 1. 命中已定名的修订条目 → 用名录定名归并；
 * 2. 否则属名本身是有效名录条目 → 直接采用；
 * 3. 否则按外业名字照常计入，标记待定名。
 */
export function buildGenusResolver(taxa: TaxonEntry[], revisions: GenusRevision[]): GenusResolver {
  const accepted = new Set<string>()
  taxa.forEach((taxon) => {
    if (taxon.status === '有效') accepted.add(taxon.genus.trim())
  })
  // 同一外业属名可能有多条历史修订，取版本号最高的已定名条目
  const resolved = new Map<string, GenusRevision>()
  revisions.forEach((revision) => {
    if (revision.status !== 'resolved' || revision.acceptedGenus.trim().length === 0) return
    const key = revision.fieldGenus.trim()
    const current = resolved.get(key)
    if (!current || revision.revisionVersion >= current.revisionVersion) resolved.set(key, revision)
  })
  return (fieldGenus: string): GenusResolution => {
    const genus = fieldGenus.trim()
    const revision = resolved.get(genus)
    if (revision) {
      return {
        name: revision.acceptedGenus.trim(),
        pending: false,
        source: 'revision',
        revisionVersion: revision.revisionVersion
      }
    }
    if (accepted.has(genus)) {
      return { name: genus, pending: false, source: 'catalog', revisionVersion: 0 }
    }
    return { name: genus, pending: true, source: 'field', revisionVersion: 0 }
  }
}

/** 按名录定名归并后的属名分组 */
export interface ResolvedGenusGroup {
  /** 归并后的名录定名（待定名时为外业原名） */
  genus: string
  /** 被归并进来的外业属名 */
  fieldGenera: string[]
  /** 名录还没改到，照常计入并标出 */
  pending: boolean
  coverCm: number
}

/** 按名录定名分组汇总覆盖长度（汇总与导出共用） */
export function groupByResolvedGenus(
  records: Array<{ genus: string; coverCm: number }>,
  resolve: GenusResolver
): ResolvedGenusGroup[] {
  const map = new Map<string, { fieldGenera: Set<string>; pending: boolean; coverCm: number }>()
  records.forEach((record) => {
    const resolution = resolve(record.genus)
    const bucket = map.get(resolution.name) ?? { fieldGenera: new Set<string>(), pending: resolution.pending, coverCm: 0 }
    bucket.fieldGenera.add(record.genus.trim())
    bucket.coverCm += record.coverCm
    map.set(resolution.name, bucket)
  })
  return Array.from(map.entries())
    .map(([genus, bucket]) => ({
      genus,
      fieldGenera: Array.from(bucket.fieldGenera).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
      pending: bucket.pending,
      coverCm: round(bucket.coverCm, 1)
    }))
    .sort((a, b) => b.coverCm - a.coverCm)
}

/** 外业记录中出现的全部属名（去重、按中文排序） */
export function collectFieldGenera(records: Array<{ genus: string }>): string[] {
  const set = new Set<string>()
  records.forEach((record) => {
    const genus = record.genus.trim()
    if (genus.length > 0) set.add(genus)
  })
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/** 两边对账结果：外业属名 × 名录条目 × 修订条目 */
export interface Reconciliation {
  /** 外业有记录，但名录与修订条目都对不上 → 列出来等名录室处理 */
  unmatchedGenera: string[]
  /** 修订条目指向的外业属名已不在外业记录中（外业侧已删改） */
  staleRevisions: GenusRevision[]
  /** 已定名，但定名不在有效名录里（名录侧缺条目） */
  danglingRevisions: GenusRevision[]
}

/** 按属名跟修订条目对账，对不上的列出来等名录室处理 */
export function reconcileGenera(
  fieldGenera: string[],
  taxa: TaxonEntry[],
  revisions: GenusRevision[]
): Reconciliation {
  const fieldSet = new Set(fieldGenera)
  const accepted = new Set(taxa.filter((taxon) => taxon.status === '有效').map((taxon) => taxon.genus.trim()))
  const revisedNames = new Set(revisions.map((revision) => revision.fieldGenus.trim()))
  const unmatchedGenera = fieldGenera.filter((genus) => !accepted.has(genus) && !revisedNames.has(genus))
  const staleRevisions = revisions.filter((revision) => !fieldSet.has(revision.fieldGenus.trim()))
  const danglingRevisions = revisions.filter(
    (revision) =>
      revision.status === 'resolved' &&
      revision.acceptedGenus.trim().length > 0 &&
      !accepted.has(revision.acceptedGenus.trim())
  )
  return { unmatchedGenera, staleRevisions, danglingRevisions }
}

/**
 * 为还没有修订条目、也不在有效名录里的外业属名各挂一条待修订。
 * 用于导入旧备份（没有名录版本的数据）后补齐对账队列；返回新挂条数。
 */
export async function ensurePendingRevisions(note: string): Promise<number> {
  const [corals, taxa, revisions] = await Promise.all([db.corals.toArray(), db.taxa.toArray(), db.revisions.toArray()])
  const accepted = new Set(taxa.filter((taxon) => taxon.status === '有效').map((taxon) => taxon.genus.trim()))
  const known = new Set(revisions.map((revision) => revision.fieldGenus.trim()))
  const missing = collectFieldGenera(corals).filter((genus) => !accepted.has(genus) && !known.has(genus))
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
