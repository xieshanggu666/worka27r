// 营销预算与成本控制服务（服务端，事件溯源 append-only）：
//  - 预算编制（budget:set）：租户级/活动级，draft/reviewing → 财务审批（budget:approve）→ active/closed
//  - 调整申请：追加/追减/封停，财务审批通过后即时改写预算（版本号递增）
//  - 成本占用台账 budgetLedger（append-only）：抽奖成本/积分奖励/兑换权益/采购入库/供应商结算
//    五类占用分录（hold/actual/reverse），净占用实时由台账推导
//  - 硬控：采购入库/供应商结算超预算拦截；预算参数（积分折现单价/硬控开关）按租户配置
import { genId, BizError } from '../util.js'

export const DEFAULT_WARN_RATIO = 0.8
export const DEFAULT_POINT_RATE = 0.1

export class BudgetService {
  constructor(deps) {
    this.k = deps.k
    this.audit = deps.audit
    this.locks = deps.locks
  }

  settingOf(tenantId) {
    return this.k.state.budgetSettings[tenantId] ||
      { pointRate: DEFAULT_POINT_RATE, enforceHard: true, costMap: {} }
  }

  // 预算目标解析：活动归属成本优先占活动预算，无则回退租户总预算
  resolveBudget(tenantId, activityId = null) {
    if (activityId) {
      const ab = this.k.state.budgets.find((b) => (b.tenantId || 't-star') === tenantId &&
        b.scope === 'activity' && b.activityId === activityId && b.status === 'active')
      if (ab) return ab
    }
    return this.k.state.budgets.find((b) => (b.tenantId || 't-star') === tenantId &&
      b.scope === 'tenant' && b.status === 'active') || null
  }

  usedOf(budgetId) {
    return Math.round(this.k.state.budgetLedger
      .filter((e) => e.budgetId === budgetId)
      .reduce((n, e) => n + e.signedAmount, 0) * 100) / 100
  }

  // 占用中净额（hold − 已冲销的 hold reverse）
  holdNetOfRows(rows) {
    const holdIds = new Set(rows.filter((e) => e.status === 'hold').map((e) => e.id))
    return Math.round(rows
      .filter((e) => e.status === 'hold' || (e.status === 'reverse' && holdIds.has(e.reverseId)))
      .reduce((n, e) => n + e.signedAmount, 0) * 100) / 100
  }

  usageOf(budgetId) {
    const rows = this.k.state.budgetLedger.filter((e) => e.budgetId === budgetId)
    const byType = {}
    for (const t of ['draw', 'points', 'exchange', 'purchase', 'settle']) {
      byType[t] = Math.round(rows.filter((e) => e.costType === t).reduce((n, e) => n + e.signedAmount, 0) * 100) / 100
    }
    const total = Math.round(rows.reduce((n, e) => n + e.signedAmount, 0) * 100) / 100
    return {
      total: rows.length, used: total, hold: this.holdNetOfRows(rows),
      actual: Math.round(rows.filter((e) => e.status === 'actual').reduce((n, e) => n + e.signedAmount, 0) * 100) / 100,
      byType
    }
  }

  standardCost(tenantId, key) {
    const map = this.settingOf(tenantId).costMap || {}
    if (map[key] !== undefined) return Math.max(0, Number(map[key]) || 0)
    let row = null
    if (key.startsWith('prize:')) {
      const rest = key.slice('prize:'.length)
      const i = rest.indexOf(':')
      row = this.k.state.activities.find((a) => a.id === rest.slice(0, i))
        ?.prizes.find((p) => p.id === rest.slice(i + 1))
    } else {
      row = this.k.state.goods.find((g) => g.id === key.slice('goods:'.length))
    }
    return row?.costPrice !== undefined ? Math.max(0, Number(row.costPrice) || 0) : 0
  }

  previewCharge(tenantId, activityId, amount) {
    const budget = this.resolveBudget(tenantId, activityId)
    const used = budget ? this.usedOf(budget.id) : 0
    const after = Math.round((used + (Number(amount) || 0)) * 100) / 100
    if (!budget) return { budget: null, used: 0, amount, after, over: false, noBudget: true, enforceHard: true }
    const ratio = budget.amount > 0 ? after / budget.amount : 0
    return {
      budget, used, amount, after, remain: Math.round((budget.amount - used) * 100) / 100,
      ratio, over: after > budget.amount + 1e-9,
      warn: ratio >= (budget.warnRatio || DEFAULT_WARN_RATIO),
      enforceHard: budget.enforceHard !== false && this.settingOf(tenantId).enforceHard !== false
    }
  }

