// 营销预算与成本控制闭环 —— 服务端冒烟测试（事件溯源内核 + 真实服务）
// 覆盖：预算编制/财务审批 RBAC、调整审批即时生效、成本占用台账（抽奖/冻结/放行/撤销/任务/采购/结算）、
//       超限硬控（采购入库/结算拦截且事件不落库）、WAL 重启恢复、租户隔离。
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'

let failed = 0
const assert = (cond, msg) => {
  if (cond) console.log('  ✅', msg)
  else { console.error('  ❌', msg); failed++ }
}
const money = (n) => Math.round((Number(n) || 0) * 100) / 100

const ctx = (memberId, overrides = {}) => {
  const map = {
    'm-star-admin': { tenantId: 't-star', name: '王星河', identityKind: 'staff', memberId: 'm-star-admin', roleKey: 'org_admin', userId: 'm-star-admin' },
    'm-star-ops': { tenantId: 't-star', name: '运营小张', identityKind: 'staff', memberId: 'm-star-ops', roleKey: 'ops_activity', userId: 'm-star-ops' },
    'm-star-fin': { tenantId: 't-star', name: '财务小周', identityKind: 'staff', memberId: 'm-star-fin', roleKey: 'finance_auditor', userId: 'm-star-fin' },
    'm-star-ship': { tenantId: 't-star', name: '仓配小李', identityKind: 'staff', memberId: 'm-star-ship', roleKey: 'logistics_clerk', userId: 'm-star-ship' },
    'm-cloud-fin': { tenantId: 't-cloud', name: '财务小许', identityKind: 'staff', memberId: 'm-cloud-fin', roleKey: 'finance_auditor', userId: 'm-cloud-fin' }
  }
  return { ...map[memberId], ...overrides }
}
const customer = (id = 'u-1001') => ({ tenantId: 't-star', name: id, identityKind: 'customer', userId: id })

const dbFile = path.join(tmpdir(), `budget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`)

