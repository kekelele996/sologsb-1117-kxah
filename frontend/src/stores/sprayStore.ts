import { create } from 'zustand'
import dayjs from 'dayjs'
import type { AvoidanceAssignment, AvoidancePlan, SprayRecord } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { computeAvoidancePlan, fingerprintOf } from '@/utils/avoidance'

export interface SprayState {
  sprays: SprayRecord[]
  plans: AvoidancePlan[]
  loaded: boolean
  hydrate: () => Promise<void>
  saveSpray: (row: SprayRecord) => Promise<void>
  removeSpray: (id: string) => Promise<void>
  /** 重算某次打药的避让方案（重算后旧安排整体作废） */
  recompute: (sprayId: string) => Promise<void>
  /** 避让转出：蜂群记「转场中」 */
  depart: (planId: string, colonyId: string) => Promise<void>
  /** 到点：蜂群记「在园」，所在地块与投放点群号一起换到备用点 */
  arrive: (planId: string, colonyId: string) => Promise<void>
  /** 安全间隔期过后开始转回：蜂群记「转场中」 */
  startReturn: (planId: string, colonyId: string) => Promise<void>
  /** 转回到位：蜂群记「在园」，所在地块与投放点群号一起换回原投放点 */
  finishReturn: (planId: string, colonyId: string) => Promise<void>
}

export const sprayStore = create<SprayState>((set, get) => {
  /** 更新方案中某群的安排，并按最新台账/投放点刷新指纹后落库 */
  async function patchAssignment(
    planId: string,
    colonyId: string,
    patch: Partial<AvoidanceAssignment>
  ): Promise<void> {
    const plan = get().plans.find((item) => item.id === planId)
    if (!plan) return
    const spray = get().sprays.find((item) => item.id === plan.sprayId)
    const next: AvoidancePlan = {
      ...plan,
      assignments: plan.assignments.map((item) => (item.colonyId === colonyId ? { ...item, ...patch } : item)),
      fingerprint: spray
        ? fingerprintOf(spray, droppointStore.getState().rows, colonyStore.getState().rows)
        : plan.fingerprint
    }
    await putRow<AvoidancePlan>(db.plans, next)
    await get().hydrate()
  }

  /** 把群号从一个投放点挪到另一个投放点（一起换，避免两边各记各的） */
  async function moveColonyCode(code: string, fromDropId: string, toDropId: string): Promise<void> {
    const points = droppointStore.getState().rows
    const from = points.find((item) => item.id === fromDropId)
    const to = points.find((item) => item.id === toDropId)
    if (from && from.colonyCodes.includes(code)) {
      await droppointStore.getState().save({ ...from, colonyCodes: from.colonyCodes.filter((item) => item !== code) })
    }
    if (to && !to.colonyCodes.includes(code)) {
      await droppointStore.getState().save({ ...to, colonyCodes: [...to.colonyCodes, code] })
    }
  }

  return {
    sprays: [],
    plans: [],
    loaded: false,
    hydrate: async () => {
      const sprays = await loadAll<SprayRecord>(db.sprays)
      sprays.sort((a, b) => b.sprayDate.localeCompare(a.sprayDate))
      const plans = await loadAll<AvoidancePlan>(db.plans)
      set({ sprays, plans, loaded: true })
    },
    saveSpray: async (row) => {
      await putRow<SprayRecord>(db.sprays, row)
      await get().hydrate()
    },
    removeSpray: async (id) => {
      await deleteRow<SprayRecord>(db.sprays, id)
      const plans = get().plans.filter((item) => item.sprayId === id)
      await Promise.all(plans.map((item) => deleteRow<AvoidancePlan>(db.plans, item.id)))
      await get().hydrate()
    },
    recompute: async (sprayId) => {
      const spray = get().sprays.find((item) => item.id === sprayId)
      if (!spray) return
      const plan = computeAvoidancePlan(
        spray,
        colonyStore.getState().rows,
        droppointStore.getState().rows,
        orchardStore.getState().rows
      )
      const existing = get().plans.find((item) => item.sprayId === sprayId)
      if (existing) plan.id = existing.id
      await putRow<AvoidancePlan>(db.plans, plan)
      await get().hydrate()
    },
    depart: async (planId, colonyId) => {
      const colony = colonyStore.getState().rows.find((item) => item.id === colonyId)
      if (!colony) return
      await colonyStore.getState().save({ ...colony, status: '转场中' })
      await patchAssignment(planId, colonyId, { stage: '转场中' })
    },
    arrive: async (planId, colonyId) => {
      const plan = get().plans.find((item) => item.id === planId)
      const assignment = plan?.assignments.find((item) => item.colonyId === colonyId)
      const colony = colonyStore.getState().rows.find((item) => item.id === colonyId)
      if (!assignment || !assignment.toDropId || !colony) return
      const target = droppointStore.getState().rows.find((item) => item.id === assignment.toDropId)
      if (!target) return
      await moveColonyCode(colony.code, assignment.fromDropId, assignment.toDropId)
      await colonyStore.getState().save({ ...colony, status: '在园', currentOrchardId: target.orchardId })
      await patchAssignment(planId, colonyId, { stage: '已避让' })
    },
    startReturn: async (planId, colonyId) => {
      const plan = get().plans.find((item) => item.id === planId)
      if (!plan) return
      // 安全间隔期没过不允许转回
      if (plan.safeReturnDate && dayjs().format('YYYY-MM-DD') < plan.safeReturnDate) return
      const colony = colonyStore.getState().rows.find((item) => item.id === colonyId)
      if (!colony) return
      await colonyStore.getState().save({ ...colony, status: '转场中' })
      await patchAssignment(planId, colonyId, { stage: '转回中' })
    },
    finishReturn: async (planId, colonyId) => {
      const plan = get().plans.find((item) => item.id === planId)
      const assignment = plan?.assignments.find((item) => item.colonyId === colonyId)
      const colony = colonyStore.getState().rows.find((item) => item.id === colonyId)
      if (!assignment || !assignment.fromDropId || !colony) return
      const origin = droppointStore.getState().rows.find((item) => item.id === assignment.fromDropId)
      if (!origin) return
      await moveColonyCode(colony.code, assignment.toDropId, assignment.fromDropId)
      await colonyStore.getState().save({ ...colony, status: '在园', currentOrchardId: origin.orchardId })
      await patchAssignment(planId, colonyId, { stage: '已转回' })
    }
  }
})
