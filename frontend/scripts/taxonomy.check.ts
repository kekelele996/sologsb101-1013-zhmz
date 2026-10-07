import { buildGenusResolver, groupByResolvedGenus, planPendingRevisionGenera } from '@/utils/taxonomy'
import type { GenusRevision, TaxonEntry } from '@/types/catalog'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`ok - ${name}`)
  else {
    failures += 1
    console.error(`FAIL - ${name}`)
  }
}

const rev = (over: Partial<GenusRevision>): GenusRevision => ({
  id: 'r1',
  fromGenus: '',
  toGenus: null,
  kind: '新录',
  status: '待修订',
  version: null,
  failureReason: null,
  createdAt: 0,
  updatedAt: 0,
  ...over
})

const taxon = (acceptedGenus: string, status: TaxonEntry['status'] = '有效'): TaxonEntry => ({
  id: 't1',
  acceptedGenus,
  status,
  sinceVersion: 1,
  note: '',
  createdAt: 0,
  updatedAt: 0
})

// 1. resolver：已发布修订优先；名录有效名直通；未改到的按外业原名计入并标待定名
const resolve = buildGenusResolver(
  [
    rev({ fromGenus: '鹿角珊瑚属', toGenus: '轴孔珊瑚属', status: '已发布', version: 2 }),
    rev({ fromGenus: '杯形珊瑚属', toGenus: null, status: '待修订' }),
    rev({ fromGenus: '蔷薇珊瑚属', toGenus: '蒙特珊瑚属', status: '发布失败', failureReason: 'x' })
  ],
  [taxon('滨珊瑚属'), taxon('陀螺珊瑚属', '异名')]
)
check('已发布修订归并到定名', resolve('鹿角珊瑚属').genus === '轴孔珊瑚属' && resolve('鹿角珊瑚属').cataloged)
check('名录有效名直通', resolve('滨珊瑚属').genus === '滨珊瑚属' && resolve('滨珊瑚属').cataloged)
check('待修订不参与归并，按外业原名计入并标待定名', resolve('杯形珊瑚属').genus === '杯形珊瑚属' && !resolve('杯形珊瑚属').cataloged)
check('发布失败不参与归并', resolve('蔷薇珊瑚属').genus === '蔷薇珊瑚属' && !resolve('蔷薇珊瑚属').cataloged)
check('异名不算定名', !resolve('陀螺珊瑚属').cataloged)
check('完全没挂账的属名待定名', resolve('神秘珊瑚属').genus === '神秘珊瑚属' && !resolve('神秘珊瑚属').cataloged)

// 2. groupByResolvedGenus：拆分合并后归成一堆；待定名照常计入
const groups = groupByResolvedGenus(
  [
    { genus: '鹿角珊瑚属', coverCm: 100 },
    { genus: '鹿角珊瑚属', coverCm: 50 },
    { genus: '轴孔珊瑚属', coverCm: 30 },
    { genus: '杯形珊瑚属', coverCm: 20 }
  ],
  resolve
)
const acro = groups.find((g) => g.genus === '轴孔珊瑚属')
check('旧名与定名归并为一堆', acro !== undefined && acro.coverCm === 180)
check('归并组记录外业原名', acro !== undefined && acro.fromGenera.includes('鹿角珊瑚属') && acro.fromGenera.includes('轴孔珊瑚属'))
const poc = groups.find((g) => g.genus === '杯形珊瑚属')
check('待定名照常计入并标记', poc !== undefined && poc.coverCm === 20 && !poc.cataloged)
check('总覆盖长度守恒', groups.reduce((s, g) => s + g.coverCm, 0) === 200)

// 3. planPendingRevisionGenera：已知（修订条目任意状态 / 名录条目）不重复挂账
const pending = planPendingRevisionGenera(
  ['鹿角珊瑚属', '杯形珊瑚属', '滨珊瑚属', '新属名', '新属名'],
  [rev({ fromGenus: '鹿角珊瑚属' }), rev({ fromGenus: '杯形珊瑚属' })],
  [taxon('滨珊瑚属')]
)
check('只给完全没挂账的属名挂待修订', pending.length === 1 && pending[0] === '新属名')

if (failures > 0) {
  console.error(`${failures} 项失败`)
  process.exit(1)
}
console.log('全部通过')
