import { create } from 'zustand'
import type { DropPoint } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
// 注意：avoidanceStore 的动作内通过 db.dropPoints 直读，不反向导入本 store，
// 此处的循环仅出现在运行期函数调用，模块初始化阶段无引用，ESM 下安全。
import { avoidanceStore } from '@/stores/avoidanceStore'

export interface DropPointState {
  rows: DropPoint[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: DropPoint) => Promise<void>
  remove: (id: string) => Promise<void>
  removeByOrchard: (orchardId: string) => Promise<void>
}

/** 备用点容量是否发生改动（含新增点：容量由无到有也算） */
async function capacityChanged(prevId: string | undefined, nextCapacity: number): Promise<boolean> {
  if (!prevId) return true
  const prev = await db.dropPoints.get(prevId)
  return !prev || prev.capacityBoxes !== nextCapacity
}

/** 容量改动后让全部未结束的避让安排失效重算 */
async function triggerAvoidanceRecalc(): Promise<void> {
  await avoidanceStore.getState().recalcOpenOnCapacityChange()
}

export const droppointStore = create<DropPointState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<DropPoint>(db.dropPoints)
    rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    const changed = await capacityChanged(row.id, row.capacityBoxes)
    await putRow<DropPoint>(db.dropPoints, row)
    await get().hydrate()
    if (changed) await triggerAvoidanceRecalc()
  },
  remove: async (id) => {
    await deleteRow<DropPoint>(db.dropPoints, id)
    await get().hydrate()
    // 备用点被删：快照必然对不上，避让安排立即失效重算
    await triggerAvoidanceRecalc()
  },
  removeByOrchard: async (orchardId) => {
    const targets = get().rows.filter((row) => row.orchardId === orchardId)
    await Promise.all(targets.map((row) => deleteRow<DropPoint>(db.dropPoints, row.id)))
    await get().hydrate()
    if (targets.length > 0) await triggerAvoidanceRecalc()
  }
}))
