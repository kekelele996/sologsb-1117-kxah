import type { AvoidanceItem, AvoidancePlan, BeeColony, DropPoint, Orchard, SprayRecord } from '@/types'
import { distanceKm } from '@/utils/geo'

/** 安全日期（打药日期 + 间隔天数） */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map((item) => Number(item))
  if (!year || !month || !day) return ''
  const ms = Date.UTC(year, month - 1, day) + Math.max(0, Math.floor(days)) * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

/** 当前日期是否已到（或超过）解禁日 */
export function safeDateReached(safeDate: string, today = new Date()): boolean {
  if (!safeDate) return false
  const [year, month, day] = safeDate.split('-').map((item) => Number(item))
  if (!year || !month || !day) return false
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Date.UTC(year, month - 1, day) <= now
}

export interface AvoidanceContext {
  spray: SprayRecord
  orchards: Orchard[]
  colonies: BeeColony[]
  dropPoints: DropPoint[]
  /** 其他生效中的避让单（非已转回），其已落位群会占用备用点容量 */
  otherPlans: AvoidancePlan[]
}

export interface AvoidanceAllocation {
  items: AvoidanceItem[]
  /** 排队总缺口（箱） */
  shortageBoxes: number
  shortageNote: string
  /** 参与重算的全部候选备用点容量快照 */
  capacitySnapshot: Record<string, number>
}

/**
 * 各备用点的「既占用量」：
 * 投放点群号里凡属于开放中避让单（本单 + 其他单）托管的群一律先扣除
 * （到点后群号已随避让转移挂到备用点，不能再按静态群号重复计数），
 * 再叠加其他避让单的落位群；本单自己的群由后续分配 / 校验逐群加上。
 */
function baseOccupancy(candidates: DropPoint[], otherPlans: AvoidancePlan[], selfPlan?: AvoidancePlan): Map<string, number> {
  const managed = new Set<string>()
  otherPlans.forEach((plan) => plan.items.forEach((item) => managed.add(item.colonyCode)))
  selfPlan?.items.forEach((item) => managed.add(item.colonyCode))

  const occupied = new Map<string, number>()
  candidates.forEach((point) => {
    occupied.set(point.id, point.colonyCodes.filter((code) => !managed.has(code)).length)
  })
  otherPlans.forEach((plan) => {
    plan.items.forEach((item) => {
      if (!item.backupDropId) return
      occupied.set(item.backupDropId, (occupied.get(item.backupDropId) ?? 0) + 1)
    })
  })
  return occupied
}

/** 候选备用点容量快照 */
function snapshotOf(candidates: DropPoint[]): Record<string, number> {
  const snapshot: Record<string, number> = {}
  candidates.forEach((point) => {
    snapshot[point.id] = point.capacityBoxes
  })
  return snapshot
}

/**
 * 打药避让分配：
 * 受影响群 = 台账里实际所在地块正是打药地块的群；
 * 备用点 = 不在这块打药地的投放点，按「原投放点 → 备用点」距离近的优先；
 * 容量 = 备用点容量 − 非避让托管群号 − 其他生效避让单落位群；
 * 装不下的群排队，记明还差几箱。
 */
export function computeAvoidanceAllocation(ctx: AvoidanceContext): AvoidanceAllocation {
  const { spray, orchards, colonies, dropPoints, otherPlans } = ctx
  const orchard = orchards.find((item) => item.id === spray.orchardId)

  const affected = colonies
    .filter((colony) => colony.currentOrchardId === spray.orchardId)
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))

  // 原投放点：该群群号所在且位于打药地块内的点；找不到则回退到打药地块任一点，再不行回退到地块坐标
  const originOf = (colony: BeeColony): { point?: DropPoint; longitude: number; latitude: number } => {
    const own = dropPoints.find((point) => point.orchardId === spray.orchardId && point.colonyCodes.includes(colony.code))
    if (own) return { point: own, longitude: own.longitude, latitude: own.latitude }
    const anyPoint = dropPoints.find((point) => point.orchardId === spray.orchardId)
    if (anyPoint) return { longitude: anyPoint.longitude, latitude: anyPoint.latitude }
    return { longitude: orchard?.longitude ?? 0, latitude: orchard?.latitude ?? 0 }
  }

  // 不在这块打药地的点，都是候选备用点
  const candidates = dropPoints.filter((point) => point.orchardId !== spray.orchardId)
  const occupied = baseOccupancy(candidates, otherPlans)

  const items: AvoidanceItem[] = []
  let shortageBoxes = 0

  affected.forEach((colony) => {
    const origin = originOf(colony)
    const ranked = candidates
      .map((point) => ({ point, km: distanceKm(origin, point) }))
      .sort((a, b) => a.km - b.km)

    const room = ranked.find((entry) => (occupied.get(entry.point.id) ?? 0) < entry.point.capacityBoxes)

    if (room) {
      occupied.set(room.point.id, (occupied.get(room.point.id) ?? 0) + 1)
      items.push({
        colonyId: colony.id,
        colonyCode: colony.code,
        originalDropId: origin.point?.id ?? '',
        backupDropId: room.point.id,
        distanceKm: room.km,
        shortageBoxes: 0
      })
    } else {
      shortageBoxes += 1
      items.push({
        colonyId: colony.id,
        colonyCode: colony.code,
        originalDropId: origin.point?.id ?? '',
        backupDropId: '',
        distanceKm: ranked[0]?.km ?? 0,
        shortageBoxes: 1
      })
    }
  })

  const shortageNote =
    shortageBoxes > 0
      ? `备用点容量不足，${shortageBoxes} 箱蜂群排队待位（还差 ${shortageBoxes} 箱），退回托管队协调点位`
      : ''

  return { items, shortageBoxes, shortageNote, capacitySnapshot: snapshotOf(candidates) }
}

