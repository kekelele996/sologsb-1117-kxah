/** 打药避让单状态 */
export const AVOIDANCE_STATUSES = ['待执行', '转场中', '在园', '已转回', '退回托管队'] as const
export type AvoidanceStatus = (typeof AVOIDANCE_STATUSES)[number]

/** 打药登记（托管队记录）：地块、日期、安全间隔期 */
export interface SprayRecord {
  id: string
  /** 打药地块 */
  orchardId: string
  /** 打药日期 YYYY-MM-DD */
  sprayDate: string
  /** 安全间隔期（天），到期后蜂群方可转回 */
  safeIntervalDays: number
  /** 药剂 / 登记备注 */
  note: string
}

/** 单群避让明细 */
export interface AvoidanceItem {
  colonyId: string
  /** 群号 */
  colonyCode: string
  /** 原投放点（打药地块内） */
  originalDropId: string
  /** 备用投放点；空串表示容量不够、排队中 */
  backupDropId: string
  /** 原投放点 → 备用点距离（km） */
  distanceKm: number
  /** 排队缺口（箱）：1 = 该群尚无点可去 */
  shortageBoxes: number
}

/** 避让安排（技术员依据打药登记重算） */
export interface AvoidancePlan {
  id: string
  /** 关联打药登记 */
  sprayId: string
  /** 重算依据快照：打药日期 */
  sprayDate: string
  /** 重算依据快照：安全间隔期（天） */
  safeIntervalDays: number
  /** 解禁日期 = 打药日期 + 安全间隔期 */
  safeDate: string
  status: AvoidanceStatus
  /** 受影响蜂群数 */
  affectedCount: number
  items: AvoidanceItem[]
  /** 排队总缺口（箱） */
  shortageBoxes: number
  /** 排队说明（退回托管队时写明还差几箱） */
  shortageNote: string
  /** 重算时全部候选备用点的容量快照（备用点容量一改即失效） */
  capacitySnapshot: Record<string, number>
  /** 是否失效待重算（重算完前不能当可执行方案导出） */
  stale: boolean
  createdAt: string
}

/** 安全间隔期默认天数（旧数据缺字段时补齐） */
export const DEFAULT_SAFE_INTERVAL_DAYS = 7

/** 旧数据升级后按默认补齐打药登记字段 */
export function normalizeSpray(raw: Partial<SprayRecord>): SprayRecord {
  return {
    id: raw.id ?? '',
    orchardId: raw.orchardId ?? '',
    sprayDate: raw.sprayDate ?? '',
    safeIntervalDays:
      typeof raw.safeIntervalDays === 'number' && Number.isFinite(raw.safeIntervalDays) && raw.safeIntervalDays > 0
        ? Math.floor(raw.safeIntervalDays)
        : DEFAULT_SAFE_INTERVAL_DAYS,
    note: raw.note ?? ''
  }
}

/** 旧数据升级后按默认补齐避让安排字段 */
export function normalizePlan(raw: Partial<AvoidancePlan>): AvoidancePlan {
  return {
    id: raw.id ?? '',
    sprayId: raw.sprayId ?? '',
    sprayDate: raw.sprayDate ?? '',
    safeIntervalDays:
      typeof raw.safeIntervalDays === 'number' && Number.isFinite(raw.safeIntervalDays) && raw.safeIntervalDays > 0
        ? Math.floor(raw.safeIntervalDays)
        : DEFAULT_SAFE_INTERVAL_DAYS,
    safeDate: raw.safeDate ?? '',
    status: raw.status ?? '待执行',
    affectedCount: typeof raw.affectedCount === 'number' ? raw.affectedCount : Array.isArray(raw.items) ? raw.items.length : 0,
    items: Array.isArray(raw.items) ? raw.items : [],
    shortageBoxes: typeof raw.shortageBoxes === 'number' ? raw.shortageBoxes : 0,
    shortageNote: raw.shortageNote ?? '',
    capacitySnapshot: raw.capacitySnapshot ?? {},
    stale: typeof raw.stale === 'boolean' ? raw.stale : true,
    createdAt: raw.createdAt ?? ''
  }
}
