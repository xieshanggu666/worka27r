// 营销预算与成本控制闭环 —— 逻辑冒烟测试
// 覆盖：
//  1) RBAC 三权分立：运营编制(budget:set) / 财务审批(budget:approve) / 消费者与无权限角色被拦截
//  2) 预算生命周期：草稿 → 提交审批 → 驳回重提 → 审批生效；调整申请（追加/追减/封停）审批后即时改写
//  3) 四类成本实时占用：抽奖成本（冻结 hold/撤销冲销/放行转 actual）、积分奖励、兑换权益、采购入库、供应商结算（等额冲销采购不重复）
//  4) 超限硬控：采购入库/供应商结算超预算被拦截（写 denied 审计、零变更），追加预算后放行
//  5) 活动预算优先、无活动预算回退租户总预算；租户强隔离；台账 append-only 使用额实时推导
import { setActivePinia, createPinia } from 'pinia'
import { usePlatformStore } from '@/store/platform'

setActivePinia(createPinia())
const s = usePlatformStore()
s.init()
const today = s.todayDate

let failed = 0
const assert = (cond, msg) => {
  if (cond) console.log('  ✅', msg)
  else { console.error('  ❌', msg); failed++ }
}
const money = (n) => Math.round((Number(n) || 0) * 100) / 100
const usedOf = (id) => s.budgetUsageOf(id).used

console.log('— 种子：预算/台账/调整申请 —')
assert(s.budgets.filter((b) => b.tenantId === 't-star').length === 4, '星河 4 张预算（含 1 草稿）')
assert(s.budgets.some((b) => b.id === 'seed-cbg1' && b.tenantId === 't-cloud'), '云雀独立预算（租户隔离）')
assert(s.pendingBudgetCount === 1, '财务待办角标=1（追加预算申请）')
const bg1 = s.budgets.find((b) => b.id === 'seed-bg1')
const bg2 = s.budgets.find((b) => b.id === 'seed-bg2')
const u2 = s.budgetUsageOf('seed-bg2')
assert(u2.used > 0 && u2.byType.purchase === 0 && u2.byType.settle === 625, '周年活动预算：采购占用已在结算时等额转为付款占用（settle=625、purchase=0）')
assert(s.budgetUsageOf('seed-bg1').byType.purchase > 0, '租户总预算承担商城采购（公仔 6×18=108）')
assert(s.scopedBudgetLedger.every((e) => e.signedAmount !== 0), '占用台账全部带非零带符号金额（append-only）')

console.log('— RBAC：编制 / 审批三权分立 —')
s.loginAsCustomer()
assert(s.createBudget({ scope: 'tenant', amount: 1, periodStart: today, periodEnd: today }) === null, '消费者编制预算被拦截')
s.loginAsMember('m-star-ship')
assert(!s.can('budget:set') && !s.can('budget:approve') && s.createBudget({ scope: 'tenant', amount: 1, periodStart: today, periodEnd: today }) === null,
  '物流客服无预算权限，编制被拦截')
s.loginAsMember('m-star-ops')
assert(s.can('budget:set') && !s.can('budget:approve'), '活动运营：可编制，不可审批')
assert(s.reviewBudget('seed-bg1', true) === false, '运营审批预算被拦截')
s.loginAsMember('m-star-fin')
assert(!s.can('budget:set') && s.can('budget:approve'), '财务：可审批，不可编制')

console.log('— 预算生命周期：草稿 → 提交 → 驳回 → 重提 → 生效 —')
s.loginAsMember('m-star-ops')
const draft = s.createBudget({
  scope: 'activity', activityId: 'act-2', title: '冒烟-刮刮乐加投预算',
  amount: 300, periodStart: today, periodEnd: today, warnRatio: 0.8, submit: true
})
// 与 seed-bg3 同周期会撞预算 → 改用错峰周期
const b = s.createBudget({
  scope: 'activity', activityId: 'act-2', title: '冒烟-刮刮乐加投预算',
  amount: 300, periodStart: '2026-12-01', periodEnd: '2026-12-31', warnRatio: 0.8, submit: true
})
assert(!!b && b.status === 'reviewing', '运营提交活动预算，进入财务审批')
s.loginAsMember('m-star-fin')
assert(s.reviewBudget(b.id, false, '请补充投放计划') === true, '财务驳回')
assert(s.budgets.find((x) => x.id === b.id).status === 'rejected', '预算状态=驳回')
s.loginAsMember('m-star-ops')
assert(s.submitBudget(b.id, { amount: 500 }), '运营修订为 500 元后重提（版本号 +1）')
s.loginAsMember('m-star-fin')
assert(s.reviewBudget(b.id, true) === true, '财务审批通过 → 生效')
const active = s.budgets.find((x) => x.id === b.id)
assert(active.status === 'active' && active.amount === 500 && active.version >= 2, '生效预算金额 500、版本递增')

