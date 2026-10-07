/**
 * 分类名录模型（名录室）：名录条目、属名修订条目与修订版本号。
 * 名录室独立维护本文件定义的两侧数据；外业普查组只录样带与珊瑚记录，
 * 覆盖率与白化指数在汇总时按本名录的定名归并。
 */

/** 名录条目状态：有效 = 现行可定名；异名 = 被拆分合并掉的旧名，仅留档 */
export type TaxonStatus = '有效' | '异名'

export const TAXON_STATUSES: TaxonStatus[] = ['有效', '异名']

/** 分类名录条目：名录室维护的标准属名 */
export interface TaxonEntry {
  id: string
  /** 名录属名（标准名），如 鹿角珊瑚属 */
  genus: string
  /** 拉丁学名（可空） */
  latinName: string
  /** 状态：有效 / 异名 */
  status: TaxonStatus
  /** 备注（拆分合并依据、来源文献等） */
  note: string
  createdAt: number
  updatedAt: number
}

/** 属名修订条目状态 */
export type RevisionStatus = 'pending' | 'resolved' | 'failed'

export const REVISION_STATUSES: RevisionStatus[] = ['pending', 'resolved', 'failed']

export const REVISION_STATUS_LABEL: Record<RevisionStatus, string> = {
  pending: '待修订',
  resolved: '已定名',
  failed: '发布失败'
}

/** 属名修订条目：外业属名 → 名录定名 的一次修订记录 */
export interface GenusRevision {
  id: string
  /** 外业记录属名（原名） */
  fieldGenus: string
  /** 名录定名（空串 = 名录室尚未定名） */
  acceptedGenus: string
  /** 状态：待修订 / 已定名 / 发布失败 */
  status: RevisionStatus
  /** 发布成功的修订版本号；未发布为 0 */
  revisionVersion: number
  /** 处理说明 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 名录条目草稿（名录室表单用） */
export interface TaxonDraft {
  genus: string
  latinName: string
  status: TaxonStatus
  note: string
}

export function createEmptyTaxonDraft(): TaxonDraft {
  return { genus: '', latinName: '', status: '有效', note: '' }
}
