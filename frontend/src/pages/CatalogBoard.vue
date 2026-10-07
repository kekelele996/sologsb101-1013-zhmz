<script setup lang="ts">
/**
 * 模块 7：/catalog 分类名录室
 * 名录室维护分类名录、属名修订条目与修订版本号；与外业普查组分侧——
 * 本页只写名录侧三表，外业样带 / 珊瑚记录 / 覆盖长度保持原样。
 * 对账面板把外业属名与名录、修订条目逐条对照，对不上的列出来等名录室处理。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, RefreshLeft, Upload } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useCatalogStore } from '@/stores/catalogStore'
import type { GenusRevision, ReconcileRow, RevisionKind, TaxonStatus } from '@/types/catalog'
import { REVISION_KINDS, TAXON_STATUSES } from '@/types/catalog'

const catalogStore = useCatalogStore()

const reconcileRows = ref<ReconcileRow[]>([])
const reconciling = ref(false)
const publishing = ref<string | null>(null)
const notice = ref('')

/** 修订条目表单（新建 / 编辑共用） */
const revisionDialog = ref(false)
const revisionEditingId = ref<string | null>(null)
const revisionForm = reactive<{ fromGenus: string; toGenus: string; kind: RevisionKind }>({
  fromGenus: '',
  toGenus: '',
  kind: '新录'
})

/** 名录条目表单 */
const taxonDialog = ref(false)
const taxonForm = reactive<{ acceptedGenus: string; status: TaxonStatus; note: string }>({
  acceptedGenus: '',
  status: '有效',
  note: ''
})

const stats = computed(() => {
  const published = catalogStore.revisions.filter((item) => item.status === '已发布').length
  const failed = catalogStore.revisions.filter((item) => item.status === '发布失败').length
  const pending = catalogStore.revisions.filter((item) => item.status === '待修订').length
  const unmatched = reconcileRows.value.filter((row) => row.state === '未挂账').length
  return { published, failed, pending, unmatched }
})

const sortedRevisions = computed(() =>
  [...catalogStore.revisions].sort((a, b) => {
    const order: Record<GenusRevision['status'], number> = { 发布失败: 0, 待修订: 1, 已发布: 2 }
    const diff = order[a.status] - order[b.status]
    if (diff !== 0) return diff
    return b.updatedAt - a.updatedAt
  })
)

const sortedTaxa = computed(() =>
  [...catalogStore.taxa].sort((a, b) => a.acceptedGenus.localeCompare(b.acceptedGenus, 'zh-Hans-CN'))
)

/** 对账：外业属名 vs 名录条目与修订条目 */
async function runReconcile(): Promise<void> {
  reconciling.value = true
  try {
    reconcileRows.value = await catalogStore.reconcile()
  } finally {
    reconciling.value = false
  }
}

/** 一键挂账：对不上的外业属名各挂一条待修订 */
async function handleEnsurePending(): Promise<void> {
  const count = await catalogStore.ensurePending()
  await runReconcile()
  notice.value =
    count > 0 ? `已为 ${count} 个外业属名补挂「待修订」，等名录室定名。` : '外业属名均已挂账，无需补挂。'
  ElMessage.success(notice.value)
}

function openRevisionCreate(fromGenus = ''): void {
  revisionEditingId.value = null
  revisionForm.fromGenus = fromGenus
  revisionForm.toGenus = ''
  revisionForm.kind = '新录'
  revisionDialog.value = true
}

function openRevisionEdit(revision: GenusRevision): void {
  revisionEditingId.value = revision.id
  revisionForm.fromGenus = revision.fromGenus
  revisionForm.toGenus = revision.toGenus ?? ''
  revisionForm.kind = revision.kind
  revisionDialog.value = true
}