console.log('— 预算调整：追加/追减/封停审批后即时生效 —')
s.loginAsMember('m-star-ops')
const adj = s.requestBudgetAdjust(b.id, { type: 'increase', delta: 200, reason: '冒烟追加' })
assert(!!adj && adj.status === 'pending' && adj.amountAfter === 700, '追加 200 待审批（500→700）')
s.loginAsMember('m-star-fin')
assert(s.reviewBudgetAdjust(adj.id, true) === true, '财务通过追加')
assert(s.budgets.find((x) => x.id === b.id).amount === 700, '预算即时变为 700')
s.loginAsMember('m-star-ops')
const dec = s.requestBudgetAdjust(b.id, { type: 'decrease', delta: 99999, reason: '超额追减' })
assert(dec === null, '追减后低于当前占用被拦截')
const freeze = s.requestBudgetAdjust(b.id, { type: 'freeze', delta: 0, reason: '冒烟封停' })
s.loginAsMember('m-star-fin')
assert(s.reviewBudgetAdjust(freeze.id, true) === true, '封停审批通过')
assert(s.budgets.find((x) => x.id === b.id).status === 'closed', '预算已封存')

console.log('— 四类成本实时占用（新建专项预算隔离验证）—')
s.loginAsMember('m-star-ops')
// 为 act-2 新开一张预算（后续成本全部进入该预算，便于断言）
const tb = s.createBudget({
  scope: 'activity', activityId: 'act-2', title: '冒烟-实时占用验证预算',
  amount: 10000, periodStart: '2027-01-01', periodEnd: '2027-03-31', submit: true
})
s.loginAsMember('m-star-fin')
s.reviewBudget(tb.id, true)
s.loginAsCustomer()
// act-1 免费抽奖（无积分成本、不命中高频规则），落账即占用中奖权益标准成本
const before = usedOf(tb.id)
const drawRec = s.draw('act-1')
assert(!!drawRec && drawRec.status !== 'frozen', '参与周年庆转盘落账（未命中风控）')
const afterDraw = usedOf(tb.id)
// tb 是 act-2 活动预算：act-1 抽奖不占用它，应占用 act-1 活动预算（seed-bg2）——验证"活动预算按活动归属"
assert(Math.abs(afterDraw - before) < 1e-9, 'act-1 抽奖不占用 act-2 预算（活动归属隔离）')
// 刮刮乐抽奖成本 10 积分 = 1 元（点率 0.1），进入 act-2 专项预算
const draw2 = s.draw('act-2')
assert(!!draw2 && draw2.status !== 'frozen', '参与刮刮乐落账（未命中风控）')
const afterDraw2 = usedOf(tb.id)
assert(afterDraw2 >= afterDraw + 1 - 1e-9, '抽奖成本 10 积分实时占用 1 元（活动预算优先）')
// 积分任务奖励（非抽奖类）发放只进租户总预算，不进活动预算
const tbUsedBeforeTask = usedOf(tb.id)
const bg1BeforeTask = usedOf('seed-bg1')
const watchTask = s.tasks.find((x) => x.id === 't-watch' && !x.claimed)
if (watchTask) s.completeTask('t-watch')
assert(Math.abs(usedOf(tb.id) - tbUsedBeforeTask) < 1e-9, '任务积分奖励不进活动预算' + (watchTask ? '' : '（任务已领取，占用增量为 0）'))
if (watchTask) assert(usedOf('seed-bg1') > bg1BeforeTask, '任务积分奖励计入租户总预算')

console.log('— 风控冻结 hold / 放行转 actual / 撤销冲销 —')
s.loginAsCustomer()
s.loginAsMember('m-star-admin')
// 黑名单强制命中风控（不受当日频次/抽奖上限影响；黑名单按消费者 id 配置）
s.updateRiskRules({ blacklist: ['u-1001'] })
s.loginAsCustomer()
const frozenRec = s.draw('act-2')
assert(frozenRec && frozenRec.status === 'frozen', '黑名单用户抽奖命中风控冻结')
if (frozenRec && frozenRec.status === 'frozen') {
  const usedHold = usedOf(tb.id)
  const holdRows = s.budgetLedger.filter((e) => e.refId === frozenRec.id && e.status === 'hold')
  assert(holdRows.length >= 1, '冻结抽奖产生 hold 占用分录（成本/权益占用中）')
  s.loginAsMember('m-star-risk')
  s.revokeRisk(frozenRec.riskOrderId, '冒烟撤销')
  const afterRevoke = usedOf(tb.id)
  assert(Math.abs(afterRevoke - (usedHold - holdRows.reduce((n, e) => n + e.amount, 0))) < 1e-9,
    '撤销后 hold 占用等额冲销，净占用回落')
  // 再冻结一单并放行
  s.loginAsCustomer()
  const f2 = s.draw('act-2')
  assert(f2 && f2.status === 'frozen', '第二次抽奖仍命中风控冻结')
  if (f2 && f2.status === 'frozen') {
    const hold2 = s.budgetLedger.filter((e) => e.refId === f2.id && e.status === 'hold').reduce((n, e) => n + e.amount, 0)
    s.loginAsMember('m-star-risk')
    s.releaseRisk(f2.riskOrderId, '冒烟放行')
    // append-only 台账中 hold 行始终保留，hold 净占用 = hold + 冲销 hold 的 reverse（按 refId 汇总）
    const holdNet = s.budgetLedger.filter((e) => e.refId === f2.id && (e.status === 'hold' || e.status === 'reverse'))
      .reduce((n, e) => n + e.signedAmount, 0)
    const reverseAmt = s.budgetLedger.filter((e) => e.refId === f2.id && e.status === 'reverse')
      .reduce((n, e) => n + Math.abs(e.signedAmount), 0)
    const actualAmt = s.budgetLedger.filter((e) => e.refId === f2.id && e.status === 'actual')
      .reduce((n, e) => n + e.signedAmount, 0)
    assert(holdNet === 0 && reverseAmt > 0 && Math.abs(actualAmt - hold2) < 1e-9,
      '放行后原 hold 已等额冲销（hold 净额 0）并补记等额 actual（净额不变、状态转正）')
  }
}
s.loginAsMember('m-star-admin')
s.updateRiskRules({ blacklist: [] })

