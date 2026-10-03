import { create } from 'zustand'
import type { AvoidancePlan, BeeColony, DropPoint, SprayRecord } from '@/types'
import { db, deleteRow, loadAvoidances, loadSprays, putRow } from '@/hooks/usePersistentStore'
import { buildAvoidancePlan, safeDateReached } from '@/utils/avoidance'
import { uid } from '@/utils/id'

export interface AvoidanceState {
  sprays: SprayRecord[]
  plans: AvoidancePlan[]
  loaded: boolean
  hydrate: () => Promise<void>
  saveSpray: (row: SprayRecord) => Promise<void>
  removeSpray: (id: string) => Promise<void>
  /** 依据打药登记生成 / 重算避让安排 */
  generatePlan: (sprayId: string) => Promise<AvoidancePlan | undefined>
  /** 重算单条避让安排 */
  recalcPlan: (planId: string) => Promise<AvoidancePlan | undefined>
  /** 备用点容量改动（含删点）后，全部未结束的避让安排立即重算 */
  recalcOpenOnCapacityChange: () => Promise<void>
  /** 开始转场：受影响蜂群先记「转场中」 */
  beginTransit: (planId: string) => Promise<void>
  /** 到点：蜂群记「在园」，所在地块与投放点群号一起换过去 */
  arrive: (planId: string) => Promise<void>
  /** 安全间隔期过后转回原投放点 */
  returnHome: (planId: string) => Promise<void>
}

/** 读取重算所需的全量基础数据 */
async function loadRecalcContext(planId: string) {
  const state = avoidanceStore.getState()
  const prev = state.plans.find((item) => item.id === planId)
  const spray = prev ? state.sprays.find((item) => item.id === prev.sprayId) : undefined
  const [orchards, colonies, dropPoints, otherPlansAll] = await Promise.all([
    db.orchards.toArray(),
    db.colonies.toArray(),
    db.dropPoints.toArray(),
    loadAvoidances()
  ])
  const otherPlans = otherPlansAll.filter((plan) => plan.id !== planId && plan.status !== '已转回')
  return { prev, spray, orchards, colonies, dropPoints, otherPlans }
}

/** 重算单条安排并落库水合 */
async function recalcPlanById(planId: string): Promise<AvoidancePlan | undefined> {
  const ctx = await loadRecalcContext(planId)
  if (!ctx.prev || !ctx.spray) return undefined
  const next = buildAvoidancePlan(
    ctx.spray,
    { orchards: ctx.orchards, colonies: ctx.colonies, dropPoints: ctx.dropPoints, otherPlans: ctx.otherPlans },
    ctx.prev
  )
  next.id = planId
  await putRow<AvoidancePlan>(db.avoidances, next)
  await avoidanceStore.getState().hydrate()
  return next
}

