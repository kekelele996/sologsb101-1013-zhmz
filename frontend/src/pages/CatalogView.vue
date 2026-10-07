<script setup lang="ts">
/**
 * 模块 7：/catalog 分类名录与属名修订（名录室）
 * 名录室维护分类名录条目、属名修订条目与修订版本号；外业普查组只管样带与珊瑚记录。
 * 两边按属名跟修订条目对账，对不上的列出来等名录室处理；
 * 发布修订只动本侧修订条目，外业录的珊瑚记录照旧，失败后只重试本侧。
 * 复用 <FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Checked, Plus, Refresh, Upload } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useCatalogStore } from '@/stores/catalogStore'
import type { FilterModel } from '@/types/filter'
import type { GenusRevision, TaxonEntry } from '@/types/catalog'
import { REVISION_STATUS_LABEL, REVISION_STATUSES, TAXON_STATUSES, createEmptyTaxonDraft } from '@/types/catalog'

const catalogStore = useCatalogStore()

const notice = ref('')
const publishing = ref(false)

/** 修订条目状态徽标配色 */
const REVISION_TAG_TYPE: Record<GenusRevision['status'], 'info' | 'success' | 'danger'> = {
  pending: 'info',
  resolved: 'success',
  failed: 'danger'
}

const filterModel = computed<FilterModel>(() => ({
  keyword: catalogStore.filter.keyword,
  revisionStatuses: catalogStore.filter.revisionStatuses
}))

function handleFilterChange(model: FilterModel): void {
  catalogStore.patchFilter({
    keyword: typeof model.keyword === 'string' ? model.keyword : '',
    revisionStatuses: Array.isArray(model.revisionStatuses)
      ? (model.revisionStatuses as GenusRevision['status'][])
      : []
  })
}

function handleFilterReset(): void {
  catalogStore.resetFilter()
}

/* ------------------------------ 对账 ------------------------------ */

const reconciliation = computed(() => catalogStore.reconciliation)

async function attachPending(genera: string[]): Promise<void> {
  const count = await catalogStore.attachPendingRevisions(genera)
  if (count === 0) {
    ElMessage.info('这些属名已有修订条目，无需重复挂起')
    return
  }
  notice.value = `已为 ${count} 个外业属名挂待修订，等名录室定名。`
  ElMessage.success(notice.value)
}