  async _addEntry({ budget, tenantId, activityId = null, costType, refType, refId, bizNo = '', targetName = '',
                    amount, status, reverseOf = '', note = '', traceId, qty = 0, date }) {
    const amt = Math.round((Number(amount) || 0) * 100) / 100
    if (!(amt > 0)) return null
    const row = {
      id: genId('be'),
      tenantId: budget?.tenantId || tenantId,
      traceId: traceId || '',
      budgetId: budget?.id || '',
      budgetScope: budget?.scope || (activityId ? 'activity' : 'tenant'),
      activityId: budget?.scope === 'activity' ? budget.activityId : activityId,
      costType, refType, refId, reverseId: reverseOf, bizNo, targetName, qty,
      amount: amt, signedAmount: status === 'reverse' ? -amt : amt, status, note,
      date: date || this.k.todayDate(), time: this.k.nowTime(), ts: this.k.nowTs()
    }
    await this.k.commit([{ type: 'insert', table: 'budgetLedger', row }])
    return row
  }

  // 四类成本占用钩子（幂等：同一 refId+costType 的正向分录只记一次）
  async chargeDrawCost(rec, act, status, traceId) {
    const cost = rec.cost || (act.costType === 'points' ? act.cost : 0)
    if (!(cost > 0)) return
    if (status !== 'reverse' && this.k.state.budgetLedger.some((e) => e.refType === 'draw' && e.refId === rec.id && e.costType === 'draw' && e.status !== 'reverse')) return
    const amount = cost * this.settingOf(act.tenantId).pointRate
    const budget = this.resolveBudget(act.tenantId, act.id)
    await this._addEntry({ budget, tenantId: act.tenantId, activityId: act.id, costType: 'draw',
      refType: 'draw', refId: rec.id, bizNo: rec.id, targetName: act.name, amount, status, traceId,
      qty: cost, note: `${status === 'hold' ? '风控冻结占用' : status === 'reverse' ? '撤销冲销抽奖成本' : '抽奖参与成本'}：${act.name}（${cost} 积分折现）` })
  }

  async chargePoints({ tenantId, points, flowId, refType, refId, targetName, note, traceId = '', activityId = null }) {
    if (!(points > 0)) return null
    if (this.k.state.budgetLedger.some((e) => e.refId === flowId || (e.refId === refId && e.costType === 'points'))) return null
    const amount = points * this.settingOf(tenantId).pointRate
    const budget = this.resolveBudget(tenantId, activityId)
    return this._addEntry({ budget, tenantId, activityId, costType: 'points', refType, refId: flowId || refId,
      bizNo: refId, targetName, amount, status: 'actual', traceId, qty: points, note })
  }

  async chargePrizeGoods(rec, status, traceId) {
    const isDraw = rec.type === 'draw'
    const key = isDraw ? `prize:${rec.activityId}:${rec.prizeId}` : `goods:${rec.goodsId}`
    const amount = this.standardCost(rec.tenantId, key)
    if (!(amount > 0)) return
    if (status !== 'reverse' && this.k.state.budgetLedger.some((e) => e.refId === rec.id && e.costType === 'exchange' &&
      ((isDraw && e.refType === 'draw') || (!isDraw && e.refType === 'redeem')) && e.status !== 'reverse')) return
    const budget = this.resolveBudget(rec.tenantId, isDraw ? rec.activityId : null)
    await this._addEntry({ budget, tenantId: rec.tenantId, activityId: isDraw ? rec.activityId : null,
      costType: 'exchange', refType: isDraw ? 'draw' : 'redeem', refId: rec.id, bizNo: rec.id,
      targetName: isDraw ? rec.prizeName : rec.goodsName, amount, status, traceId, qty: 1,
      note: `${status === 'hold' ? '风控冻结占用：' : status === 'reverse' ? '撤销冲销权益成本：' : ''}${isDraw ? '抽奖中奖权益成本' : '积分兑换权益成本'}：${isDraw ? rec.prizeName : rec.goodsName}` })
  }

