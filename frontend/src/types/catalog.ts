/**
 * 分类名录域模型（名录室维护）。
 * 名录室与外业普查组分侧：名录室只管分类名录、属名修订条目与修订版本号；
 * 外业侧（样带 / 珊瑚记录 / 覆盖长度）保留下水当场记的原始属名，不被名录侧改写。
 */

/** 名录条目状态：有效名 / 异名（被拆分合并后废止）/ 待审定 */
export type TaxonStatus = '有效' | '异名' | '待审定'

export const TAXON_STATUSES: TaxonStatus[] = ['有效', '异名', '待审定']

/** 分类名录条目：一个被名录室确认的属名 */
export interface TaxonEntry {
  id: string
  /** 名录定名（有效属名），如 鹿角珊瑚属 */
  acceptedGenus: string
  /** 状态 */
  status: TaxonStatus
  /** 引入该条目的名录版本号 */
  sinceVersion: number
  /** 备注（拆分合并依据、文献来源等） */
  note: string
  createdAt: number
  updatedAt: number
}

/** 修订类型：拆分 / 合并 / 更名 / 新录（旧数据升级挂账用） */
export type RevisionKind = '拆分' | '合并' | '更名' | '新录'

export const REVISION_KINDS: RevisionKind[] = ['拆分', '合并', '更名', '新录']

/**
 * 修订条目状态：
 * - 待修订：已挂账、名录室尚未定名（旧数据升级时按现有属名各挂一条）
 * - 已发布：已定名并随名录版本发布，参与归并
 * - 发布失败：名录侧事务失败，只重试本侧，外业记录照旧
 */
export type RevisionStatus = '待修订' | '已发布' | '发布失败'

export const REVISION_STATUSES: RevisionStatus[] = ['待修订', '已发布', '发布失败']

/** 属名修订条目：把一个外业属名修订为名录定名 */
export interface GenusRevision {
  id: string
  /** 外业原属名（被修订的名） */
  fromGenus: string
  /** 修订后定名；待修订时为空，等名录室定名 */
  toGenus: string | null
  /** 修订类型 */
  kind: RevisionKind
  status: RevisionStatus
  /** 发布时记入的名录版本号；未发布为 null */
  version: number | null
  /** 发布失败原因（仅发布失败时有值） */
  failureReason: string | null
  createdAt: number
  updatedAt: number
}

/** 名录版本元数据（单行，id 固定） */
export interface CatalogMeta {
  id: string
  /** 修订版本号：每次成功发布修订 +1 */
  version: number
  updatedAt: number
}

/** 名录版本元数据固定主键 */
export const CATALOG_META_ID = 'catalog_meta'

/** 名录初始版本号（旧数据升级时补挂） */
export const CATALOG_INITIAL_VERSION = 1

/** 对账时外业属名的名录侧状态 */
export type ReconcileState = '已定名' | '待修订' | '未挂账'

/** 对账行：一个外业属名与名录侧的对照结果 */
export interface ReconcileRow {
  /** 外业记录的原始属名 */
  genus: string
  /** 该属名在外业的记录条数 */
  recordCount: number
  /** 名录侧状态 */
  state: ReconcileState
  /** 归并用的定名（未挂账 / 待修订时为外业原名） */
  resolvedGenus: string
  /** 命中的修订条目（如有） */
  revision: GenusRevision | null
}
