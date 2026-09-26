<template>
  <div class="bg-view">
    <!-- 顶部概览 + 视角切换 -->
    <div class="bg-hero">
      <div class="hero-stats">
        <div class="hs-item">
          <span class="hs-num total">¥{{ money(stats.budgetTotal) }}</span>
          <span class="hs-lab">生效中预算总额</span>
        </div>
        <div class="hs-item">
          <span class="hs-num used">¥{{ money(stats.budgetUsed) }}</span>
          <span class="hs-lab">实时净占用（占用+实支−冲销）</span>
        </div>
        <div class="hs-item">
          <span class="hs-num hold">¥{{ money(stats.budgetHold) }}</span>
          <span class="hs-lab">占用中（冻结/在途）</span>
        </div>
        <div class="hs-item">
          <span class="hs-num actual">¥{{ money(stats.budgetActual) }}</span>
          <span class="hs-lab">实际支出累计</span>
        </div>
        <div class="hs-item">
          <span class="hs-num warn">{{ stats.budgetReviewing + stats.budgetAdjustPending }}</span>
          <span class="hs-lab">财务待审批（预算/调整）</span>
        </div>
        <div class="hs-item">
          <span class="hs-num" :class="stats.budgetOver ? 'bad' : 'ok'">{{ stats.budgetOver }}</span>
          <span class="hs-lab">超限预算</span>
        </div>
      </div>
      <div class="role-box">
        <span class="role-tip">当前视角</span>
        <div class="role-switch">
          <button :class="{ active: store.role === 'user' }" @click="store.setRole('user')">👤 用户（只读）</button>
          <button :class="{ active: store.role === 'operator' }" @click="store.setRole('operator')">💹 运营/财务</button>
        </div>
      </div>
    </div>

    <!-- 预算执行总览 -->
    <div class="card">
      <div class="card-title">
        💹 预算执行总览（{{ store.activeTenant.shortName }}）
        <span class="title-sub">活动成本优先占用活动预算，其余/无活动预算时回退租户总预算</span>
        <button v-if="canSet" class="btn-primary sm new-btn" @click="openCreate('tenant')">➕ 编制租户预算</button>
        <button v-if="canSet" class="btn-ghost sm new-btn" @click="openCreate('activity')">🎡 编制活动预算</button>
      </div>
      <p class="op-hint">
        口径：占用 = 占用中（风控冻结/在途）+ 实际支出 − 冲销（撤销/退款/采购转结算）；采购入库按合格量×协议价占用，供应商结算时等额转为付款占用（不重复）。
        预警阈值 {{ warnPct }}%，超限{{ setting.enforceHard ? '硬控拦截采购入库/供应商结算' : '仅预警不拦截' }}（1 积分 = {{ setting.pointRate }} 元）。
      </p>
      <p v-if="!isOp" class="op-hint view-only-hint">🔒 消费者视角仅可只读查看预算执行与成本台账；预算编制/调整/审批需运营或财务角色。</p>
      <div v-if="views.length === 0" class="empty">暂无生效预算，可由具备「编制预算」权限的成员编制并提交财务审批</div>
      <div v-for="v in views" :key="v.budget.id" class="budget-card" :class="v.state">
        <div class="bc-head">
          <span class="bc-icon">{{ BUDGET_SCOPE[v.budget.scope].icon }}</span>
          <div class="bc-main">
            <div class="bc-title">
              {{ v.budget.title }}
              <em>{{ v.budget.budgetNo }}</em>
              <span class="bc-scope">{{ BUDGET_SCOPE[v.budget.scope].label }}</span>
              <span v-if="v.budget.activityName" class="bc-act">🎡 {{ v.budget.activityName }}</span>
            </div>
            <div class="bc-sub">周期 {{ v.budget.periodStart }} ~ {{ v.budget.periodEnd }} · 编制人 {{ v.budget.applicant }} · v{{ v.budget.version }}</div>
          </div>
          <span class="bc-status" :class="v.budget.status">{{ BUDGET_STATUS[v.budget.status].label }}</span>
        </div>

        <div class="bc-progress-box">
          <div class="bc-bar">
            <div class="bc-fill" :class="v.state" :style="{ width: Math.min(100, v.percent) + '%' }"></div>
            <span v-if="v.percent >= 100" class="bc-over-mark">超支 {{ money(v.used - v.budget.amount) }} 元</span>
          </div>
          <div class="bc-nums">
            <span>已占用 <b :class="v.state">{{ money(v.used) }}</b> / 预算 <b>{{ money(v.budget.amount) }}</b></span>
            <span>占用中 <b class="warn">{{ money(v.hold) }}</b></span>
            <span>实际支出 <b class="ok">{{ money(v.actual) }}</b></span>
            <span>结余 <b>{{ money(v.remain) }}</b></span>
            <span class="bc-pct" :class="v.state">{{ v.percent }}%</span>
          </div>
        </div>

        <div class="bc-types">
          <span v-for="(amt, t) in v.byType" :key="t" class="bt-chip" :class="t">
            {{ BUDGET_COST_TYPES[t].icon }} {{ BUDGET_COST_TYPES[t].label }} <b>¥{{ money(amt) }}</b>
          </span>
        </div>

        <div v-if="v.budget.status === 'reviewing'" class="bc-review-tip">⏳ 待财务审批通过后生效</div>
        <div class="bc-actions">
          <button v-if="v.budget.status === 'active' && canSet" class="btn-ghost sm" @click="openAdjust(v.budget, 'increase')">📈 申请追加</button>
          <button v-if="v.budget.status === 'active' && canSet" class="btn-ghost sm" @click="openAdjust(v.budget, 'decrease')">📉 申请追减</button>
          <button v-if="v.budget.status === 'active' && canSet" class="btn-reject sm" @click="openAdjust(v.budget, 'freeze')">⛔ 申请封停</button>
          <button v-if="v.budget.status === 'active' && (canSet || canApprove)" class="btn-ghost sm" @click="closeB(v.budget)">📦 周期封存</button>
          <button class="btn-ghost sm" @click="toggleLedger(v.budget.id)">🧾 占用台账（{{ countLedger(v.budget.id) }}）</button>
        </div>

        <!-- 占用台账明细 -->
        <div v-if="openLedgerId === v.budget.id" class="ledger-box">
          <div v-if="ledgerOf(v.budget.id).length === 0" class="empty sm-empty">该预算暂无占用分录</div>
          <div v-for="e in ledgerOf(v.budget.id)" :key="e.id" class="le-row" :class="e.status">
            <span class="le-icon">{{ BUDGET_COST_TYPES[e.costType].icon }}</span>
            <div class="le-main">
              <span class="le-name">{{ e.targetName }}</span>
              <span class="le-meta">{{ e.date }} {{ e.time }} · {{ BUDGET_COST_TYPES[e.costType].label }} · {{ e.note }}</span>
            </div>
            <span class="le-status" :class="e.status">{{ BUDGET_ENTRY_STATUS[e.status].label }}</span>
            <span class="le-amt" :class="e.status">{{ e.signedAmount > 0 ? '+' : '' }}{{ money(e.signedAmount) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 财务审批队列 -->
    <div class="card" v-if="isOp">
      <div class="card-title">🧾 财务审批队列 <span class="title-sub">预算编制/调整三权分立：运营编制申请 → 财务审批生效</span></div>
      <div v-if="pendingReviews.length === 0 && pendingAdjusts.length === 0" class="empty">暂无待审批预算事项</div>

      <!-- 待审批预算 -->
      <div v-for="b in pendingReviews" :key="b.id" class="review-row">
        <span class="rr-type budget">{{ BUDGET_SCOPE[b.scope].icon }} 预算审批</span>
        <div class="rr-main">
          <div class="rr-name">{{ b.title }} <em>{{ b.budgetNo }}</em></div>
          <div class="rr-sub">{{ b.periodStart }} ~ {{ b.periodEnd }} · 金额 <b>¥{{ money(b.amount) }}</b> · 预警 {{ Math.round(b.warnRatio * 100) }}% · {{ b.applicant }} 提交</div>
          <div v-if="b.note" class="rr-note">📝 {{ b.note }}</div>
        </div>
        <div class="rr-actions" v-if="canApprove">
          <button class="btn-approve sm" @click="reviewB(b, true)">✅ 审批通过</button>
          <button class="btn-reject sm" @click="reviewB(b, false)">🚫 驳回</button>
        </div>
      </div>

      <!-- 待审批调整 -->
      <div v-for="a in pendingAdjusts" :key="a.id" class="review-row adjust">
        <span class="rr-type" :class="a.type">{{ BUDGET_ADJUST_TYPES[a.type].icon }} {{ BUDGET_ADJUST_TYPES[a.type].label }}</span>
        <div class="rr-main">
          <div class="rr-name">{{ a.budgetTitle }} <em>{{ a.adjNo }}</em></div>
          <div class="rr-sub">
            <template v-if="a.type !== 'freeze'">¥{{ money(a.amountBefore) }} → <b>¥{{ money(a.amountAfter) }}</b>（{{ a.delta > 0 ? '+' : '' }}{{ money(a.delta) }}）· </template>
            {{ a.applicant }} 申请
          </div>
          <div class="rr-note">📝 {{ a.reason }}</div>
        </div>
        <div class="rr-actions" v-if="canApprove">
          <button class="btn-approve sm" @click="reviewA(a, true)">✅ 通过</button>
          <button class="btn-reject sm" @click="reviewA(a, false)">🚫 驳回</button>
        </div>
      </div>
    </div>

    <!-- 全部预算单（含草稿/驳回/封存） -->
    <div class="card">
      <div class="card-title">
        🗂️ 预算单与调整记录
        <div class="filters">
          <button v-for="f in filters" :key="f.key" :class="{ active: filter === f.key }" @click="filter = f.key">
            {{ f.label }}<em>（{{ countOf(f.key) }}）</em>
          </button>
        </div>
      </div>
      <div v-if="visibleBudgets.length === 0" class="empty">暂无相关预算单</div>
      <div v-for="b in visibleBudgets" :key="b.id" class="mini-budget">
        <span class="mb-icon">{{ BUDGET_SCOPE[b.scope].icon }}</span>
        <div class="mb-main">
          <span class="mb-title">{{ b.title }} <em>{{ b.budgetNo }}</em>
            <span class="mb-status" :class="b.status">{{ BUDGET_STATUS[b.status].label }}</span>
          </span>
          <span class="mb-sub">¥{{ money(b.amount) }} · {{ b.periodStart }} ~ {{ b.periodEnd }} · {{ b.applicant }} · v{{ b.version }}
            <template v-if="b.reviewer"> · 财务 {{ b.reviewer }} {{ b.reviewNote ? '（' + b.reviewNote + '）' : '' }}</template>
          </span>
        </div>
        <div class="mb-actions">
          <button v-if="['draft', 'rejected'].includes(b.status) && canSet" class="btn-primary sm" @click="resubmit(b)">📮 提交审批</button>
        </div>
      </div>
    </div>

    <!-- 成本占用流水（全租户最新） -->
    <div class="card">
      <div class="card-title">
        🧾 成本占用台账（实时，append-only）
        <div class="filters">
          <button v-for="f in typeFilters" :key="f.key" :class="{ active: typeFilter === f.key }" @click="typeFilter = f.key">
            {{ f.label }}<em v-if="f.key !== 'all'">（{{ countType(f.key) }}）</em>
          </button>
        </div>
      </div>
      <p class="op-hint">四类成本实时占用：🎡 抽奖成本（积分折现）、🪙 积分奖励（中奖/任务发放折现）、🎁 兑换权益（实物/券标准成本）、🛒 采购入库（合格量×协议价）、💰 供应商结算（实付，等额冲销采购占用）。</p>
      <div v-if="visibleLedger.length === 0" class="empty">暂无占用分录</div>
      <div class="ledger-list">
        <div v-for="e in visibleLedger.slice(0, 60)" :key="e.id" class="le-row" :class="e.status">
          <span class="le-icon">{{ BUDGET_COST_TYPES[e.costType].icon }}</span>
          <div class="le-main">
            <span class="le-name">
              {{ e.targetName }}
              <em class="le-biz">{{ e.bizNo }}</em>
              <span v-if="e.budgetId === activeTenantBudgetId" class="le-scope">租户总预算</span>
            </span>
            <span class="le-meta">{{ e.date }} {{ e.time }} · {{ BUDGET_COST_TYPES[e.costType].label }} · {{ e.note }}</span>
          </div>
          <span class="le-status" :class="e.status">{{ BUDGET_ENTRY_STATUS[e.status].label }}</span>
          <span class="le-amt" :class="e.status">{{ e.signedAmount > 0 ? '+' : '' }}¥{{ money(e.signedAmount) }}</span>
        </div>
      </div>
    </div>

    <!-- 预算参数设置 -->
    <div class="card" v-if="isOp && canSet">
      <div class="card-title">⚙️ 预算参数（{{ store.activeTenant.shortName }}）</div>
      <div class="setting-row">
        <label>积分折现单价（元/积分）</label>
        <input v-model.number="settingForm.pointRate" type="number" step="0.01" min="0" />
        <label class="hard-lab"><input type="checkbox" v-model="settingForm.enforceHard" /> 超限硬控（关闭则仅预警不拦截运营支出）</label>
        <button class="btn-primary sm" @click="saveSetting">保存参数</button>
      </div>
      <div class="costmap-box">
        <div class="cm-title">权益标准成本映射（抽奖奖品/商城商品的成本价，元；占用"兑换/中奖权益"预算口径）</div>
        <div class="cm-list">
          <label v-for="row in costMapRows" :key="row.key" class="cm-item">
            <span>{{ row.icon }} {{ row.name }}</span>
            <input v-model.number="settingCostMap[row.key]" type="number" step="0.1" min="0" placeholder="0 = 不占预算" />
          </label>
        </div>
        <button class="btn-ghost sm" @click="saveCostMap">保存标准成本</button>
      </div>
    </div>

    <!-- 编制预算表单 -->
    <div v-if="createForm" class="card form-card">
      <div class="card-title">💹 编制{{ createForm.scope === 'tenant' ? '租户总预算' : '活动预算' }}</div>
      <div class="form-grid">
        <div class="form-row" v-if="createForm.scope === 'activity'">
          <label>归属活动</label>
          <select v-model="createForm.activityId">
            <option value="">请选择活动</option>
            <option v-for="a in tenantActivities" :key="a.id" :value="a.id">{{ a.icon }} {{ a.name }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>预算金额（元）</label>
          <input v-model.number="createForm.amount" type="number" min="1" placeholder="如 10000" />
        </div>
        <div class="form-row">
          <label>周期起</label>
          <input v-model="createForm.periodStart" type="date" />
        </div>
        <div class="form-row">
          <label>周期止</label>
          <input v-model="createForm.periodEnd" type="date" />
        </div>
        <div class="form-row">
          <label>预警阈值</label>
          <select v-model.number="createForm.warnRatio">
            <option :value="0.7">70%</option>
            <option :value="0.8">80%</option>
            <option :value="0.9">90%</option>
            <option :value="1">100%</option>
          </select>
        </div>
        <div class="form-row">
          <label>超限硬控</label>
          <input type="checkbox" v-model="createForm.enforceHard" />
          <span class="hint">关闭后采购/结算仅预警不拦截</span>
        </div>
        <div class="form-row full">
          <label>预算名称/事由</label>
          <input v-model="createForm.title" placeholder="可留空，按层级+周期自动生成" />
        </div>
        <div class="form-row full">
          <label>备注</label>
          <input v-model="createForm.note" placeholder="可选：预算说明" />
        </div>
      </div>
      <div v-if="createPreview" class="preview-line" :class="{ over: createPreview.over, warn: createPreview.warn }">
        {{ createPreview.noBudget ? '当前同层级无生效预算，审批后新成本将占用本预算' :
          `提交审批通过后：当前占用 ¥${money(createPreview.used)}，本预算 ¥${money(createPreview.budget.amount)}，结余 ¥${money(createPreview.remain)}` }}
      </div>
      <div class="form-actions">
        <button class="btn-ghost" @click="createForm = null">取消</button>
        <button class="btn-ghost" @click="submitCreate(false)">💾 存草稿</button>
        <button class="btn-primary" @click="submitCreate(true)">📮 提交财务审批</button>
      </div>
    </div>

    <!-- 调整申请表单 -->
    <div v-if="adjustForm" class="card form-card">
      <div class="card-title">{{ BUDGET_ADJUST_TYPES[adjustForm.type].icon }} 预算调整申请 · {{ adjustForm.budget.title }}</div>
      <div class="form-grid">
        <div class="form-row" v-if="adjustForm.type !== 'freeze'">
          <label>{{ adjustForm.type === 'increase' ? '追加金额（元）' : '追减金额（元）' }}</label>
          <input v-model.number="adjustForm.delta" type="number" min="0.01" />
        </div>
        <div class="form-row" v-if="adjustForm.type !== 'freeze'">
          <label>调整后预算</label>
          <b class="after-amt">¥{{ money(adjustAfter) }}</b>
        </div>
        <div class="form-row full">
          <label>调整事由</label>
          <input v-model="adjustForm.reason" placeholder="必填：如国庆加码追加、活动下线追减" />
        </div>
      </div>
      <div class="form-actions">
        <button class="btn-ghost" @click="adjustForm = null">取消</button>
        <button class="btn-primary" @click="submitAdjust">📮 提交财务审批</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { usePlatformStore, BUDGET_SCOPE, BUDGET_STATUS, BUDGET_ADJUST_TYPES, BUDGET_COST_TYPES, BUDGET_ENTRY_STATUS } from '@/store/platform'

const store = usePlatformStore()
const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2)

const isOp = computed(() => store.role === 'operator')
const canSet = computed(() => isOp.value && store.can('budget:set'))
const canApprove = computed(() => isOp.value && store.can('budget:approve'))

const stats = computed(() => store.dashboard)
const setting = computed(() => store.budgetSettingOf())
const warnPct = computed(() => Math.round((setting.value.warnRatio || 0.8) * 100))
const views = computed(() => store.budgetViews)
const activeTenantBudgetId = computed(() => store.activeTenantBudget?.id || '')

// —— 台账展开 ——
const openLedgerId = ref('')
const toggleLedger = (id) => { openLedgerId.value = openLedgerId.value === id ? '' : id }
const ledgerOf = (budgetId) => [...store.budgetLedger].filter((e) => e.budgetId === budgetId).sort((a, b) => b.ts - a.ts)
const countLedger = (budgetId) => store.budgetLedger.filter((e) => e.budgetId === budgetId).length

// —— 审批队列 ——
const pendingReviews = computed(() => store.scopedBudgets.filter((b) => b.status === 'reviewing'))
const pendingAdjusts = computed(() => store.scopedBudgetAdjusts.filter((a) => a.status === 'pending'))
function reviewB(b, ok) {
  store.reviewBudget(b.id, ok, ok ? '额度合理，同意下达' : '请核减额度或补充投放计划后重提')
}
function reviewA(a, ok) {
  store.reviewBudgetAdjust(a.id, ok, ok ? '同意预算调整' : '调整理由不充分，请补充材料')
}
function closeB(b) {
  if (confirm(`确认封存预算【${b.title}】？封存后不再接受新的成本占用`)) store.closeBudget(b.id)
}

// —— 预算单列表 ——
const filters = [
  { key: 'active', label: '生效中' },
  { key: 'reviewing', label: '审批中' },
  { key: 'draft', label: '草稿' },
  { key: 'rejected', label: '已驳回' },
  { key: 'closed', label: '已封存' },
  { key: 'all', label: '全部' }
]
const filter = ref('active')
const visibleBudgets = computed(() => store.scopedBudgets.filter((b) => filter.value === 'all' || b.status === filter.value))
const countOf = (k) => store.scopedBudgets.filter((b) => k === 'all' || b.status === k).length
function resubmit(b) { store.submitBudget(b.id) }

// —— 全租户台账流水 ——
const typeFilters = [
  { key: 'all', label: '全部' },
  { key: 'draw', label: '🎡 抽奖成本' },
  { key: 'points', label: '🪙 积分奖励' },
  { key: 'exchange', label: '🎁 兑换权益' },
  { key: 'purchase', label: '🛒 采购入库' },
  { key: 'settle', label: '💰 供应商结算' }
]
const typeFilter = ref('all')
const visibleLedger = computed(() =>
  store.scopedBudgetLedger.filter((e) => typeFilter.value === 'all' || e.costType === typeFilter.value))
const countType = (k) => store.scopedBudgetLedger.filter((e) => e.costType === k).length

// —— 编制预算 ——
const tenantActivities = computed(() => store.activities.filter((a) => a.tenantId === store.activeTenantId))
const createForm = ref(null)
const today = () => {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function openCreate(scope) {
  createForm.value = {
    scope, activityId: scope === 'activity' ? tenantActivities.value[0]?.id || '' : '',
    amount: null, periodStart: today(), periodEnd: today(),
    warnRatio: 0.8, enforceHard: setting.value.enforceHard, title: '', note: ''
  }
  adjustForm.value = null
}
const createPreview = computed(() => {
  if (!createForm.value || !(createForm.value.amount > 0)) return null
  return store.previewBudgetCharge({
    tenantId: store.activeTenantId,
    activityId: createForm.value.scope === 'activity' ? createForm.value.activityId : null,
    amount: createForm.value.amount
  })
})
function submitCreate(submit) {
  const f = createForm.value
  const b = store.createBudget({ ...f, submit })
  if (b) createForm.value = null
}

// —— 调整申请 ——
const adjustForm = ref(null)
function openAdjust(budget, type) {
  adjustForm.value = { budget, type, delta: null, reason: '' }
  createForm.value = null
}
const adjustAfter = computed(() => {
  if (!adjustForm.value || adjustForm.value.type === 'freeze') return adjustForm.value?.budget.amount || 0
  const d = Number(adjustForm.value.delta) || 0
  const base = adjustForm.value.budget.amount
  return adjustForm.value.type === 'increase' ? base + d : Math.max(0, base - d)
})
function submitAdjust() {
  const f = adjustForm.value
  const a = store.requestBudgetAdjust(f.budget.id, { type: f.type, delta: f.delta, reason: f.reason })
  if (a) adjustForm.value = null
}

// —— 参数设置 ——
const settingForm = reactive({ pointRate: setting.value.pointRate, enforceHard: setting.value.enforceHard })
const settingCostMap = reactive({ ...(setting.value.costMap || {}) })
function saveSetting() {
  if (store.updateBudgetSetting({ pointRate: settingForm.pointRate, enforceHard: settingForm.enforceHard })) {
    settingForm.pointRate = store.budgetSettingOf().pointRate
    settingForm.enforceHard = store.budgetSettingOf().enforceHard
  }
}
function saveCostMap() {
  store.updateBudgetSetting({ costMap: settingCostMap })
}
// 全部奖品/商品成本映射行（仅当前租户）
const costMapRows = computed(() => {
  const rows = []
  store.activities.filter((a) => a.tenantId === store.activeTenantId).forEach((a) => {
    a.prizes.filter((p) => p.rarity !== 'none' && !p.name.includes('积分')).forEach((p) => {
      rows.push({ key: `prize:${a.id}:${p.id}`, name: `${a.name} / ${p.name}`, icon: p.emoji })
    })
  })
  store.goods.filter((g) => (g.tenantId || 't-star') === store.activeTenantId).forEach((g) => {
    rows.push({ key: `goods:${g.id}`, name: g.name, icon: g.icon })
  })
  return rows
})
</script>

<style scoped>
.bg-view { display: flex; flex-direction: column; gap: 16px; max-width: 1120px; margin: 0 auto; }
.bg-hero {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  background: linear-gradient(135deg, #2a1a4a, #162b55);
  border: 1px solid rgba(171,71,188,0.3); border-radius: 14px; padding: 18px 22px; flex-wrap: wrap;
}
.hero-stats { display: flex; gap: 24px; flex-wrap: wrap; }
.hs-item { display: flex; flex-direction: column; }
.hs-num { font-size: 22px; font-weight: 800; line-height: 1; }
.hs-num.total { color: #ce93d8; }
.hs-num.used { color: #ffd54f; }
.hs-num.hold { color: #ffb74d; }
.hs-num.actual { color: #7ef0c9; }
.hs-num.warn { color: #82b1ff; }
.hs-num.bad { color: #ef5350; }
.hs-num.ok { color: #7ef0c9; }
.hs-lab { font-size: 11px; color: #9db0d0; margin-top: 5px; }
.role-box { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.role-tip { font-size: 11px; color: #9db0d0; }
.role-switch { display: flex; background: rgba(0,0,0,0.25); border-radius: 10px; padding: 3px; }
.role-switch button {
  background: transparent; border: none; color: #aebadd; font-size: 12px;
  padding: 7px 14px; border-radius: 8px; cursor: pointer;
}
.role-switch button.active { background: linear-gradient(135deg,#8e24aa,#2962ff); color: #fff; }

.card { background: #0f1b38; border: 1px solid rgba(120,160,220,0.16); border-radius: 14px; padding: 16px; }
.card-title {
  font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 12px;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.title-sub { font-size: 11px; font-weight: 400; color: #7e97c2; }
.new-btn { margin-left: auto; }
.new-btn + .new-btn { margin-left: 0; }
.op-hint { font-size: 11px; color: #6f84ab; margin: 0 0 12px; line-height: 1.6; }
.view-only-hint { color: #ffb74d; }
.empty { color: #5b6f94; text-align: center; padding: 22px; font-size: 12px; }
.sm-empty { padding: 10px; }

/* 预算卡片 */
.budget-card {
  background: rgba(20,34,66,0.5); border: 1px solid rgba(120,160,220,0.14);
  border-left: 3px solid #7ef0c9; border-radius: 10px; padding: 13px 14px; margin-bottom: 12px;
}
.budget-card.warn { border-left-color: #ffb74d; }
.budget-card.over { border-left-color: #ef5350; }
.budget-card.closed, .budget-card.reviewing { border-left-color: #82b1ff; }
.bc-head { display: flex; align-items: flex-start; gap: 10px; }
.bc-icon { font-size: 22px; }
.bc-main { flex: 1; min-width: 0; }
.bc-title { font-size: 13.5px; font-weight: 700; color: #eef3fc; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.bc-title em { font-style: normal; font-size: 10px; color: #ce93d8; font-weight: 400; }
.bc-scope, .bc-act { font-size: 10px; padding: 1px 8px; border-radius: 6px; background: rgba(130,177,255,0.15); color: #82b1ff; font-weight: 400; }
.bc-act { background: rgba(126,240,201,0.12); color: #7ef0c9; }
.bc-sub { font-size: 10.5px; color: #6f84ab; margin-top: 3px; }
.bc-status { font-size: 11px; padding: 3px 10px; border-radius: 6px; font-weight: 600; flex-shrink: 0; }
.bc-status.active { background: rgba(126,240,201,0.18); color: #7ef0c9; }
.bc-status.reviewing { background: rgba(255,183,77,0.18); color: #ffb74d; }
.bc-status.closed { background: rgba(111,132,171,0.2); color: #aebadd; }
.bc-status.draft { background: rgba(111,132,171,0.2); color: #aebadd; }
.bc-status.rejected { background: rgba(229,115,115,0.18); color: #ef9a9a; }

.bc-progress-box { margin-top: 11px; }
.bc-bar {
  position: relative; height: 14px; border-radius: 7px; background: #0c1730;
  border: 1px solid rgba(120,160,220,0.2); overflow: hidden;
}
.bc-fill { height: 100%; border-radius: 7px; background: linear-gradient(90deg,#26a69a,#66bb6a); transition: width .3s; }
.bc-fill.warn { background: linear-gradient(90deg,#fb8c00,#fdd835); }
.bc-fill.over { background: linear-gradient(90deg,#e53935,#ef5350); }
.bc-fill.closed { background: #546e7a; }
.bc-over-mark {
  position: absolute; right: 8px; top: -1px; font-size: 10px; color: #fff; font-weight: 700; line-height: 14px;
}
.bc-nums { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 7px; font-size: 11px; color: #aebadd; }
.bc-nums b { color: #dbe4f3; font-weight: 700; }
.bc-nums b.warn { color: #ffb74d; }
.bc-nums b.ok { color: #7ef0c9; }
.bc-nums b.over, .bc-pct.over { color: #ef5350; }
.bc-pct { margin-left: auto; font-weight: 800; color: #ce93d8; }
.bc-pct.warn { color: #ffb74d; }

.bc-types { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 9px; }
.bt-chip {
  font-size: 10.5px; padding: 3px 10px; border-radius: 7px;
  background: rgba(120,160,220,0.08); border: 1px solid rgba(120,160,220,0.16); color: #aebadd;
}
.bt-chip b { color: #dbe4f3; margin-left: 2px; }
.bt-chip.draw { border-color: rgba(130,177,255,0.3); }
.bt-chip.points { border-color: rgba(126,240,201,0.3); }
.bt-chip.exchange { border-color: rgba(206,147,216,0.35); }
.bt-chip.purchase { border-color: rgba(255,183,77,0.3); }
.bt-chip.settle { border-color: rgba(255,213,79,0.35); }

.bc-review-tip { margin-top: 9px; font-size: 11px; color: #ffcc80; }
.bc-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }

/* 审批行 */
.review-row {
  display: flex; align-items: flex-start; gap: 12px; padding: 11px 12px;
  background: rgba(20,34,66,0.5); border: 1px solid rgba(120,160,220,0.12);
  border-left: 3px solid #ffb74d; border-radius: 10px; margin-bottom: 9px;
}
.review-row.adjust { border-left-color: #ab47bc; }
.rr-type {
  font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 7px;
  background: rgba(255,183,77,0.16); color: #ffb74d; white-space: nowrap;
}
.rr-type.budget { background: rgba(130,177,255,0.16); color: #82b1ff; }
.rr-type.increase { background: rgba(126,240,201,0.16); color: #7ef0c9; }
.rr-type.decrease { background: rgba(255,183,77,0.16); color: #ffb74d; }
.rr-type.freeze { background: rgba(229,83,80,0.16); color: #ef5350; }
.rr-main { flex: 1; min-width: 0; }
.rr-name { font-size: 13px; color: #eef3fc; font-weight: 700; }
.rr-name em { font-style: normal; font-size: 10px; color: #ce93d8; font-weight: 400; margin-left: 6px; }
.rr-sub { font-size: 11px; color: #aebadd; margin-top: 3px; }
.rr-sub b { color: #ffd54f; }
.rr-note { font-size: 11px; color: #8ba2c8; margin-top: 3px; }
.rr-actions { display: flex; gap: 6px; flex-shrink: 0; }

/* mini budget */
.mini-budget { display: flex; gap: 10px; align-items: center; padding: 9px 4px; border-bottom: 1px dashed rgba(120,160,220,0.12); }
.mb-icon { font-size: 18px; }
.mb-main { flex: 1; min-width: 0; }
.mb-title { font-size: 12.5px; color: #dbe4f3; display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
.mb-title em { font-style: normal; font-size: 10px; color: #8ba2c8; }
.mb-sub { display: block; font-size: 10.5px; color: #6f84ab; margin-top: 2px; }
.mb-status { font-size: 10px; padding: 1px 7px; border-radius: 5px; background: rgba(130,177,255,0.15); color: #82b1ff; }
.mb-status.active { background: rgba(126,240,201,0.15); color: #7ef0c9; }
.mb-status.closed, .mb-status.draft { background: rgba(111,132,171,0.2); color: #aebadd; }
.mb-status.rejected { background: rgba(229,115,115,0.18); color: #ef9a9a; }
.mb-status.reviewing { background: rgba(255,183,77,0.18); color: #ffb74d; }

/* 台账 */
.ledger-box {
  margin-top: 10px; border-top: 1px dashed rgba(120,160,220,0.2); padding-top: 8px;
  max-height: 280px; overflow-y: auto;
}
.ledger-list { max-height: 460px; overflow-y: auto; }
.le-row { display: flex; align-items: flex-start; gap: 9px; padding: 7px 4px; border-bottom: 1px dashed rgba(120,160,220,0.1); }
.le-icon { font-size: 15px; margin-top: 1px; }
.le-main { flex: 1; min-width: 0; }
.le-name { font-size: 12px; color: #dbe4f3; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.le-name em { font-style: normal; font-size: 9.5px; color: #8ba2c8; }
.le-scope { font-size: 9px; color: #82b1ff; background: rgba(130,177,255,0.1); padding: 0 6px; border-radius: 5px; }
.le-meta { display: block; font-size: 10px; color: #6f84ab; margin-top: 2px; line-height: 1.5; }
.le-status { font-size: 10px; padding: 2px 7px; border-radius: 5px; white-space: nowrap; }
.le-status.hold { background: rgba(255,183,77,0.16); color: #ffb74d; }
.le-status.actual { background: rgba(126,240,201,0.15); color: #7ef0c9; }
.le-status.reverse { background: rgba(111,132,171,0.2); color: #aebadd; }
.le-amt { font-size: 12px; font-weight: 700; min-width: 84px; text-align: right; }
.le-amt.hold { color: #ffb74d; }
.le-amt.actual { color: #7ef0c9; }
.le-amt.reverse { color: #8ba2c8; }

/* 设置 */
.setting-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12px; color: #aebadd; }
.setting-row input[type="number"] { width: 110px; background: #0c1730; border: 1px solid rgba(120,160,220,0.2); color: #dbe4f3; border-radius: 8px; padding: 7px 10px; }
.hard-lab { display: flex; align-items: center; gap: 5px; }
.costmap-box { margin-top: 14px; border-top: 1px dashed rgba(120,160,220,0.2); padding-top: 12px; }
.cm-title { font-size: 11px; color: #7e97c2; margin-bottom: 9px; }
.cm-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; margin-bottom: 10px; }
.cm-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11.5px; color: #aebadd; background: rgba(120,160,220,0.06); padding: 6px 10px; border-radius: 8px; }
.cm-item input { width: 90px; background: #0c1730; border: 1px solid rgba(120,160,220,0.2); color: #dbe4f3; border-radius: 7px; padding: 5px 8px; font-size: 11px; }

/* 表单 */
.form-card { border-color: rgba(171,71,188,0.35); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px; margin-bottom: 10px; }
.form-row { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.form-row.full { grid-column: 1 / -1; }
.form-row label { width: 92px; color: #8ba2c8; flex-shrink: 0; }
.form-row input[type="text"], .form-row input[type="number"], .form-row input[type="date"], .form-row select, .form-row input:not([type]) {
  flex: 1; background: #0c1730; border: 1px solid rgba(120,160,220,0.2); color: #dbe4f3;
  border-radius: 8px; padding: 8px 11px; font-size: 12px;
}
.form-row input[type="checkbox"] { width: auto; flex: none; }
.form-row .hint { font-size: 10.5px; color: #6f84ab; }
.after-amt { color: #ffd54f; font-size: 14px; }
.preview-line { font-size: 11.5px; color: #82b1ff; background: rgba(130,177,255,0.08); border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; }
.preview-line.warn { color: #ffb74d; background: rgba(255,183,77,0.08); }
.preview-line.over { color: #ef9a9a; background: rgba(229,83,80,0.08); }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; }

.filters { display: flex; gap: 5px; margin-left: auto; flex-wrap: wrap; }
.filters button {
  background: #13233f; border: 1px solid rgba(120,160,220,0.18); color: #8ba2c8;
  font-size: 11px; padding: 5px 10px; border-radius: 7px; cursor: pointer;
}
.filters button.active { background: #8e24aa; color: #fff; border-color: transparent; }
.filters em { font-style: normal; opacity: 0.8; }

.btn-primary {
  background: linear-gradient(135deg,#8e24aa,#6a1b9a); color: #fff; border: none;
  border-radius: 8px; padding: 8px 16px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.btn-primary.sm { padding: 6px 13px; }
.btn-ghost {
  background: transparent; border: 1px solid rgba(120,160,220,0.35); color: #aebadd;
  border-radius: 8px; padding: 7px 14px; font-size: 12px; cursor: pointer;
}
.btn-ghost.sm { padding: 6px 12px; }
.btn-approve {
  background: linear-gradient(135deg,#66bb6a,#43a047); color: #fff; border: none;
  border-radius: 8px; padding: 7px 15px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.btn-approve.sm { padding: 6px 12px; }
.btn-reject {
  background: transparent; border: 1px solid rgba(229,115,115,0.5); color: #ef9a9a;
  border-radius: 8px; padding: 7px 15px; font-size: 12px; cursor: pointer;
}
.btn-reject.sm { padding: 6px 12px; }
</style>