  // 放行转正：hold 分录 reverse 冲销 + actual 补记
  async settleHolds(rec, order, traceId) {
    const holdRows = this.k.state.budgetLedger.filter((e) =>
      e.refId === rec.id && ['draw', 'redeem'].includes(e.refType) &&
      ['draw', 'exchange'].includes(e.costType) && e.status === 'hold' &&
      !this.k.state.budgetLedger.some((x) => x.reverseId === e.id))
    for (const h of holdRows) {
      const budget = this.k.state.budgets.find((b) => b.id === h.budgetId) || null
      await this._addEntry({ budget, tenantId: h.tenantId, activityId: h.activityId, costType: h.costType,
        refType: h.refType, refId: rec.id, bizNo: order?.id || rec.id, targetName: h.targetName,
        amount: h.amount, status: 'reverse', reverseOf: h.id, traceId,
        note: `风控放行：冻结占用转正（冲回 hold）${h.targetName}` })
      await this._addEntry({ budget, tenantId: h.tenantId, activityId: h.activityId, costType: h.costType,
        refType: h.refType, refId: rec.id, bizNo: order?.id || rec.id, targetName: h.targetName,
        amount: h.amount, status: 'actual', traceId,
        note: `风控放行实际支出：${h.targetName}` })
    }
  }

  // 撤销：未冲销 hold 全部 reverse
  async reverseHolds(rec, order, traceId) {
    const holdRows = this.k.state.budgetLedger.filter((e) =>
      e.refId === rec.id && ['draw', 'redeem'].includes(e.refType) &&
      ['draw', 'exchange'].includes(e.costType) && e.status === 'hold' &&
      !this.k.state.budgetLedger.some((x) => x.reverseId === e.id))
    for (const h of holdRows) {
      const budget = this.k.state.budgets.find((b) => b.id === h.budgetId) || null
      await this._addEntry({ budget, tenantId: h.tenantId, activityId: h.activityId, costType: h.costType,
        refType: h.refType, refId: rec.id, bizNo: order?.id || rec.id, targetName: h.targetName,
        amount: h.amount, status: 'reverse', reverseOf: h.id, traceId,
        note: `风控撤销冲销占用：${h.targetName}` })
    }
  }

  // 采购入库占用（硬控在 purchase 服务先调 ensureCover）
  async chargeInbound(po, batch, qty, amount, traceId) {
    const budget = this.resolveBudget(po.tenantId, po.activityId || null)
    return this._addEntry({ budget, tenantId: po.tenantId, activityId: po.activityId || null,
      costType: 'purchase', refType: 'inbound', refId: batch.id, bizNo: po.poNo,
      targetName: po.targetName, amount, status: 'actual', traceId, qty,
      note: `采购验收入库占用：${po.targetName} 合格 ${qty} 件 × ${po.unitPrice} 元（${po.poNo}）` })
  }

  // 供应商结算：采购占用等额冲销 + 结算实付占用
  async chargeSettle(bill, traceId) {
    const budget = this.resolveBudget(bill.tenantId, bill.activityId || null)
    const inboundRows = this.k.state.budgetLedger.filter((e) =>
      e.costType === 'purchase' && e.status !== 'reverse' &&
      this.k.state.inboundBatches.some((b) => b.id === e.refId && b.poId === bill.poId))
      .sort((a, b) => a.ts - b.ts)
    let left = bill.payableAmount
    for (const row of inboundRows) {
      if (left <= 1e-9) break
      const take = Math.min(row.amount, Math.round(left * 100) / 100)
      await this._addEntry({ budget, tenantId: bill.tenantId, activityId: bill.activityId || null,
        costType: 'purchase', refType: 'inbound', refId: row.refId, bizNo: bill.poNo,
        targetName: row.targetName, amount: take, status: 'reverse', reverseOf: row.id, traceId,
        note: `供应商结算冲回采购占用：${bill.billNo}` })
      left = Math.round((left - take) * 100) / 100
    }
    return this._addEntry({ budget, tenantId: bill.tenantId, activityId: bill.activityId || null,
      costType: 'settle', refType: 'bill', refId: bill.id, bizNo: bill.billNo,
      targetName: bill.targetName, amount: bill.payableAmount, status: 'actual', traceId, qty: bill.billableQty,
      note: `供应商结算付款：${bill.targetName}（${bill.billNo}，实付 ${bill.payableAmount} 元）` })
  }