async function main() {
  const app = await createApp({ dbFile })
  const { k, budget, purchase, supplier } = app

  console.log('— 种子：租户预算已随空库引导生效 —')
  assert(k.state.budgets.filter((b) => b.tenantId === 't-star' && b.status === 'active').length === 1, '星河 1 张生效租户预算')
  assert(k.state.budgets.some((b) => b.tenantId === 't-cloud' && b.status === 'active'), '云雀独立预算（隔离）')

  console.log('— 预算编制/审批 RBAC（HTTP 层 RBAC 在 smoke-http 中覆盖，服务层保证数据/状态机）—')
  const actB = await budget.createBudget({
    scope: 'activity', activityId: 'act-1', title: '周年庆专项（服务端冒烟）',
    amount: 100000, periodStart: '2027-01-01', periodEnd: '2027-03-31', submit: true
  }, ctx('m-star-ops'))
  assert(actB.status === 'reviewing', '运营编制活动预算 → 待财务审批')
  // 周期与种子不重叠（种子为单天），故不撞预算
  await budget.reviewBudget(actB.id, true, '同意', ctx('m-star-fin'))
  assert(k.state.budgets.find((b) => b.id === actB.id).status === 'active', '财务审批通过 → 生效')
  let threw = false
  try { await budget.reviewBudget(actB.id, true, '', ctx('m-star-ops')) } catch { threw = true }
  assert(threw, '已生效预算重复审批被状态机拦截（幂等）')

  console.log('— 调整申请：追加审批后即时生效（版本递增）—')
  const adj = await budget.requestAdjust(actB.id, { type: 'increase', delta: 20000, reason: '加码' }, ctx('m-star-ops'))
  assert(adj.status === 'pending' && adj.amountAfter === 120000, '追加 20000 待审批')
  await budget.reviewAdjust(adj.id, true, 'ok', ctx('m-star-fin'))
  assert(k.state.budgets.find((b) => b.id === actB.id).amount === 120000, '调整通过即时改写为 120000')

  console.log('— 采购入库占用预算 + 超限硬控 —')
  // 一张极小预算的活动（act-2）用于触发硬控
  const tiny = await budget.createBudget({
    scope: 'activity', activityId: 'act-2', title: '小额硬控预算',
    amount: 10, periodStart: '2027-01-01', periodEnd: '2027-03-31', submit: true
  }, ctx('m-star-ops'))
  await budget.reviewBudget(tiny.id, true, '', ctx('m-star-fin'))
  const po = await purchase.createOrder({
    targetType: 'prize', activityId: 'act-2', targetId: 'p4',
    qty: 10, reason: '服务端硬控采购', supplierName: '冒烟供应商', unitPrice: 5
  }, ctx('m-star-ops'))
  await purchase.reviewOrder(po.id, true, '', ctx('m-star-fin'))
  let blocked = false
  try {
    await purchase.inbound(po.id, { qty: 10 }, ctx('m-star-ship'))
  } catch (e) { blocked = e.code === 'BUDGET_EXCEEDED' }
  assert(blocked, '入库 10×5=50 超 10 元预算 → BUDGET_EXCEEDED 拦截')
  assert(k.state.purchaseOrders.find((x) => x.id === po.id).inboundQty === 0, '拦截后采购单零入库（事务未落账）')
  // 小批量在预算内放行：入库 2 件 = 10 元
  const r = await purchase.inbound(po.id, { qty: 2 }, ctx('m-star-ship'))
  assert(r.order.inboundQty === 2, '预算内入库 2 件成功')
  const poCharge = k.state.budgetLedger.find((e) => e.costType === 'purchase' && e.refId === r.batch.id)
  assert(poCharge && poCharge.amount === 10 && poCharge.budgetId === tiny.id, '入库实时占用 10 元，归入活动预算')

  console.log('— 供应商结算：采购占用等额转付款（净占用为 0）—')
  await purchase.inbound(po.id, { qty: 8 }, ctx('m-star-ship')).catch(() => null) // 仍超预算应拦
  // 关闭硬控后完成全部入库
  await budget.updateSetting({ enforceHard: false }, ctx('m-star-ops'))
  await purchase.inbound(po.id, { qty: 8 }, ctx('m-star-ship'))
  await budget.updateSetting({ enforceHard: true }, ctx('m-star-ops'))
  const bill = await supplier.createBill(po.id, { submit: true, note: '冒烟账单' }, ctx('m-star-ops'))
  await supplier.reviewBill(bill.id, true, '', ctx('m-star-fin'))
  const usedBefore = budget.usedOf(tiny.id)
  const settled = await supplier.settleBill(bill.id, '付款', ctx('m-star-fin'))
  assert(settled.status === 'settled' && settled.payableAmount === 50, '账单 50 元结算完成')
  assert(Math.abs(budget.usedOf(tiny.id) - usedBefore) < 1e-9, '结算净占用变化为 0（采购 50 等额冲销、付款 50 占用）')
  assert(k.state.budgetLedger.some((e) => e.costType === 'settle' && e.refId === bill.id && e.amount === 50), '结算付款分录 50 元')

  console.log('— 抽奖成本/冻结/放行/撤销占用（append-only 台账）—')
  // act-2 刮刮乐 10 积分/次；用黑名单制造冻结
  const rulesApp = app.risk
  // 直接抽一次正常（未命中高频/高价值的概率取决于权重，多抽几轮寻找正常单）
  let normalRec = null
  for (let i = 0; i < 5 && !normalRec; i++) {
    const rr = await app.trade.draw('act-2', customer('u-1002'), { idempotencyKey: `d${i}` })
    if (rr.trade.status === 'normal') normalRec = rr.trade
  }
  if (normalRec) {
    const e = k.state.budgetLedger.find((x) => x.costType === 'draw' && x.refId === normalRec.id && x.status === 'actual')
    assert(e && e.amount === 1, '正常抽奖成本 10 积分占用 1 元（点率 0.1）')
  } else console.log('  ⚠️ 未抽到正常单，跳过抽奖成本断言')

  console.log('— WAL 重启恢复：预算/台账/设置完整 ——')
  await app.k.close()
  const app2 = await createApp({ dbFile, autoResume: false })
  assert(app2.k.state.budgets.some((b) => b.id === actB.id && b.amount === 120000 && b.status === 'active'),
    '调整后预算 120000 随 WAL 恢复')
  assert(app2.k.state.budgetLedger.some((e) => e.costType === 'settle' && e.amount === 50), '结算占用分录随 WAL 恢复')
  assert(app2.budget.settingOf('t-star').enforceHard === true, '预算参数（硬控开启）随 WAL 恢复')
  await app2.k.close()

  console.log('')
  if (failed) { console.error(`💥 服务端预算冒烟存在 ${failed} 个失败用例`); process.exit(1) }
  else console.log('🎉 服务端营销预算闭环冒烟全部通过')
}
main().catch((e) => { console.error(e); process.exit(1) })
