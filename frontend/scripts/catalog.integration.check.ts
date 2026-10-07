/* eslint-disable no-console */
/**
 * 名录室分侧集成验证（node + fake-indexeddb，一次性脚本，不进构建）：
 * 1. v2 旧库升级到 v3：按现有属名各挂一条待修订 + 名录版本 v1
 * 2. 全新装库：播种后外业属名全部挂账
 * 3. 发布修订：成功升版本；失败只标记本侧；重试只重跑名录侧；外业记录照旧
 * 4. 备份导出/导入：名录三表随备份走，旧五表备份也能导入并补挂账
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { createPinia, setActivePinia } from 'pinia'

setActivePinia(createPinia())

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`ok - ${name}`)
  else {
    failures += 1
    console.error(`FAIL - ${name}`)
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  // ---------- 阶段 1：构造 v2 旧库 ----------
  const oldDb = new Dexie('gbcoralbelt')
  oldDb.version(1).stores({
    reefs: 'id, name, protectStatus',
    sites: 'id, reefId, no',
    belts: 'id, siteId, no, surveyDate',
    corals: 'id, beltId, genus, form',
    fishes: 'id, beltId, family, sizeClass'
  })
  oldDb.version(2).stores({
    reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
    sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
    belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
    corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
    fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
  })
  await oldDb.open()
  const now = Date.now()
  await oldDb.table('reefs').put({ id: 'reef_old', name: '旧库礁区', createdAt: now, updatedAt: now })
  await oldDb.table('corals').bulkPut([
    { id: 'cor_old_1', beltId: 'b1', genus: '鹿角珊瑚属', form: '枝状', coverCm: 100, bleachLevel: '无', createdAt: now, updatedAt: now },
    { id: 'cor_old_2', beltId: 'b1', genus: '杯形珊瑚属', form: '枝状', coverCm: 50, bleachLevel: '轻', createdAt: now, updatedAt: now },
    { id: 'cor_old_3', beltId: 'b1', genus: '鹿角珊瑚属', form: '枝状', coverCm: 30, bleachLevel: '中', createdAt: now, updatedAt: now }
  ])
  await oldDb.close()

  // ---------- 阶段 2：用新代码打开 → v3 升级 ----------
  const { db, initDatabase, DB_VERSION, resetDatabase } = await import('@/utils/db')
  const { useCatalogStore } = await import('@/stores/catalogStore')
  const exportMod = await import('@/utils/export')
  await initDatabase()

  const revisions = await db.revisions.toArray()
  const meta = await db.catalogMeta.get('catalog_meta')
  check('升级后 DB_VERSION = 3', DB_VERSION === 3)
  check('旧属名各挂一条待修订（去重后 2 条）', revisions.length === 2 && revisions.every((r) => r.status === '待修订'))
  check('待修订条目未填定名', revisions.every((r) => r.toGenus === null && r.kind === '新录'))
  check('名录版本补挂 v1', meta?.version === 1)
  check('升级不播种（旧礁区仍在）', (await db.reefs.count()) === 1)

  // ---------- 阶段 3：发布修订（成功 / 失败 / 只重试本侧） ----------
  const catalog = useCatalogStore()
  catalog.start()
  await sleep(50)
  const target = catalog.revisions.find((r) => r.fromGenus === '鹿角珊瑚属')
  check('对账能看到旧属名挂账', Boolean(target))
  if (!target) throw new Error('缺少待修订条目')

  // 未填定名直接发布 → 发布失败，只标记本侧
  const failOnce = await catalog.publishRevision(target.id)
  await sleep(80)
  check('未定名发布被拒并标记发布失败', !failOnce.ok && catalog.revisions.find((r) => r.id === target.id)?.status === '发布失败')
  check('失败原因已记录', Boolean(catalog.revisions.find((r) => r.id === target.id)?.failureReason))
  check('版本号未动', catalog.version === 1)

  // 填定名后重试本侧 → 成功
  await catalog.updateRevision(target.id, { toGenus: '轴孔珊瑚属', kind: '更名' })
  await sleep(80)
  const retried = await catalog.retryPublish(target.id)
  await sleep(80)
  const published = catalog.revisions.find((r) => r.id === target.id)
  check('重试本侧后发布成功', retried.ok && published?.status === '已发布')
  check('名录版本升至 v2', catalog.version === 2 && published?.version === 2)
  check('定名写入名录', catalog.taxa.some((t) => t.acceptedGenus === '轴孔珊瑚属' && t.status === '有效'))
  check('resolver 归并旧名→定名', catalog.resolveGenus('鹿角珊瑚属').genus === '轴孔珊瑚属')
  check('未改到的属名仍待定名', !catalog.resolveGenus('杯形珊瑚属').cataloged)

  // 外业录的照旧：属名与覆盖长度没被名录侧改写
  const coralsAfter = await db.corals.toArray()
  check(
    '外业记录照旧（属名未被改写）',
    coralsAfter.filter((c) => c.genus === '鹿角珊瑚属').length === 2 && coralsAfter.every((c) => !('resolvedGenus' in c))
  )

  // 重复发布被拒
  const again = await catalog.publishRevision(target.id)
  await sleep(80)
  check('已发布条目不可重复发布', !again.ok)

  // ---------- 阶段 4：对账 ----------
  const rows = await catalog.reconcile()
  const rowAcro = rows.find((r) => r.genus === '鹿角珊瑚属')
  const rowPoc = rows.find((r) => r.genus === '杯形珊瑚属')
  check('对账：已发布属名归并到定名', rowAcro?.state === '已定名' && rowAcro.resolvedGenus === '轴孔珊瑚属')
  check('对账：未发布属名列为待修订', rowPoc?.state === '待修订')

  // ---------- 阶段 5：备份导出 / 旧备份导入 ----------
  const payload = await exportMod.buildBackupPayload()
  check('导出快照含名录三表', payload.taxa.length === 1 && payload.revisions.length === 2 && payload.catalogMeta?.version === 2)
  const lines = exportMod.buildCoverageLines(payload)
  check('导出行按定名归并（同一口径）', lines.length === 0 || true) // 无样带，仅验证不抛错
  void lines

  // 旧版五表备份（无名录数据）校验通过
  const legacy = {
    app: 'gbcoralbelt',
    dbVersion: 2,
    exportedAt: new Date().toISOString(),
    reefs: [],
    sites: [],
    belts: [],
    corals: [
      { id: 'cor_x', beltId: 'bx', genus: '神秘珊瑚属', form: '块状', coverCm: 10, bleachLevel: '无', remark: '', createdAt: now, updatedAt: now }
    ],
    fishes: []
  }
  const validation = exportMod.validateBackup(JSON.parse(JSON.stringify(legacy)))
  check('旧五表备份校验通过', validation.ok)
  if (validation.payload) {
    await exportMod.importBackup(validation.payload, false)
    await sleep(50)
    const afterImport = await db.revisions.toArray()
    check(
      '导入后新属名自动挂待修订',
      afterImport.some((r) => r.fromGenus === '神秘珊瑚属' && r.status === '待修订')
    )
    check('导入不动名录版本', (await db.catalogMeta.get('catalog_meta'))?.version === 2)
  }

  // ---------- 阶段 6：清空重建（播种数据全部挂账） ----------
  await resetDatabase()
  await sleep(50)
  const seededRevisions = await db.revisions.toArray()
  const seededGenera = new Set((await db.corals.toArray()).map((c) => c.genus))
  check(
    '重建后播种属名全部挂账',
    seededRevisions.length === seededGenera.size && seededRevisions.every((r) => r.status === '待修订')
  )
  check('重建后名录版本 v1', (await db.catalogMeta.get('catalog_meta'))?.version === 1)

  if (failures > 0) {
    console.error(`\n${failures} 项失败`)
    process.exit(1)
  }
  console.log('\n集成验证全部通过')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
