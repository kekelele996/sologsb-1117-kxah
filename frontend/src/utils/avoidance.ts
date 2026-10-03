import dayjs from 'dayjs'
import type { AvoidanceAssignment, AvoidancePlan, BeeColony, DropPoint, Orchard, SprayRecord } from '@/types'
import { distanceKm, toDateValue } from '@/utils/geo'
import { uid } from '@/utils/id'

/** 安全间隔期缺省天数（旧数据升级补齐用） */
export const DEFAULT_SAFETY_INTERVAL_DAYS = 3

/** 安全间隔期过后的可转回日期（打药日 + 间隔天数） */
export function safeReturnDateOf(spray: Pick<SprayRecord, 'sprayDate' | 'safetyIntervalDays'>): string {
  const base = toDateValue(spray.sprayDate)
  if (Number.isNaN(base)) return ''
  return dayjs(base)
    .add(spray.safetyIntervalDays || 0, 'day')
    .format('YYYY-MM-DD')
}

/**
 * 方案输入指纹：打药地块/日期/间隔期、投放点容量与占用、蜂群所在地块与状态。
 * 任一变化即视为方案失效，需重算后才可导出执行；执行避让动作后会同步刷新指纹。
 */
export function fingerprintOf(spray: SprayRecord, dropPoints: DropPoint[], colonies: BeeColony[]): string {
  const points = dropPoints
    .map((item) => `${item.id}:${item.orchardId}:${item.capacityBoxes}:${[...item.colonyCodes].sort().join('+')}`)
    .sort()
  const cols = colonies
    .map((item) => `${item.id}:${item.code}:${item.currentOrchardId}:${item.status}`)
    .sort()
  return JSON.stringify({
    spray: [spray.id, spray.orchardId, spray.sprayDate, spray.safetyIntervalDays],
    points,
    cols
  })
}

/** 方案是否已失效（打药登记被改、备用点容量被改、蜂群台账变动等） */
export function planIsStale(
  plan: AvoidancePlan,
  spray: SprayRecord | undefined,
  dropPoints: DropPoint[],
  colonies: BeeColony[]
): boolean {
  if (!spray) return true
  return plan.fingerprint !== fingerprintOf(spray, dropPoints, colonies)
}

/**
 * 计算一次打药的避让方案：
 * 受影响群 = 台账里实际所在地块为打药地块、且已在园或正在转场的群；
 * 每群在其它地块的投放点中按距离就近挑一个装得下的，装不下则排队并记缺口箱数。
 */
export function computeAvoidancePlan(
  spray: SprayRecord,
  colonies: BeeColony[],
  dropPoints: DropPoint[],
  orchards: Orchard[]
): AvoidancePlan {
  const sprayedOrchard = orchards.find((item) => item.id === spray.orchardId)
  const affected = colonies
    .filter((item) => item.currentOrchardId === spray.orchardId && (item.status === '在园' || item.status === '转场中'))
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))

  // 备用点剩余容量（打药地块上的投放点一律排除）
  const remaining = new Map<string, number>()
  dropPoints.forEach((point) => {
    if (point.orchardId === spray.orchardId) return
    remaining.set(point.id, Math.max(0, point.capacityBoxes - point.colonyCodes.length))
  })

  const assignments: AvoidanceAssignment[] = affected.map((colony) => {
    // 起点：该群在打药地块上所在的投放点，找不到则退用打药地块坐标
    const fromPoint = dropPoints.find(
      (point) => point.orchardId === spray.orchardId && point.colonyCodes.includes(colony.code)
    )
    const origin = fromPoint ?? sprayedOrchard
    const chosen = origin
      ? dropPoints
          .filter((point) => point.orchardId !== spray.orchardId && (remaining.get(point.id) ?? 0) > 0)
          .map((point) => ({ point, km: distanceKm(origin, point) }))
          .sort((a, b) => a.km - b.km)[0]
      : undefined
    if (chosen) {
      remaining.set(chosen.point.id, (remaining.get(chosen.point.id) ?? 0) - 1)
      return {
        colonyId: colony.id,
        colonyCode: colony.code,
        fromDropId: fromPoint?.id ?? '',
        toDropId: chosen.point.id,
        distanceKm: chosen.km,
        shortageBoxes: 0,
        stage: '待转出' as const
      }
    }
    // 备用点容量不够：排队并写明还差几箱（每群按 1 箱计）
    return {
      colonyId: colony.id,
      colonyCode: colony.code,
      fromDropId: fromPoint?.id ?? '',
      toDropId: '',
      distanceKm: 0,
      shortageBoxes: 1,
      stage: '待转出' as const
    }
  })

  return {
    id: uid('plan'),
    sprayId: spray.id,
    computedAt: new Date().toISOString(),
    fingerprint: fingerprintOf(spray, dropPoints, colonies),
    safeReturnDate: safeReturnDateOf(spray),
    assignments
  }
}

/** 方案中排队缺口合计（箱） */
export function queuedShortage(plan: AvoidancePlan): number {
  return plan.assignments.reduce((sum, item) => sum + item.shortageBoxes, 0)
}