/** 避让安排 store：打药登记 + 重算 + 执行（待执行 → 转场中 → 在园 → 已转回） */
export const avoidanceStore = create<AvoidanceState>((set, get) => ({
  sprays: [],
  plans: [],
  loaded: false,

  hydrate: async () => {
    const [sprays, plans] = await Promise.all([loadSprays(), loadAvoidances()])
    sprays.sort((a, b) => a.sprayDate.localeCompare(b.sprayDate))
    plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    set({ sprays, plans, loaded: true })
  },

  saveSpray: async (row) => {
    await putRow<SprayRecord>(db.sprays, row)
    await get().hydrate()
    // 打药日期 / 安全间隔期一改动，避让安排随即失效重算
    const linked = get().plans.find((plan) => plan.sprayId === row.id)
    if (linked) await recalcPlanById(linked.id)
  },

  removeSpray: async (id) => {
    const linked = (await loadAvoidances()).filter((plan) => plan.sprayId === id)
    await Promise.all(linked.map((plan) => deleteRow(db.avoidances, plan.id)))
    await deleteRow(db.sprays, id)
    await get().hydrate()
  },

  generatePlan: async (sprayId) => {
    const state = get()
    const spray = state.sprays.find((item) => item.id === sprayId)
    if (!spray) return undefined
    const existing = state.plans.find((plan) => plan.sprayId === sprayId)
    if (existing) return recalcPlanById(existing.id)

    const [orchards, colonies, dropPoints] = await Promise.all([
      db.orchards.toArray(),
      db.colonies.toArray(),
      db.dropPoints.toArray()
    ])
    const otherPlans = state.plans.filter((plan) => plan.status !== '已转回')
    const plan = buildAvoidancePlan(spray, { orchards, colonies, dropPoints, otherPlans })
    plan.id = uid('avd')
    plan.createdAt = new Date().toISOString()
    await putRow<AvoidancePlan>(db.avoidances, plan)
    await state.hydrate()
    return plan
  },

  recalcPlan: async (planId) => recalcPlanById(planId),

  recalcOpenOnCapacityChange: async () => {
    // 备用点容量一改动，未结束的安排随即失效重算（已转回的不动）
    const open = get().plans.filter((plan) => plan.status !== '已转回')
    for (const plan of open) {
      await recalcPlanById(plan.id)
    }
  },

  beginTransit: async (planId) => {
    const plan = get().plans.find((item) => item.id === planId)
    if (!plan) throw new Error('避让安排不存在')
    if (plan.status !== '待执行') throw new Error('只有待执行的安排才能开始转场')
    if (plan.shortageBoxes > 0) throw new Error(`仍有 ${plan.shortageBoxes} 箱排队缺点位，已退回托管队，不能转场`)
    const colonies = await db.colonies.toArray()
    await Promise.all(
      plan.items
        .map((item) => colonies.find((colony) => colony.id === item.colonyId))
        .filter((colony): colony is BeeColony => Boolean(colony))
        .map((colony) => putRow<BeeColony>(db.colonies, { ...colony, status: '转场中' }))
    )
    await putRow<AvoidancePlan>(db.avoidances, { ...plan, status: '转场中', stale: false })
    await get().hydrate()
  },

  arrive: async (planId) => {
    const plan = get().plans.find((item) => item.id === planId)
    if (!plan) throw new Error('避让安排不存在')
    if (plan.status !== '转场中') throw new Error('只有转场中的安排才能登记到点')
    const spray = get().sprays.find((item) => item.id === plan.sprayId)
    if (!spray) throw new Error('关联的打药登记已删除')
    const [colonies, points] = await Promise.all([db.colonies.toArray(), db.dropPoints.toArray()])
    for (const item of plan.items) {
      const colony = colonies.find((row) => row.id === item.colonyId)
      const backup = points.find((point) => point.id === item.backupDropId)
      if (!colony || !backup) continue
      // 原投放点摘下群号，备用点挂上群号；蜂群所在地块一并换过去
      if (item.originalDropId) {
        const original = points.find((point) => point.id === item.originalDropId)
        if (original) {
          await putRow<DropPoint>(db.dropPoints, {
            ...original,
            colonyCodes: original.colonyCodes.filter((code) => code !== colony.code)
          })
        }
      }
      if (!backup.colonyCodes.includes(colony.code)) {
        await putRow<DropPoint>(db.dropPoints, { ...backup, colonyCodes: [...backup.colonyCodes, colony.code] })
      }
      await putRow<BeeColony>(db.colonies, { ...colony, status: '在园', currentOrchardId: backup.orchardId })
    }
    await putRow<AvoidancePlan>(db.avoidances, { ...plan, status: '在园', stale: false })
    await get().hydrate()
  },

  returnHome: async (planId) => {
    const plan = get().plans.find((item) => item.id === planId)
    if (!plan) throw new Error('避让安排不存在')
    if (plan.status !== '在园') throw new Error('只有已到点在园的安排才能转回')
    if (!safeDateReached(plan.safeDate)) throw new Error(`安全间隔期未满，${plan.safeDate} 解禁后才能转回`)
    const spray = get().sprays.find((item) => item.id === plan.sprayId)
    if (!spray) throw new Error('关联的打药登记已删除')
    const [colonies, points] = await Promise.all([db.colonies.toArray(), db.dropPoints.toArray()])
    for (const item of plan.items) {
      const colony = colonies.find((row) => row.id === item.colonyId)
      if (!colony) continue
      const backup = points.find((point) => point.id === item.backupDropId)
      if (backup) {
        await putRow<DropPoint>(db.dropPoints, {
          ...backup,
          colonyCodes: backup.colonyCodes.filter((code) => code !== colony.code)
        })
      }
      // 安全间隔期过后转回原投放点：群号挂回原点，地块恢复成打药地块
      const original = points.find((point) => point.id === item.originalDropId)
      if (original && !original.colonyCodes.includes(colony.code)) {
        await putRow<DropPoint>(db.dropPoints, { ...original, colonyCodes: [...original.colonyCodes, colony.code] })
      }
      await putRow<BeeColony>(db.colonies, { ...colony, status: '在园', currentOrchardId: spray.orchardId })
    }
    await putRow<AvoidancePlan>(db.avoidances, { ...plan, status: '已转回', stale: false })
    await get().hydrate()
  }
}))