  // 硬控检查（超限 + 启用硬控 → 抛 409）
  ensureCover(tenantId, activityId, amount, module = 'budget') {
    const pv = this.previewCharge(tenantId, activityId, amount)
    if (pv.over && pv.enforceHard) {
      throw new BizError('BUDGET_EXCEEDED',
        `预算超限拦截：本次占用 ${Math.round(amount * 100) / 100} 元，` +
        (pv.budget ? `【${pv.budget.title}】结余 ${pv.remain} 元` : '当前无生效预算（请先编制并审批预算）'), 409)
    }
    return pv
  }

  // —— 预算编制 / 审批 ——
  async createBudget(form, ctx) {
    return this.locks.run(`budget:${ctx.tenantId}:${form.scope}:${form.activityId || ''}`,
      () => this._createBudget(form, ctx))
  }

  async _createBudget(form, ctx) {
    const tid = ctx.tenantId
    const scope = form.scope === 'activity' ? 'activity' : 'tenant'
    let activityId = null; let activityName = ''
    if (scope === 'activity') {
      activityId = form.activityId || ''
      const act = this.k.state.activities.find((a) => a.id === activityId && a.tenantId === tid)
      if (!act) throw new BizError('BAD_FORM', '请选择本租户的活动')
      activityName = act.name
    }
    const amount = Math.round(Number(form.amount) * 100) / 100
    if (!(amount > 0)) throw new BizError('BAD_FORM', '预算金额需大于 0')
    if (amount > 1e9) throw new BizError('BAD_FORM', '预算金额异常')
    const periodStart = (form.periodStart || '').trim()
    const periodEnd = (form.periodEnd || '').trim()
    if (!periodStart || !periodEnd || periodEnd < periodStart) throw new BizError('BAD_FORM', '预算周期不合法')
    const warnRatio = form.warnRatio ? Math.min(1, Math.max(0.1, Number(form.warnRatio))) : DEFAULT_WARN_RATIO
    const dup = this.k.state.budgets.find((b) => (b.tenantId || 't-star') === tid && b.scope === scope &&
      b.activityId === activityId && !['rejected', 'closed'].includes(b.status) &&
      !(periodEnd < b.periodStart || periodStart > b.periodEnd))
    if (dup) throw new BizError('BUDGET_DUP', scope === 'tenant' ? '该周期已有生效/审批中的租户总预算' : '该活动在此周期已有预算')
    const submit = form.submit !== false
    const traceId = this.k.newTraceId()
    const b = {
      id: genId('bg'),
      budgetNo: 'BG' + Date.now().toString(36).toUpperCase() + String(Math.floor(Math.random() * 90) + 10),
      tenantId: tid, traceId, scope, activityId, activityName,
      title: (form.title || '').trim() || (scope === 'tenant'
        ? `营销总预算（${periodStart} ~ ${periodEnd}）` : `${activityName}活动预算（${periodStart} ~ ${periodEnd}）`),
      amount, initAmount: amount, periodStart, periodEnd, warnRatio,
      status: submit ? 'reviewing' : 'draft',
      enforceHard: form.enforceHard !== undefined ? !!form.enforceHard : this.settingOf(tid).enforceHard,
      note: (form.note || '').trim(),
      applicant: ctx.name, applicantId: ctx.memberId || ctx.userId,
      createdAt: this.k.todayDate(), time: this.k.nowTime(), ts: this.k.nowTs(),
      submittedAt: submit ? `${this.k.todayDate()} ${this.k.nowTime()}` : '',
      reviewedAt: '', reviewer: '', reviewNote: '', activeAt: '',
      closedAt: '', version: 1, adjustments: []
    }
    await this.k.commit([{ type: 'insert', table: 'budgets', row: b }])
    await this.audit.log('budget-create', b.id,
      `编制${scope === 'tenant' ? '租户总预算' : '活动预算'}【${b.title}】：${amount} 元，周期 ${periodStart} ~ ${periodEnd}` +
      (submit ? '；已提交财务审批' : '；已存草稿'),
      { tenantId: tid, ctx, traceId })
    return b
  }