async function submitRevision(): Promise<void> {
  if (!revisionForm.fromGenus.trim()) {
    ElMessage.warning('请填写外业原属名')
    return
  }
  if (revisionEditingId.value) {
    await catalogStore.updateRevision(revisionEditingId.value, {
      toGenus: revisionForm.toGenus.trim() || null,
      kind: revisionForm.kind
    })
    ElMessage.success('修订条目已更新')
  } else {
    await catalogStore.createRevision({
      fromGenus: revisionForm.fromGenus,
      toGenus: revisionForm.toGenus.trim() || null,
      kind: revisionForm.kind
    })
    ElMessage.success('修订条目已挂账（待修订）')
  }
  revisionDialog.value = false
  await runReconcile()
}

/** 发布修订：仅名录侧事务；失败只标记本侧，外业记录照旧 */
async function handlePublish(revision: GenusRevision): Promise<void> {
  publishing.value = revision.id
  try {
    const result = await catalogStore.publishRevision(revision.id)
    if (result.ok) {
      ElMessage.success(result.message)
    } else {
      ElMessage.error(`${result.message}；可修正后重试，外业记录不受影响。`)
    }
  } finally {
    publishing.value = null
    await runReconcile()
  }
}

/** 发布失败后只重试本侧 */
async function handleRetry(revision: GenusRevision): Promise<void> {
  publishing.value = revision.id
  try {
    const result = await catalogStore.retryPublish(revision.id)
    if (result.ok) {
      ElMessage.success(`重试成功：${result.message}`)
    } else {
      ElMessage.error(`重试仍未发布：${result.message}`)
    }
  } finally {
    publishing.value = null
    await runReconcile()
  }
}

async function handleRemoveRevision(revision: GenusRevision): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除「${revision.fromGenus}」的待修订条目？外业记录不受影响。`,
      '删除修订条目',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await catalogStore.removeRevision(revision.id)
  await runReconcile()
  ElMessage.success('修订条目已删除')
}

function openTaxonCreate(): void {
  taxonForm.acceptedGenus = ''
  taxonForm.status = '有效'
  taxonForm.note = ''
  taxonDialog.value = true
}

async function submitTaxon(): Promise<void> {
  if (!taxonForm.acceptedGenus.trim()) {
    ElMessage.warning('请填写名录定名')
    return
  }
  await catalogStore.createTaxon(taxonForm)
  taxonDialog.value = false
  await runReconcile()
  ElMessage.success('名录条目已录入')
}

async function handleTaxonStatus(id: string, status: TaxonStatus): Promise<void> {
  await catalogStore.updateTaxon(id, { status })
  await runReconcile()
  ElMessage.success(`名录条目状态已改为「${status}」`)
}

async function handleRemoveTaxon(id: string, acceptedGenus: string): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除名录条目「${acceptedGenus}」？已发布的修订条目不受影响。`, '删除名录条目', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await catalogStore.removeTaxon(id)
  await runReconcile()
  ElMessage.success('名录条目已删除')
}