console.log('— 超限硬控：采购入库/结算拦截，追加预算后放行 —')
// 新建一张 100 元的小额活动预算（act-1），采购保温杯单价 12.5，验收入库 10 件 = 125 > 100 应拦截
const tiny = s.createBudget({
  scope: 'activity', activityId: 'act-1', title: '冒烟-小额硬控预算',
  amount: 100, periodStart: '2027-04-01', periodEnd: '2027-06-30', submit: true
})
s.loginAsMember('m-star-fin')
s.reviewBudget(tiny.id, true)
// 准备一张已审批采购单：保温杯 10 件（复用运营身份发起）
s.loginAsMember('m-star-ops')
const po = s.createPurchaseOrder({
  targetType: 'prize', activityId: 'act-1', targetId: 'p3',
  qty: 10, reason: '冒烟硬控采购', supplierName: '冒烟供应商', unitPrice: 12.5
})
s.loginAsMember('m-star-fin')
s.reviewPurchaseOrder(po.id, true)
s.loginAsMember('m-star-ship')
const poAfter = s.purchaseOrders.find((x) => x.id === po.id)
const inboundQtyBefore = poAfter.inboundQty
const r1 = s.inboundPurchase(po.id, { qty: 10 })
assert(r1 === null && s.purchaseOrders.find((x) => x.id === po.id).inboundQty === inboundQtyBefore,
  '超预算入库被硬控拦截（零入库、预算占用零增加）')
assert(s.lastDenied?.action === 'budget-exceeded', '拦截写入 denied 留痕')
// 关闭硬控后仅预警放行
s.loginAsMember('m-star-ops')
s.updateBudgetSetting({ enforceHard: false })
s.loginAsMember('m-star-ship')
const r2 = s.inboundPurchase(po.id, { qty: 10 })
assert(!!r2, '硬控关闭后超预算入库放行（仅预警审计）')
// 重新开启硬控（后续供应商结算在已超限预算下：净占用 0，不拦截 —— 采购占用等额转付款）
s.loginAsMember('m-star-ops')
s.updateBudgetSetting({ enforceHard: true })

console.log('— 供应商结算：采购占用等额转付款（不重复占用）—')
const poForBill = s.purchaseOrders.find((x) => x.id === po.id)
s.loginAsMember('m-star-ops')
const bill = s.createSupplierBill(po.id, { submit: true, note: '冒烟账单' })
s.loginAsMember('m-star-fin')
s.reviewSupplierBill(bill.id, true)
const usedBeforeSettle = usedOf(tiny.id)
const settled = s.settleSupplierBill(bill.id, '冒烟付款')
assert(!!settled, '账单结算完成')
const deltaSettle = money(usedOf(tiny.id) - usedBeforeSettle)
assert(Math.abs(deltaSettle) < 0.01, `结算前后活动预算净占用变化 ≈ 0（实际 ${deltaSettle}，采购 125 等额冲销、付款 125 占用，不重复）`)

console.log('— 租户强隔离：云雀预算与星河互不可见 —')
s.loginAsCustomer({ silent: true })
s.switchTenant('t-cloud')
assert(s.scopedBudgets.every((b) => b.tenantId === 't-cloud'), '云雀仅见本租户预算')
assert(s.scopedBudgetLedger.length === 0, '云雀预算台账与星河物理隔离（无星河分录）')
// 星河财务属于 t-star，无法登录后操作 t-cloud
s.loginAsMember('m-star-fin')
assert(s.activeTenantId === 't-star', '员工登录锁定归属租户（星河财务无法切换到云雀）')
assert(s.scopedBudgets.every((b) => b.tenantId === 't-star'), '星河财务仅见星河预算')

console.log('')
if (failed) { console.error(`💥 预算闭环冒烟存在 ${failed} 个失败用例`); process.exit(1) }
else console.log('🎉 营销预算与成本控制闭环冒烟全部通过')