  async submitBudget(budgetId, patch, ctx) {
    const b = this.requireBudget(budgetId, ctx.tenantId)
    if (!['draft', 'rejected'].includes(b.status)) throw new BizError('STATE_DENIED', '仅草稿/被驳回预算可提交审批', 409)
    const row = { ...b }
    if (patch?.amount !== undefined) {
      const amt = Math.round(Number(patch.amount) * 100) / 100
      if (!(amt > 0)) throw new BizError('BAD_FORM', '预算金额需大于 0')
      row.amount = amt
    }
    if (patch?.note !== undefined) row.note = (patch.note || '').trim()
    Object.assign(row, { status: 'reviewing', version: b.version + 1,
      submittedAt: `${this.k.todayDate()} ${this.k.nowTime()}`, reviewedAt: '', reviewer: '', reviewNote: '' })
    await this.k.commit([{ type: 'upsert', table: 'budgets', row }])
    await this.audit.log('budget-submit', b.id, `提交预算审批【${b.title}】v${row.version}：${row.amount} 元`, { tenantId: b.tenantId, ctx })
    return row
  }

  async reviewBudget(budgetId, approve, note, ctx) {
    const b = this.requireBudget(budgetId, ctx.tenantId)
    if (b.status !== 'reviewing') throw new BizError('STATE_DENIED', '该预算当前状态不可审批', 409)
    const row = {
      ...b, status: approve ? 'active' : 'rejected',
      reviewedAt: `${this.k.todayDate()} ${this.k.nowTime()}`, reviewer: ctx.name, reviewNote: (note || '').trim(),
      activeAt: approve ? (b.activeAt || `${this.k.todayDate()} ${this.k.nowTime()}`) : b.activeAt
    }
    await this.k.commit([{ type: 'upsert', table: 'budgets', row }])
    await this.audit.log(approve ? 'budget-approve' : 'budget-reject', b.id,
      `${approve ? '审批通过' : '驳回'}预算【${b.title}】（${b.amount} 元）${approve ? '；预算即刻生效，成本开始实时占用' : '；退回编制人修订'}`,
      { tenantId: b.tenantId, ctx })
    return row
  }

  async closeBudget(budgetId, note, ctx) {
    const b = this.requireBudget(budgetId, ctx.tenantId)
    if (b.status !== 'active') throw new BizError('STATE_DENIED', '仅生效中预算可封存', 409)
    const used = this.usedOf(b.id)
    const row = { ...b, status: 'closed', closedAt: `${this.k.todayDate()} ${this.k.nowTime()}`, closeNote: (note || '').trim() }
    await this.k.commit([{ type: 'upsert', table: 'budgets', row }])
    await this.audit.log('budget-close', b.id,
      `封存预算【${b.title}】：预算 ${b.amount} 元，累计占用 ${used} 元，结余 ${Math.round((b.amount - used) * 100) / 100} 元`,
      { tenantId: b.tenantId, ctx })
    return row
  }

  async requestAdjust(budgetId, form, ctx) {
    const b = this.requireBudget(budgetId, ctx.tenantId)
    if (b.status !== 'active') throw new BizError('STATE_DENIED', '仅生效中预算可发起调整申请', 409)
    const type = ['increase', 'decrease', 'freeze'].includes(form.type) ? form.type : 'increase'
    const delta = type === 'freeze' ? 0 : Math.round(Number(form.delta) * 100) / 100
    if (type !== 'freeze' && !(delta > 0)) throw new BizError('BAD_FORM', '调整金额需大于 0')
    if (type === 'decrease' && delta > b.amount - this.usedOf(b.id) + 1e-9) {
      throw new BizError('ADJUST_DENIED', '追减后预算不得低于当前占用', 409)
    }
    const reason = (form.reason || '').trim()
    if (!reason) throw new BizError('BAD_FORM', '请填写调整事由')
    const traceId = this.k.newTraceId()
    const adj = {
      id: genId('ba'),
      adjNo: 'BA' + Date.now().toString(36).toUpperCase() + String(Math.floor(Math.random() * 90) + 10),
      tenantId: b.tenantId, traceId, budgetId: b.id, budgetNo: b.budgetNo, budgetTitle: b.title,
      scope: b.scope, activityId: b.activityId, type, delta,
      amountBefore: b.amount,
      amountAfter: type === 'increase' ? Math.round((b.amount + delta) * 100) / 100
        : type === 'decrease' ? Math.round((b.amount - delta) * 100) / 100 : b.amount,
      reason, status: 'pending',
      applicant: ctx.name, applicantId: ctx.memberId || ctx.userId,
      createdAt: this.k.todayDate(), time: this.k.nowTime(), ts: this.k.nowTs(),
      reviewedAt: '', reviewer: '', reviewNote: ''
    }
    await this.k.commit([{ type: 'insert', table: 'budgetAdjusts', row: adj }])
    await this.audit.log('budget-adjust-apply', b.id,
      `发起预算调整【${b.title}】：${type === 'freeze' ? '提前封停' : `${type === 'increase' ? '追加' : '追减'} ${delta} 元（${b.amount} → ${adj.amountAfter}）`}，事由：${reason}`,
      { tenantId: b.tenantId, ctx, traceId })
    return adj
  }

