/**
 * 属名定名解析：名录室与外业之间的唯一归并口径。
 * 页面汇总（useCoverage / 珊瑚计数页）与 JSON 导出（utils/export.ts）
 * 必须使用本模块的同一个 resolver，保证两边归并结果一致。
 *
 * 口径（名录还没改到的属名）：照常按外业原名计入覆盖率与白化指数，
 * 并标记 cataloged = false（待定名），不挂着等名录室定名。
 */
import type { GenusRevision, TaxonEntry } from '@/types/catalog'
import { round } from '@/utils/bleach'

/** 单个属名的解析结果 */
export interface GenusResolution {
  /** 归并用名：已发布修订的定名；未改到的用外业原名 */
  genus: string
  /** 是否经名录定名（false = 待定名，按外业原名计入并标记） */
  cataloged: boolean
}

export type GenusResolver = (genus: string) => GenusResolution

/**
 * 由修订条目与名录条目构建属名解析器。
 * 优先级：已发布修订的定名 > 名录有效名本身 > 外业原名（待定名）。
 * 待修订 / 发布失败的条目不参与归并。
 */
export function buildGenusResolver(revisions: GenusRevision[], taxa: TaxonEntry[]): GenusResolver {
  const published = new Map<string, string>()
  revisions.forEach((revision) => {
    if (revision.status === '已发布' && revision.toGenus) {
      published.set(revision.fromGenus.trim(), revision.toGenus.trim())
    }
  })
  const accepted = new Set(
    taxa.filter((taxon) => taxon.status === '有效').map((taxon) => taxon.acceptedGenus.trim())
  )
  return (genus: string): GenusResolution => {
    const name = genus.trim()
    const mapped = published.get(name)
    if (mapped) return { genus: mapped, cataloged: true }
    if (accepted.has(name)) return { genus: name, cataloged: true }
    return { genus: name, cataloged: false }
  }
}

/** 按定名归并后的一组 */
export interface ResolvedGenusGroup {
  /** 归并用名（定名或外业原名） */
  genus: string
  /** 覆盖长度合计（cm） */
  coverCm: number
  /** 是否经名录定名 */
  cataloged: boolean
  /** 归并进来的外业原名（含定名本身；多于一个说明发生过拆分合并归并） */
  fromGenera: string[]
}

/**
 * 按名录定名归并覆盖长度：同一批外业记录先逐条解析定名，再按定名分组累计。
 * 名录未改到的属名按外业原名自成一组并标记 cataloged = false。
 */
export function groupByResolvedGenus(
  records: Array<{ genus: string; coverCm: number }>,
  resolve: GenusResolver
): ResolvedGenusGroup[] {
  const map = new Map<string, { coverCm: number; cataloged: boolean; fromGenera: Set<string> }>()
  records.forEach((record) => {
    const resolution = resolve(record.genus)
    const bucket = map.get(resolution.genus) ?? {
      coverCm: 0,
      cataloged: resolution.cataloged,
      fromGenera: new Set<string>()
    }
    bucket.coverCm += Math.max(0, record.coverCm)
    // 同一归并组内只要有一条记录未走名录定名，整组视为待定名
    bucket.cataloged = bucket.cataloged && resolution.cataloged
    bucket.fromGenera.add(record.genus.trim())
    map.set(resolution.genus, bucket)
  })
  return Array.from(map.entries())
    .map(([genus, bucket]) => ({
      genus,
      coverCm: round(bucket.coverCm, 1),
      cataloged: bucket.cataloged,
      fromGenera: Array.from(bucket.fromGenera).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    }))
    .sort((a, b) => b.coverCm - a.coverCm)
}

/**
 * 计算需要补挂「待修订」的外业属名：
 * 既不是名录条目（任意状态）、也没有任何修订条目（任意状态）覆盖的属名。
 * 旧数据升级与对账页「一键挂账」共用，保证每个属名最多挂一条。
 */
export function planPendingRevisionGenera(
  fieldGenera: string[],
  revisions: GenusRevision[],
  taxa: TaxonEntry[]
): string[] {
  const known = new Set<string>()
  revisions.forEach((revision) => known.add(revision.fromGenus.trim()))
  taxa.forEach((taxon) => known.add(taxon.acceptedGenus.trim()))
  const missing = new Set<string>()
  fieldGenera.forEach((genus) => {
    const name = genus.trim()
    if (name.length > 0 && !known.has(name)) missing.add(name)
  })
  return Array.from(missing).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}