async function removeStaleRevision(revision: GenusRevision): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `外业记录中已没有「${revision.fieldGenus}」，删除该修订条目？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await catalogStore.removeRevision(revision.id)
  ElMessage.success('修订条目已删除')
}

/* ------------------------------ 名录条目 ------------------------------ */

const taxonDialogVisible = ref(false)
const taxonEditingId = ref<string | null>(null)
const taxonSubmitting = ref(false)
const taxonForm = reactive(createEmptyTaxonDraft())

function openTaxonCreate(): void {
  taxonEditingId.value = null
  Object.assign(taxonForm, createEmptyTaxonDraft())
  taxonDialogVisible.value = true
}

function openTaxonEdit(taxon: TaxonEntry): void {
  taxonEditingId.value = taxon.id
  taxonForm.genus = taxon.genus
  taxonForm.latinName = taxon.latinName
  taxonForm.status = taxon.status
  taxonForm.note = taxon.note
  taxonDialogVisible.value = true
}

async function submitTaxon(): Promise<void> {
  if (!taxonForm.genus.trim()) {
    ElMessage.warning('请填写名录属名')
    return
  }
  taxonSubmitting.value = true
  try {
    const payload = {
      genus: taxonForm.genus.trim(),
      latinName: taxonForm.latinName.trim(),
      status: taxonForm.status,
      note: taxonForm.note.trim()
    }
    if (taxonEditingId.value) {
      await catalogStore.updateTaxon(taxonEditingId.value, payload)
      ElMessage.success('名录条目已更新')
    } else {
      await catalogStore.createTaxon(payload)
      ElMessage.success('名录条目已新增')
    }
    taxonDialogVisible.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存名录条目失败')
  } finally {
    taxonSubmitting.value = false
  }
}

async function removeTaxon(taxon: TaxonEntry): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除名录条目「${taxon.genus}」？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await catalogStore.removeTaxon(taxon.id)
    ElMessage.success('名录条目已删除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除名录条目失败')
  }
}

/* ------------------------------ 修订条目 ------------------------------ */

const revisionDialogVisible = ref(false)
const revisionEditingId = ref<string | null>(null)
const revisionTarget = ref('')
const revisionNote = ref('')

function openRevisionEdit(revision: GenusRevision): void {
  revisionEditingId.value = revision.id
  revisionTarget.value = revision.acceptedGenus
  revisionNote.value = revision.note
  revisionDialogVisible.value = true
}

async function submitRevision(): Promise<void> {
  if (!revisionEditingId.value) return
  await catalogStore.updateRevision(revisionEditingId.value, {
    acceptedGenus: revisionTarget.value.trim(),
    note: revisionNote.value.trim()
  })
  revisionDialogVisible.value = false
  ElMessage.success('修订条目已更新，发布后按名录定名归并')
}

async function removeRevision(revision: GenusRevision): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除「${revision.fieldGenus}」的修订条目？该外业属名将回到对账清单。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await catalogStore.removeRevision(revision.id)
  ElMessage.success('修订条目已删除')
}

function reportPublish(result: { version: number; resolved: number; failed: number }, action: string): void {
  if (result.resolved === 0 && result.failed === 0) {
    ElMessage.info('没有需要发布的修订条目')
    return
  }
  if (result.failed > 0) {
    notice.value = `${action}：${result.resolved} 条已定名（第 ${result.version} 版），${result.failed} 条发布失败，可在本页修正后重试；外业记录不受影响。`
    ElMessage.warning(notice.value)
  } else {
    notice.value = `${action}：${result.resolved} 条已定名，修订版本号升为第 ${result.version} 版。`
    ElMessage.success(notice.value)
  }
}

async function publishOne(revision: GenusRevision): Promise<void> {
  publishing.value = true
  try {
    reportPublish(await catalogStore.publishRevisions([revision.id]), `发布「${revision.fieldGenus}」`)
  } finally {
    publishing.value = false
  }
}

async function publishAllPending(): Promise<void> {
  publishing.value = true
  try {
    reportPublish(await catalogStore.publishAllPending(), '发布全部待修订')
  } finally {
    publishing.value = false
  }
}

/** 发布失败后只重试本侧失败条目，外业录的照旧 */
async function retryFailed(): Promise<void> {
  publishing.value = true
  try {
    reportPublish(await catalogStore.retryFailed(), '重试失败条目')
  } finally {
    publishing.value = false
  }
}
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">名录室 · 分类名录与属名修订</h2>
        <p class="gb-hint">
          名录室维护分类名录、属名修订条目与修订版本号；覆盖率与白化指数按名录定名归并，
          名录还没改到的属名先按外业名字照常计入并标为「待定名」，汇总与导出走同一个口径。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="Upload" :loading="publishing" :disabled="catalogStore.pendingRevisions.length === 0" @click="publishAllPending">
          发布全部待修订
        </el-button>
        <el-button :icon="Refresh" :loading="publishing" :disabled="catalogStore.failedRevisions.length === 0" @click="retryFailed">
          重试失败条目（{{ catalogStore.failedRevisions.length }}）
        </el-button>
        <el-button type="primary" :icon="Plus" @click="openTaxonCreate">新增名录条目</el-button>
      </div>
    </div>

    <el-alert v-if="notice" type="success" :closable="false" show-icon :title="notice" />

    <div class="gb-stats-row">
      <StatBadge label="名录条目" :value="catalogStore.taxa.length" suffix="条" icon="Collection" />
      <StatBadge
        label="当前修订版本"
        :value="`v${catalogStore.currentRevisionVersion}`"
        tone="info"
        icon="Files"
      />
      <StatBadge label="待修订" :value="catalogStore.pendingRevisions.length" suffix="条" tone="warning" icon="EditPen" />
      <StatBadge label="发布失败" :value="catalogStore.failedRevisions.length" suffix="条" tone="danger" icon="WarningFilled" />
      <StatBadge label="外业属名" :value="catalogStore.fieldGenera.length" suffix="个" tone="success" icon="Histogram" />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>属名对账（外业 × 名录 × 修订条目）</h3>
        <span class="gb-hint">对不上的列出来等名录室处理；挂起后进入下方修订条目队列</span>
      </div>

      <EmptyPanel
        v-if="
          reconciliation.unmatchedGenera.length === 0 &&
          reconciliation.staleRevisions.length === 0 &&
          reconciliation.danglingRevisions.length === 0
        "
        title="两边账目一致"
        description="外业属名与名录、修订条目全部对得上，没有待名录室处理的差异。"
        compact
      />

      <div v-else class="page__reconcile">
        <div v-if="reconciliation.unmatchedGenera.length > 0" class="page__reconcile-block">
          <h4 class="page__sub">
            外业有、名录无条目（{{ reconciliation.unmatchedGenera.length }} 个）
            <el-button size="small" text type="primary" @click="attachPending(reconciliation.unmatchedGenera)">
              全部挂待修订
            </el-button>
          </h4>
          <div class="page__chips">
            <el-tag
              v-for="genus in reconciliation.unmatchedGenera"
              :key="genus"
              type="warning"
              effect="plain"
              class="page__chip"
            >
              {{ genus }}
              <el-button size="small" text type="primary" @click="attachPending([genus])">挂待修订</el-button>
            </el-tag>
          </div>
          <p class="gb-hint">这些属名目前按外业名字照常计入覆盖率与白化指数，并标为「待定名」。</p>
        </div>

        <div v-if="reconciliation.danglingRevisions.length > 0" class="page__reconcile-block">
          <h4 class="page__sub">已定名但定名不在有效名录（{{ reconciliation.danglingRevisions.length }} 条）</h4>
          <el-table :data="reconciliation.danglingRevisions" border stripe class="gb-table-compact">
            <el-table-column prop="fieldGenus" label="外业属名" min-width="120" />
            <el-table-column prop="acceptedGenus" label="名录定名（名录中缺失）" min-width="160" />
            <el-table-column label="修订版本" width="100" align="right">
              <template #default="{ row }">
                <span class="gb-mono">v{{ row.revisionVersion }}</span>
              </template>
            </el-table-column>
            <el-table-column label="处理" width="140">
              <template #default="{ row }">
                <el-button size="small" @click="openRevisionEdit(row)">改定名</el-button>
              </template>
            </el-table-column>
          </el-table>
          <p class="gb-hint">请先在下方名录中补录该属名，或把修订条目改到有效名录属名。</p>
        </div>

        <div v-if="reconciliation.staleRevisions.length > 0" class="page__reconcile-block">
          <h4 class="page__sub">外业已没有该属名的修订条目（{{ reconciliation.staleRevisions.length }} 条）</h4>
          <el-table :data="reconciliation.staleRevisions" border stripe class="gb-table-compact">
            <el-table-column prop="fieldGenus" label="外业属名" min-width="120" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="REVISION_TAG_TYPE[row.status as GenusRevision['status']]" effect="plain">
                  {{ REVISION_STATUS_LABEL[row.status as GenusRevision['status']] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="note" label="说明" min-width="180" show-overflow-tooltip />
            <el-table-column label="处理" width="140">
              <template #default="{ row }">
                <el-button size="small" type="danger" plain @click="removeStaleRevision(row)">删除条目</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </el-card>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'revisionStatuses',
          label: '修订状态',
          options: REVISION_STATUSES.map((status) => ({ label: REVISION_STATUS_LABEL[status], value: status }))
        }
      ]"
      keyword-placeholder="搜索属名 / 定名 / 说明"
      @change="handleFilterChange"
      @reset="handleFilterReset"
    />

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>属名修订条目（{{ catalogStore.filteredRevisions.length }} 条）</h3>
        <span class="gb-hint">
          当前修订版本 v{{ catalogStore.currentRevisionVersion }} · 发布只动本侧条目，外业珊瑚记录照旧
        </span>
      </div>

      <EmptyPanel
        v-if="catalogStore.filteredRevisions.length === 0"
        title="没有符合条件的修订条目"
        description="外业新属名会在对账面板列出，挂起后进入本队列；也可调整筛选条件。"
        compact
      />

      <el-table v-else :data="catalogStore.filteredRevisions" border stripe class="gb-table-compact">
        <el-table-column prop="fieldGenus" label="外业属名" min-width="130" />
        <el-table-column label="名录定名" min-width="150">
          <template #default="{ row }">
            <span v-if="row.acceptedGenus">{{ row.acceptedGenus }}</span>
            <el-tag v-else size="small" type="info" effect="plain">待定名</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="REVISION_TAG_TYPE[row.status as GenusRevision['status']]" effect="plain">
              {{ REVISION_STATUS_LABEL[row.status as GenusRevision['status']] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="修订版本" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.revisionVersion > 0 ? `v${row.revisionVersion}` : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="处理说明" min-width="220" show-overflow-tooltip />
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openRevisionEdit(row)">定名</el-button>
            <el-button
              v-if="row.status !== 'resolved'"
              size="small"
              type="primary"
              plain
              :icon="Checked"
              :loading="publishing"
              @click="publishOne(row)"
            >
              发布
            </el-button>
            <el-button size="small" type="danger" plain @click="removeRevision(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>分类名录（{{ catalogStore.filteredTaxa.length }} 条）</h3>
        <span class="gb-hint">有效属名可直接命中定名；异名仅留档，需经修订条目归并</span>
      </div>

      <EmptyPanel
        v-if="catalogStore.filteredTaxa.length === 0"
        title="名录还是空的"
        description="先新增名录条目，名录室才能为外业属名定名。"
        action-text="新增名录条目"
        compact
        @action="openTaxonCreate"
      />

      <el-table v-else :data="catalogStore.filteredTaxa" border stripe class="gb-table-compact">
        <el-table-column prop="genus" label="名录属名" min-width="130" />
        <el-table-column label="拉丁学名" min-width="140">
          <template #default="{ row }">
            <span class="page__latin">{{ row.latinName || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === '有效' ? 'success' : 'info'" effect="plain">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="220" show-overflow-tooltip />
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openTaxonEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="removeTaxon(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog
      v-model="taxonDialogVisible"
      :title="taxonEditingId ? '编辑名录条目' : '新增名录条目'"
      width="520px"
      :close-on-click-modal="false"
    >
      <el-form label-width="100px">
        <el-form-item label="名录属名" required>
          <el-input v-model="taxonForm.genus" placeholder="如：鹿角珊瑚属" maxlength="30" />
        </el-form-item>
        <el-form-item label="拉丁学名">
          <el-input v-model="taxonForm.latinName" placeholder="如：Acropora" maxlength="60" />
        </el-form-item>
        <el-form-item label="状态" required>
          <el-radio-group v-model="taxonForm.status">
            <el-radio-button v-for="status in TAXON_STATUSES" :key="status" :value="status">{{ status }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="taxonForm.note" placeholder="拆分合并依据、来源文献等" maxlength="120" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="taxonDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="taxonSubmitting" @click="submitTaxon">
          {{ taxonEditingId ? '保存修改' : '新增条目' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="revisionDialogVisible" title="名录室定名" width="520px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="名录定名">
          <el-select v-model="revisionTarget" filterable allow-create clearable placeholder="选择或输入名录属名" style="width: 100%">
            <el-option v-for="genus in catalogStore.acceptedGenera" :key="genus" :label="genus" :value="genus" />
          </el-select>
          <p class="gb-hint">定名须是有效名录属名才能发布成功；留空发布会失败，可修正后重试。</p>
        </el-form-item>
        <el-form-item label="处理说明">
          <el-input v-model="revisionNote" placeholder="如：并入某属 / 拆出某属" maxlength="120" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="revisionDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitRevision">保存定名</el-button>
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
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__reconcile {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page__reconcile-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.page__sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  color: #4c6663;
}

.page__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: auto;
  padding: 4px 8px;
}

.page__latin {
  font-style: italic;
  color: #4c6663;
}
</style>
