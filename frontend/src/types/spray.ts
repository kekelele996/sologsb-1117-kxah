/** SprayRecord 打药登记（托管队填写） */
export interface SprayRecord {
  id: string
  /** 打药地块 */
  orchardId: string
  /** 打药日期 */
  sprayDate: string
  /** 安全间隔期（天） */
  safetyIntervalDays: number
  /** 药剂名称 */
  pesticide: string
  /** 登记人（托管队） */
  operator: string
  note: string
}

/** 避让执行阶段 */
export const AVOIDANCE_STAGES = ['待转出', '转场中', '已避让', '转回中', '已转回'] as const
export type AvoidanceStage = (typeof AVOIDANCE_STAGES)[number]

/** AvoidanceAssignment 单群避让安排 */
export interface AvoidanceAssignment {
  colonyId: string
  colonyCode: string
  /** 原投放点（打药地块上） */
  fromDropId: string
  /** 备用投放点，空串表示排队中 */
  toDropId: string
  /** 原投放点 → 备用投放点 距离（km） */
  distanceKm: number
  /** 排队缺口箱数（0 表示已安置） */
  shortageBoxes: number
  stage: AvoidanceStage
}

/** AvoidancePlan 一次打药对应的避让方案（重算即整体失效重来） */
export interface AvoidancePlan {
  id: string
  sprayId: string
  /** 计算时间（ISO） */
  computedAt: string
  /** 输入指纹：打药日期/间隔期、备用点容量与占用、蜂群所在地块任一变化即失效 */
  fingerprint: string
  /** 安全间隔期过后的可转回日期 */
  safeReturnDate: string
  assignments: AvoidanceAssignment[]
}
