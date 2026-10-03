import { Tag } from 'antd'
import type { AvoidanceStatus } from '@/types'

const COLORS: Record<AvoidanceStatus, string> = {
  待执行: 'gold',
  转场中: 'processing',
  在园: 'blue',
  已转回: 'green',
  退回托管队: 'red'
}

export interface AvoidanceStatusTagProps {
  status: AvoidanceStatus
  /** 是否失效待重算（重算完前不能导出执行） */
  stale?: boolean
}

/** 避让安排状态标签 */
export default function AvoidanceStatusTag({ status, stale }: AvoidanceStatusTagProps): JSX.Element {
  return (
    <span>
      <Tag color={COLORS[status]} data-testid="avoidance-status-tag">
        {status}
      </Tag>
      {stale ? <Tag color="red">失效待重算</Tag> : null}
    </span>
  )
}