/** 依据打药登记重算避让安排（待执行单整体重排；执行中的单沿用既定备用点，只校验容量） */
export function buildAvoidancePlan(
  spray: SprayRecord,
  ctx: Omit<AvoidanceContext, 'spray'>,
  prev?: AvoidancePlan
): AvoidancePlan {
  const safeDate = addDays(spray.sprayDate, spray.safeIntervalDays)
  const candidates = ctx.dropPoints.filter((point) => point.orchardId !== spray.orchardId)
  const capacitySnapshot = snapshotOf(candidates)

  // 已开始执行（转场中 / 在园）的单：既定落位不动，仅按当前容量重新判定缺口
  const executing = prev && (prev.status === '转场中' || prev.status === '在园')
  if (executing && prev) {
    const occupied = baseOccupancy(candidates, ctx.otherPlans, prev)
    let shortageBoxes = 0
    const items = prev.items.map((item) => {
      if (!item.backupDropId) {
        shortageBoxes += 1
        return { ...item, shortageBoxes: 1 }
      }
      const cap = candidates.find((point) => point.id === item.backupDropId)?.capacityBoxes ?? 0
      const fits = (occupied.get(item.backupDropId) ?? 0) < cap
      occupied.set(item.backupDropId, (occupied.get(item.backupDropId) ?? 0) + 1)
      if (!fits) shortageBoxes += 1
      return { ...item, shortageBoxes: fits ? 0 : 1 }
    })
    return {
      ...prev,
      sprayDate: spray.sprayDate,
      safeIntervalDays: spray.safeIntervalDays,
      safeDate,
      affectedCount: prev.affectedCount,
      items,
      shortageBoxes,
      shortageNote:
        shortageBoxes > 0
          ? `避让执行中原备用点容量变化，${shortageBoxes} 箱位置需重新协调（还差 ${shortageBoxes} 箱）`
          : '',
      capacitySnapshot,
      stale: shortageBoxes > 0
    }
  }

  const allocation = computeAvoidanceAllocation({ spray, ...ctx })
  const affectedCount = allocation.items.length
  const status: AvoidancePlan['status'] = allocation.shortageBoxes > 0 ? '退回托管队' : '待执行'
  return {
    id: prev?.id ?? '',
    sprayId: spray.id,
    sprayDate: spray.sprayDate,
    safeIntervalDays: spray.safeIntervalDays,
    safeDate,
    status,
    affectedCount,
    items: allocation.items,
    shortageBoxes: allocation.shortageBoxes,
    shortageNote: allocation.shortageNote,
    capacitySnapshot,
    stale: false,
    createdAt: prev?.createdAt ?? ''
  }
}

/** 重算结果是否已失效（导出前的最后一道闸门：日期 / 容量任何一项对不上即不可执行） */
export function isPlanStale(plan: AvoidancePlan, spray: SprayRecord | undefined, dropPoints: DropPoint[]): boolean {
  if (plan.status === '已转回') return false
  if (plan.stale) return true
  if (!spray) return true
  if (plan.sprayDate !== spray.sprayDate || plan.safeIntervalDays !== spray.safeIntervalDays) return true
  return Object.entries(plan.capacitySnapshot).some(([pointId, cap]) => {
    const point = dropPoints.find((item) => item.id === pointId)
    // 备用点被删 / 容量改动都算失效；新增点不影响既定点位
    return !point || point.capacityBoxes !== cap
  })
}
