import { useMemo, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Table, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import type { AvoidanceItem, AvoidancePlan, SprayRecord } from '@/types'
import { DEFAULT_SAFE_INTERVAL_DAYS } from '@/types'
import AvoidanceStatusTag from '@/components/common/AvoidanceStatusTag'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { avoidanceStore } from '@/stores/avoidanceStore'
import { db } from '@/hooks/usePersistentStore'
import { isPlanStale, safeDateReached } from '@/utils/avoidance'
import { uid } from '@/utils/id'

interface SprayFormValues {
  orchardId: string
  sprayDate: dayjs.Dayjs
  safeIntervalDays: number
  note: string
}

/** 花期打药避让：托管队登记打药地块 / 日期 / 安全间隔期，技术员重算并执行避让转移 */
export default function AvoidancePage(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const sprays = usePersistentStore(avoidanceStore, (state) => state.sprays)
  const plans = usePersistentStore(avoidanceStore, (state) => state.plans)

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<SprayRecord | null>(null)
  const [form] = Form.useForm<SprayFormValues>()

  const orchardName = (id: string): string => orchards.find((item) => item.id === id)?.name ?? '未知地块'
  const dropLabel = (id: string): string => {
    const point = dropPoints.find((item) => item.id === id)
    return point ? `${point.code}（${orchardName(point.orchardId)}）` : '—'
  }

  /** 实时失效判定：打药日期 / 间隔期、备用点容量任何一项对不上即失效 */
  const staleOf = (plan: AvoidancePlan): boolean =>
    isPlanStale(plan, sprays.find((item) => item.id === plan.sprayId), dropPoints)

  const planOfSpray = useMemo(() => {
    const map = new Map<string, AvoidancePlan>()
    plans.forEach((plan) => map.set(plan.sprayId, plan))
    return map
  }, [plans])

  function openCreate(): void {
    setEditing(null)
    form.setFieldsValue({
      orchardId: orchards[0]?.id,
      sprayDate: dayjs(),
      safeIntervalDays: DEFAULT_SAFE_INTERVAL_DAYS,
      note: ''
    })
    setModalOpen(true)
  }

  function openEdit(spray: SprayRecord): void {
    setEditing(spray)
    form.setFieldsValue({
      orchardId: spray.orchardId,
      sprayDate: dayjs(spray.sprayDate),
      safeIntervalDays: spray.safeIntervalDays,
      note: spray.note
    })
    setModalOpen(true)
  }

  async function submit(): Promise<void> {
    const values = await form.validateFields()
    const row: SprayRecord = {
      id: editing?.id ?? uid('sp'),
      orchardId: values.orchardId,
      sprayDate: values.sprayDate.format('YYYY-MM-DD'),
      safeIntervalDays: Number(values.safeIntervalDays) || DEFAULT_SAFE_INTERVAL_DAYS,
      note: values.note?.trim() ?? ''
    }
    const existed = plans.find((plan) => plan.sprayId === row.id)
    await avoidanceStore.getState().saveSpray(row)
    message.success(
      existed
        ? `打药登记已保存，关联避让安排已按新日期 / 间隔期自动重算`
        : `打药登记已保存（${orchardName(row.orchardId)} · ${row.sprayDate}）`
    )
    setModalOpen(false)
  }

  async function removeSpray(spray: SprayRecord): Promise<void> {
    const linked = plans.find((plan) => plan.sprayId === spray.id)
    if (linked && linked.status !== '已转回') {
      message.error('该打药登记的避让安排尚未转回，请先完成或删除避让安排')
      return
    }
    await avoidanceStore.getState().removeSpray(spray.id)
    message.success('打药登记及其避让安排已删除')
  }

  async function generate(spray: SprayRecord): Promise<void> {
    const affected = colonies.filter((colony) => colony.currentOrchardId === spray.orchardId)
    if (affected.length === 0) {
      message.warning(`蜂群台账里当前没有在「${orchardName(spray.orchardId)}」的蜂群`)
      return
    }
    const plan = await avoidanceStore.getState().generatePlan(spray.id)
    if (!plan) return
    if (plan.shortageBoxes > 0) {
      message.warning(`已重算：${plan.affectedCount} 群受影响，${plan.shortageBoxes} 箱缺点位，已退回托管队`)
    } else {
      message.success(`已重算：${plan.affectedCount} 群受影响，备用点已就近安排`)
    }
  }

  async function runAction(plan: AvoidancePlan, action: 'begin' | 'arrive' | 'return'): Promise<void> {
    try {
      if (action === 'begin') {
        await avoidanceStore.getState().beginTransit(plan.id)
        message.success('受影响蜂群已记「转场中」')
      } else if (action === 'arrive') {
        await avoidanceStore.getState().arrive(plan.id)
        message.success('蜂群到点记「在园」，所在地块与投放点群号已一起换过去')
      } else {
        await avoidanceStore.getState().returnHome(plan.id)
        message.success('安全间隔期已过，蜂群已转回原投放点')
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  async function removePlan(plan: AvoidancePlan): Promise<void> {
    if (plan.status === '转场中' || plan.status === '在园') {
      message.error('避让转移执行中，不能删除；请先完成转回')
      return
    }
    await db.avoidances.delete(plan.id)
    await avoidanceStore.getState().hydrate()
    message.success('避让安排已删除（打药登记保留）')
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">花期打药避让</h2>
          <p className="page-sub">
            托管队登记打药地块、日期与安全间隔期；技术员照蜂群台账的实际所在地块找出受影响群，就近分配装得下的非打药地备用点。
            备用点容量不够即排队、写明差几箱并退回托管队。打药日期或备用点容量一改动，避让安排立即失效重算，重算完前不能导出为可执行方案。
          </p>
        </div>
        <Button type="primary" onClick={openCreate}>
          登记打药
        </Button>
      </div>

      <Alert
        type="info"
        showIcon
        message="执行流程：重算分配 → 开始转场（蜂群记「转场中」）→ 到点（记「在园」，地块与投放点群号一起换）→ 安全间隔期满转回原投放点"
      />

      <Card size="small" title={`打药登记（托管队记录 · ${sprays.length} 条）`}>
        <Table<SprayRecord>
          dataSource={sprays}
          rowKey="id"
          pagination={false}
          columns={[
            { title: '打药地块', key: 'orchard', render: (_, record) => orchardName(record.orchardId) },
            { title: '打药日期', dataIndex: 'sprayDate', key: 'date', width: 120 },
            {
              title: '安全间隔期',
              key: 'interval',
              width: 190,
              render: (_, record) => {
                const safeDate = dayjs(record.sprayDate).add(record.safeIntervalDays, 'day').format('YYYY-MM-DD')
                return (
                  <Space size={4}>
                    <Tag color="orange">{record.safeIntervalDays} 天</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      解禁 {safeDate}
                    </Typography.Text>
                  </Space>
                )
              }
            },
            {
              title: '受影响群',
              key: 'affected',
              width: 100,
              render: (_, record) => {
                const count = colonies.filter((colony) => colony.currentOrchardId === record.orchardId).length
                return <Tag color={count > 0 ? 'red' : 'default'}>{count} 群</Tag>
              }
            },
            { title: '药剂 / 备注', dataIndex: 'note', key: 'note', render: (value: string) => value || '—' },
            {
              title: '避让安排',
              key: 'plan',
              width: 150,
              render: (_, record) => {
                const plan = planOfSpray.get(record.id)
                if (!plan) return <Tag>尚未重算</Tag>
                return <AvoidanceStatusTag status={plan.status} stale={staleOf(plan)} />
              }
            },
            {
              title: '操作',
              key: 'action',
              width: 240,
              render: (_, record) => {
                const plan = planOfSpray.get(record.id)
                return (
                  <Space size={4}>
                    <Button size="small" type="link" onClick={() => openEdit(record)}>
                      编辑
                    </Button>
                    <Button size="small" type="link" onClick={() => void generate(record)}>
                      {plan ? '重新重算' : '重算避让'}
                    </Button>
                    <Popconfirm title="删除该打药登记？关联的避让安排会一并删除" onConfirm={() => void removeSpray(record)}>
                      <Button size="small" type="link" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                )
              }
            }
          ]}
        />
      </Card>

      {plans
        .filter((plan) => plan.status !== '已转回')
        .map((plan) => {
          const spray = sprays.find((item) => item.id === plan.sprayId)
          const stale = staleOf(plan)
          const canReturn = plan.status === '在园' && safeDateReached(plan.safeDate)
          return (
            <PlanCard
              key={plan.id}
              plan={plan}
              orchardTitle={spray ? orchardName(spray.orchardId) : '未知地块'}
              stale={stale}
              canReturn={canReturn}
              dropLabel={dropLabel}
              onRecalc={() =>
                avoidanceStore
                  .getState()
                  .recalcPlan(plan.id)
                  .then(() => message.success('已按当前打药登记与备用点容量重新重算'))
                  .catch(() => message.error('重算失败'))
              }
              onBegin={() => void runAction(plan, 'begin')}
              onArrive={() => void runAction(plan, 'arrive')}
              onReturn={() => void runAction(plan, 'return')}
              onRemove={() => void removePlan(plan)}
            />
          )
        })}

      {plans.filter((plan) => plan.status === '已转回').length > 0 ? (
        <Card size="small" title={`已完成转回（${plans.filter((plan) => plan.status === '已转回').length} 单）`}>
          <Table<AvoidancePlan>
            dataSource={plans.filter((plan) => plan.status === '已转回')}
            rowKey="id"
            size="small"
            pagination={false}
            columns={[
              { title: '打药地块', key: 'orchard', render: (_, record) => orchardName(sprays.find((s) => s.id === record.sprayId)?.orchardId ?? '') },
              { title: '打药日期', dataIndex: 'sprayDate', key: 'date', width: 120 },
              { title: '解禁日期', dataIndex: 'safeDate', key: 'safe', width: 120 },
              { title: '转回群数', dataIndex: 'affectedCount', key: 'count', width: 100, render: (value: number) => `${value} 群` },
              { key: 'status', title: '状态', width: 120, render: (_, record) => <AvoidanceStatusTag status={record.status} /> }
            ]}
          />
        </Card>
      ) : null}

      <Modal
        title={editing ? '编辑打药登记' : '登记打药'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        okText="保存"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="orchardId" label="打药地块" rules={[{ required: true, message: '请选择打药地块' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={orchards.map((item) => ({ value: item.id, label: `${item.name}（${item.crop}）` }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="sprayDate" label="打药日期" rules={[{ required: true, message: '请选择打药日期' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="safeIntervalDays" label="安全间隔期（天）" rules={[{ required: true }]}>
                <InputNumber min={1} max={90} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="note" label="药剂 / 登记备注">
            <Input.TextArea rows={2} placeholder="如 吡虫啉，花后临时补防蚜虫" />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            保存后若已有避让安排，会立即按新打药日期 / 间隔期失效重算，重算完前原方案不可导出执行。
          </Typography.Paragraph>
        </Form>
      </Modal>
    </div>
  )
}

/** 单条避让安排卡片：状态、排队缺口、逐群分配与执行动作 */
interface PlanCardProps {
  plan: AvoidancePlan
  orchardTitle: string
  stale: boolean
  canReturn: boolean
  dropLabel: (id: string) => string
  onRecalc: () => void
  onBegin: () => void
  onArrive: () => void
  onReturn: () => void
  onRemove: () => void
}

function PlanCard(props: PlanCardProps): JSX.Element {
  const { plan, orchardTitle, stale, canReturn, dropLabel, onRecalc, onBegin, onArrive, onReturn, onRemove } = props
  return (
    <Card
      size="small"
      title={
        <Space wrap>
          <span>
            {orchardTitle} · 打药 {plan.sprayDate} · {plan.safeIntervalDays} 天后解禁（{plan.safeDate}）
          </span>
          <AvoidanceStatusTag status={plan.status} stale={stale} />
          <Tag color="blue">受影响 {plan.affectedCount} 群</Tag>
        </Space>
      }
      extra={
        <Space>
          <Button size="small" onClick={onRecalc}>
            立即重算
          </Button>
          <Popconfirm
            title="删除避让安排？打药登记会保留"
            onConfirm={onRemove}
            disabled={plan.status === '转场中' || plan.status === '在园'}
          >
            <Button size="small" danger type="link" disabled={plan.status === '转场中' || plan.status === '在园'}>
              删除安排
            </Button>
          </Popconfirm>
        </Space>
      }
    >
      {stale ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="error"
          showIcon
          message="安排已失效：打药日期或备用点容量发生改动"
          description="请点击「立即重算」重新分配；重算完成前，该安排不能当可执行方案导出或开始转场。"
        />
      ) : null}
      {plan.shortageBoxes > 0 ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message={`备用点容量不足：${plan.shortageBoxes} 箱排队待位，还差 ${plan.shortageBoxes} 箱，已退回托管队协调点位`}
          description={plan.shortageNote}
        />
      ) : null}

      <Table<AvoidanceItem>
        dataSource={plan.items}
        rowKey={(item) => item.colonyId}
        size="small"
        pagination={false}
        columns={[
          { title: '群号', dataIndex: 'colonyCode', key: 'code', width: 90 },
          { title: '原投放点', key: 'origin', width: 180, render: (_, record) => (record.originalDropId ? dropLabel(record.originalDropId) : '（未登记投放点）') },
          {
            title: '备用投放点（近的优先）',
            key: 'backup',
            render: (_, record) =>
              record.backupDropId ? (
                <Space size={4}>
                  <Tag color="green">{dropLabel(record.backupDropId)}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {record.distanceKm} km
                  </Typography.Text>
                </Space>
              ) : (
                <Tag color="red">排队中 · 差 {record.shortageBoxes} 箱</Tag>
              )
          },
          {
            title: '当前状态',
            key: 'phase',
            width: 110,
            render: (_, record) => {
              const phase =
                plan.status === '待执行'
                  ? '待转场'
                  : plan.status === '转场中'
                    ? record.backupDropId
                      ? '转场中'
                      : '排队中'
                    : plan.status === '在园'
                      ? record.backupDropId
                        ? '在备用点'
                        : '排队中'
                      : '已转回'
              return <Tag>{phase}</Tag>
            }
          }
        ]}
      />

      <Space style={{ marginTop: 12 }} wrap>
        <Button
          type="primary"
          disabled={stale || plan.status !== '待执行' || plan.shortageBoxes > 0}
          onClick={onBegin}
        >
          开始转场（群记转场中）
        </Button>
        <Button disabled={stale || plan.status !== '转场中'} onClick={onArrive}>
          到点登记（记在园，换地块与群号）
        </Button>
        <Button disabled={stale || plan.status !== '在园' || !canReturn} onClick={onReturn}>
          {plan.status === '在园' && !canReturn
            ? `间隔期未满（${plan.safeDate} 解禁），暂不能转回`
            : '安全间隔期满，转回原投放点'}
        </Button>
      </Space>
    </Card>
  )
}