  async reviewAdjust(adjId, approve, note, ctx) {
    const adj = this.k.state.budgetAdjusts.find((x) => x.id === adjId)
    if (!adj || (adj.tenantId || 't-star') !== ctx.tenantId) throw new BizError('NOT_FOUND', '调整申请不存在', 404)
    if (adj.status !== 'pending') throw new BizError('STATE_DENIED', '该调整申请已处理', 409)
    const b = this.requireBudget(adj.budgetId, ctx.tenantId)
    const traceId = adj.traceId
    const adjRow = { ...adj, status: approve ? 'approved' : 'rejected',
      reviewedAt: `${this.k.todayDate()} ${this.k.nowTime()}`, reviewer: ctx.name, reviewNote: (note || '').trim() }
    const budgetRow = { ...b }
    if (approve) {
      if (adj.type === 'freeze') {
        budgetRow.status = 'closed'
        budgetRow.closedAt = `${this.k.todayDate()} ${this.k.nowTime()}`
        budgetRow.closeNote = `财务审批封停：${adj.reason}`
      } else {
        budgetRow.amount = adj.amountAfter
        budgetRow.version = b.version + 1
      }
      budgetRow.adjustments = [...(b.adjustments || []), adj.id]
    }
    await this.k.commit([
      { type: 'upsert', table: 'budgetAdjusts', row: adjRow },
      { type: 'upsert', table: 'budgets', row: budgetRow }
    ])
    await this.audit.log(approve ? 'budget-adjust-approve' : 'budget-adjust-reject', b.id,
      `${approve ? '审批通过' : '驳回'}预算调整【${b.title}】：${adj.type === 'freeze' ? '封停（已生效）' : `${adj.delta} 元（${adj.amountBefore} → ${approve ? adj.amountAfter : adj.amountBefore}）`}`,
      { tenantId: b.tenantId, ctx, traceId })
    return adjRow
  }

  async updateSetting(patch, ctx) {
    const cur = this.settingOf(ctx.tenantId)
    const next = {
      pointRate: Math.max(0, Math.round((patch.pointRate !== undefined ? Number(patch.pointRate) : cur.pointRate) * 10000) / 10000),
      enforceHard: patch.enforceHard !== undefined ? !!patch.enforceHard : cur.enforceHard,
      costMap: { ...(cur.costMap || {}) }
    }
    if (!(next.pointRate > 0)) throw new BizError('BAD_FORM', '积分折现单价需大于 0')
    if (patch.costMap && typeof patch.costMap === 'object') Object.assign(next.costMap, patch.costMap)
    await this.k.commit([{ type: 'budget-settings.put', tenantId: ctx.tenantId, settings: next }])
    await this.audit.log('budget-setting', '',
      `预算参数更新：积分折现 ${next.pointRate} 元/积分、超限硬控 ${next.enforceHard ? '开启' : '关闭'}`,
      { tenantId: ctx.tenantId, ctx })
    return next
  }

  requireBudget(budgetId, tenantId) {
    const b = this.k.state.budgets.find((x) => x.id === budgetId)
    if (!b) throw new BizError('BUDGET_NOT_FOUND', '预算不存在', 404)
    if (b.tenantId !== tenantId) throw new BizError('FORBIDDEN', '预算不属于当前租户', 403)
    return b
  }

  // 预算执行视图（纯推导）
  views(tenantId) {
    return this.k.state.budgets
      .filter((b) => (b.tenantId || 't-star') === tenantId && ['active', 'reviewing', 'closed'].includes(b.status))
      .map((b) => {
        const u = this.usageOf(b.id)
        const ratio = b.amount > 0 ? u.used / b.amount : 0
        const state = b.status !== 'active' ? b.status : ratio >= 1 ? 'over' : ratio >= (b.warnRatio || DEFAULT_WARN_RATIO) ? 'warn' : 'ok'
        return { budget: b, ...u, ratio, percent: Math.min(100, Math.round(ratio * 100)), state,
          remain: Math.round((b.amount - u.used) * 100) / 100 }
      }).sort((a, b) => b.budget.ts - a.budget.ts)
  }
}