onMounted(() => {
  void runReconcile()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">
          分类名录室
          <el-tag size="small" type="success" effect="dark">名录版本 v{{ catalogStore.version }}</el-tag>
        </h2>
        <p class="gb-hint">
          名录室维护分类名录、属名修订条目与修订版本号；覆盖率与白化指数按名录定名归并，
          名录还没改到的属名按外业原名照常计入并标记「待定名」。本页只写名录侧数据，外业记录照旧。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="Refresh" :loading="reconciling" @click="runReconcile">重新对账</el-button>
        <el-button :icon="Plus" @click="openTaxonCreate">录入名录条目</el-button>
        <el-button type="primary" :icon="Plus" @click="openRevisionCreate()">新建修订条目</el-button>
      </div>
    </div>

    <el-alert v-if="notice" type="success" :closable="false" show-icon :title="notice" />

    <div class="gb-stats-row">
      <StatBadge label="名录版本" :value="`v${catalogStore.version}`" icon="DataLine" />
      <StatBadge label="名录条目" :value="catalogStore.taxa.length" suffix="条" tone="info" icon="Files" />
      <StatBadge label="已发布修订" :value="stats.published" suffix="条" tone="success" icon="Odometer" />
      <StatBadge
        label="待修订 / 失败"
        :value="`${stats.pending} / ${stats.failed}`"
        suffix="条"
        :tone="stats.failed > 0 ? 'danger' : stats.pending > 0 ? 'warning' : 'success'"
        icon="WarningFilled"
      />
      <StatBadge
        label="对不上待处理"
        :value="stats.unmatched"
        suffix="个属名"
        :tone="stats.unmatched > 0 ? 'warning' : 'success'"
        icon="Histogram"
      />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>属名对账（外业 vs 名录）</h3>
        <div class="page__title-side">
          <span class="gb-hint">对不上的列出来等名录室处理</span>
          <el-button size="small" type="primary" plain :disabled="stats.unmatched === 0" @click="handleEnsurePending">
            一键挂账（{{ stats.unmatched }}）
          </el-button>
        </div>
      </div>

      <EmptyPanel
        v-if="reconcileRows.length === 0"
        title="外业还没有珊瑚记录"
        description="外业普查组录入珊瑚记录后，这里会按属名与名录、修订条目逐条对账。"
        compact
      />

      <el-table v-else v-loading="reconciling" :data="reconcileRows" border stripe class="gb-table-compact">
        <el-table-column prop="genus" label="外业属名" min-width="140" />
        <el-table-column label="外业记录" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.recordCount }} 条</span>
          </template>
        </el-table-column>
        <el-table-column label="名录侧状态" width="130">
          <template #default="{ row }">
            <el-tag v-if="row.state === '已定名'" type="success" size="small" effect="plain">已定名</el-tag>
            <el-tag v-else-if="row.state === '待修订'" type="warning" size="small" effect="plain">待修订</el-tag>
            <el-tag v-else type="danger" size="small" effect="plain">未挂账</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="归并定名" min-width="150">
          <template #default="{ row }">
            <span>{{ row.resolvedGenus }}</span>
            <span v-if="row.state !== '已定名'" class="gb-hint">（待定名，按外业原名计入）</span>
          </template>
        </el-table-column>
        <el-table-column label="修订条目" min-width="150">
          <template #default="{ row }">
            <template v-if="row.revision">
              <span class="gb-mono">{{ row.revision.kind }}</span>
              <span v-if="row.revision.toGenus" class="gb-hint"> → {{ row.revision.toGenus }}</span>
              <span v-if="row.revision.version" class="gb-hint"> · v{{ row.revision.version }}</span>
            </template>
            <span v-else class="gb-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.state === '未挂账'" size="small" type="primary" plain @click="openRevisionCreate(row.genus)">
              挂账定名
            </el-button>
            <el-button
              v-else-if="row.state === '待修订' && row.revision"
              size="small"
              @click="openRevisionEdit(row.revision)"
            >
              去定名
            </el-button>
            <span v-else class="gb-hint">已对平</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>属名修订条目（{{ catalogStore.revisions.length }} 条）</h3>
        <span class="gb-hint">发布只写名录侧；失败可只重试本侧，外业录的照旧</span>
      </div>

      <EmptyPanel
        v-if="sortedRevisions.length === 0"
        title="还没有修订条目"
        description="旧数据升级或外业录入新属名时会自动挂「待修订」；也可以手动新建。"
        action-text="新建修订条目"
        compact
        @action="openRevisionCreate()"
      />

      <el-table v-else :data="sortedRevisions" border stripe class="gb-table-compact">
        <el-table-column label="原属名 → 定名" min-width="200">
          <template #default="{ row }">
            <span>{{ row.fromGenus }}</span>
            <span class="gb-hint"> → </span>
            <span v-if="row.toGenus">{{ row.toGenus }}</span>
            <span v-else class="gb-hint">（待定名）</span>
          </template>
        </el-table-column>
        <el-table-column prop="kind" label="类型" width="90" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.status === '已发布'" type="success" size="small" effect="plain">
              已发布 v{{ row.version }}
            </el-tag>
            <el-tag v-else-if="row.status === '发布失败'" type="danger" size="small" effect="plain">发布失败</el-tag>
            <el-tag v-else type="warning" size="small" effect="plain">待修订</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="失败原因" min-width="180">
          <template #default="{ row }">
            <span v-if="row.failureReason" class="page__failure">{{ row.failureReason }}</span>
            <span v-else class="gb-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status !== '已发布'">
              <el-button
                size="small"
                type="primary"
                :icon="Upload"
                :loading="publishing === row.id"
                @click="handlePublish(row)"
              >
                发布
              </el-button>
              <el-button
                v-if="row.status === '发布失败'"
                size="small"
                type="warning"
                plain
                :icon="RefreshLeft"
                :loading="publishing === row.id"
                @click="handleRetry(row)"
              >
                重试本侧
              </el-button>
              <el-button size="small" :icon="Edit" @click="openRevisionEdit(row)">编辑</el-button>
              <el-button
                v-if="row.status === '待修订'"
                size="small"
                type="danger"
                plain
                :icon="Delete"
                @click="handleRemoveRevision(row)"
              >
                删除
              </el-button>
            </template>
            <span v-else class="gb-hint">已入名录 v{{ row.version }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>分类名录（{{ catalogStore.taxa.length }} 条）</h3>
        <span class="gb-hint">名录定名即归并口径；异名为拆分合并后废止的旧名</span>
      </div>

      <EmptyPanel
        v-if="sortedTaxa.length === 0"
        title="名录还是空的"
        description="可以先录入有效属名，或直接发布修订条目——发布会自动把定名写入名录。"
        action-text="录入名录条目"
        compact
        @action="openTaxonCreate"
      />

      <el-table v-else :data="sortedTaxa" border stripe class="gb-table-compact">
        <el-table-column prop="acceptedGenus" label="名录定名" min-width="150" />
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-select
              :model-value="row.status"
              size="small"
              @change="(value: TaxonStatus) => handleTaxonStatus(row.id, value)"
            >
              <el-option v-for="status in TAXON_STATUSES" :key="status" :label="status" :value="status" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="引入版本" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">v{{ row.sinceVersion }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="200" show-overflow-tooltip />
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="danger" plain :icon="Delete" @click="handleRemoveTaxon(row.id, row.acceptedGenus)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog
      v-model="revisionDialog"
      :title="revisionEditingId ? '编辑修订条目' : '新建修订条目'"
      width="520px"
      :close-on-click-modal="false"
    >
      <el-form label-width="110px">
        <el-form-item label="外业原属名" required>
          <el-input v-model="revisionForm.fromGenus" :disabled="revisionEditingId !== null" maxlength="30" />
        </el-form-item>
        <el-form-item label="修订后定名">
          <el-input v-model="revisionForm.toGenus" placeholder="留空表示待定名" maxlength="30" />
        </el-form-item>
        <el-form-item label="修订类型" required>
          <el-radio-group v-model="revisionForm.kind">
            <el-radio-button v-for="kind in REVISION_KINDS" :key="kind" :value="kind">{{ kind }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="revisionDialog = false">取消</el-button>
        <el-button type="primary" @click="submitRevision">{{ revisionEditingId ? '保存修改' : '挂账' }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="taxonDialog" title="录入名录条目" width="520px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="名录定名" required>
          <el-input v-model="taxonForm.acceptedGenus" placeholder="如：鹿角珊瑚属" maxlength="30" />
        </el-form-item>
        <el-form-item label="状态" required>
          <el-radio-group v-model="taxonForm.status">
            <el-radio-button v-for="status in TAXON_STATUSES" :key="status" :value="status">{{ status }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="taxonForm.note" placeholder="拆分合并依据、文献来源等" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="taxonDialog = false">取消</el-button>
        <el-button type="primary" @click="submitTaxon">录入名录</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__title-side {
  display: flex;
  align-items: center;
  gap: 10px;
}

.page__failure {
  color: #c0392b;
  font-size: 12px;
}
</style>
