import { useMemo, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import dayjs from 'dayjs'
import type { AvoidanceAssignment, AvoidancePlan, AvoidanceStage, SprayRecord } from '@/types'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { sprayStore } from '@/stores/sprayStore'
import { planIsStale, queuedShortage, safeReturnDateOf } from '@/utils/avoidance'
import { downloadCsv } from '@/utils/export'
import { uid } from '@/utils/id'

const STAGE_COLORS: Record<AvoidanceStage, string> = {
  待转出: 'default',
  转场中: 'gold',
  已避让: 'green',
  转回中: 'gold',
  已转回: 'blue'
}

interface SprayFormValues {
  orchardId: string
  sprayDate: dayjs.Dayjs
  safetyIntervalDays: number
  pesticide: string
  operator: string
  note: string
}

/** 打药避让调度：托管队登记打药，技术员重算避让方案并逐步执行转出/到点/转回 */
export default function SprayPage(): JSX.Element {
  const sprays = usePersistentStore(sprayStore, (state) => state.sprays)
  const plans = usePersistentStore(sprayStore, (state) => state.plans)
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<SprayRecord | null>(null)
  const [form] = Form.useForm<SprayFormValues>()

  const today = dayjs().format('YYYY-MM-DD')

  function orchardName(id: string): string {
    return orchards.find((item) => item.id === id)?.name ?? '未知地块'
  }

  function pointLabel(id: string): string {
    const point = dropPoints.find((item) => item.id === id)
    return point ? `${point.code}（${orchardName(point.orchardId)}）` : '—'
  }

  const staleMap = useMemo(() => {
    const map = new Map<string, boolean>()
    plans.forEach((plan) => {
      map.set(plan.id, planIsStale(plan, sprays.find((item) => item.id === plan.sprayId), dropPoints, colonies))
    })
    return map
  }, [plans, sprays, dropPoints, colonies])

  function openCreate(): void {
    setEditing(null)
    form.setFieldsValue({
      orchardId: orchards[0]?.id ?? '',
      sprayDate: dayjs(),
      safetyIntervalDays: 3,
      pesticide: '',
      operator: '托管队',
      note: ''
    })
    setModalOpen(true)
  }

  function openEdit(spray: SprayRecord): void {
    setEditing(spray)
    form.setFieldsValue({
      orchardId: spray.orchardId,
      sprayDate: dayjs(spray.sprayDate),
      safetyIntervalDays: spray.safetyIntervalDays,
      pesticide: spray.pesticide,
      operator: spray.operator,
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
      safetyIntervalDays: Number(values.safetyIntervalDays) || 0,
      pesticide: values.pesticide?.trim() ?? '',
      operator: values.operator?.trim() ?? '',
      note: values.note?.trim() ?? ''
    }
    await sprayStore.getState().saveSpray(row)
    message.success(`打药登记已保存，${orchardName(row.orchardId)} 的避让方案需重算后执行`)
    setModalOpen(false)
  }

  async function recompute(sprayId: string): Promise<void> {
    await sprayStore.getState().recompute(sprayId)
    message.success('避让方案已重算，可导出执行')
  }

  function exportPlan(spray: SprayRecord, plan: AvoidancePlan): void {
    const rows = plan.assignments.map((item) => ({
      colonyCode: item.colonyCode,
      from: pointLabel(item.fromDropId),
      to: item.toDropId ? pointLabel(item.toDropId) : '排队中',
      distanceKm: item.toDropId ? item.distanceKm : '—',
      stage: item.stage,
      shortageBoxes: item.shortageBoxes > 0 ? item.shortageBoxes : ''
    }))
    downloadCsv(`避让方案-${orchardName(spray.orchardId)}-${spray.sprayDate}.csv`, rows as unknown as Record<string, unknown>[], [
      { key: 'colonyCode', label: '群号' },
      { key: 'from', label: '原投放点' },
      { key: 'to', label: '备用投放点' },
      { key: 'distanceKm', label: '距离(km)' },
      { key: 'stage', label: '执行阶段' },
      { key: 'shortageBoxes', label: '还差几箱' }
    ])
    message.success('避让方案已导出')
  }

  function assignmentColumns(plan: AvoidancePlan, stale: boolean) {
    const canReturn = !plan.safeReturnDate || today >= plan.safeReturnDate
    return [
      { title: '群号', dataIndex: 'colonyCode', key: 'code', width: 90, render: (value: string) => <Tag color="cyan">{value}</Tag> },
      { title: '原投放点', key: 'from', render: (_: unknown, record: AvoidanceAssignment) => pointLabel(record.fromDropId) },
      {
        title: '备用投放点',
        key: 'to',
        render: (_: unknown, record: AvoidanceAssignment) =>
          record.toDropId ? (
            pointLabel(record.toDropId)
          ) : (
            <Tag color="red">排队中 · 还差 {record.shortageBoxes} 箱</Tag>
          )
      },
      {
        title: '距离',
        dataIndex: 'distanceKm',
        key: 'km',
        width: 90,
        render: (value: number, record: AvoidanceAssignment) => (record.toDropId ? `${value} km` : '—')
      },
      {
        title: '阶段',
        dataIndex: 'stage',
        key: 'stage',
        width: 100,
        render: (value: AvoidanceStage) => <Tag color={STAGE_COLORS[value]}>{value}</Tag>
      },
      {
        title: '操作',
        key: 'action',
        width: 180,
        render: (_: unknown, record: AvoidanceAssignment) => {
          if (stale) return <Typography.Text type="secondary">待重算</Typography.Text>
          if (!record.toDropId) return <Typography.Text type="secondary">退回托管队</Typography.Text>
          if (record.stage === '待转出') {
            return (
              <Button size="small" type="link" onClick={() => void sprayStore.getState().depart(plan.id, record.colonyId)}>
                转出（记转场中）
              </Button>
            )
          }
          if (record.stage === '转场中') {
            return (
              <Button size="small" type="link" onClick={() => void sprayStore.getState().arrive(plan.id, record.colonyId)}>
                到点（记在园）
              </Button>
            )
          }
          if (record.stage === '已避让') {
            const btn = (
              <Button
                size="small"
                type="link"
                disabled={!canReturn}
                onClick={() => void sprayStore.getState().startReturn(plan.id, record.colonyId)}
              >
                转回原投放点
              </Button>
            )
            return canReturn ? btn : <Tooltip title={`安全间隔期至 ${plan.safeReturnDate} 结束`}>{btn}</Tooltip>
          }
          if (record.stage === '转回中') {
            return (
              <Button size="small" type="link" onClick={() => void sprayStore.getState().finishReturn(plan.id, record.colonyId)}>
                转回到位（记在园）
              </Button>
            )
          }
          return <Tag color="blue">已转回</Tag>
        }
      }
    ]
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">打药避让调度</h2>
          <p className="page-sub">
            托管队登记打药地块、日期与安全间隔期；技术员按蜂群台账找出受影响群，就近安排装得下的备用投放点，
            容量不够的排队退回托管队。打药日期或备用点容量一改动，方案即失效，需重算后才能导出执行。
          </p>
        </div>
        <Button type="primary" onClick={openCreate}>
          新增打药登记
        </Button>
      </div>

      <Card size="small" title={`打药登记（托管队，${sprays.length} 条）`} style={{ marginBottom: 16 }}>
        <Table<SprayRecord>
          dataSource={sprays}
          rowKey="id"
          size="small"
          pagination={false}
          columns={[
            { title: '打药地块', key: 'orchard', render: (_, record) => orchardName(record.orchardId) },
            { title: '打药日期', dataIndex: 'sprayDate', key: 'date', width: 120 },
            {
              title: '安全间隔期',
              dataIndex: 'safetyIntervalDays',
              key: 'interval',
              width: 110,
              render: (value: number) => `${value} 天`
            },
            {
              title: '可转回日期',
              key: 'safeReturn',
              width: 120,
              render: (_, record) => safeReturnDateOf(record) || '—'
            },
            { title: '药剂', dataIndex: 'pesticide', key: 'pesticide', render: (value: string) => value || '—' },
            { title: '登记人', dataIndex: 'operator', key: 'operator', width: 110, render: (value: string) => value || '—' },
            { title: '备注', dataIndex: 'note', key: 'note', render: (value: string) => value || '—' },
            {
              title: '操作',
              key: 'action',
              width: 140,
              render: (_, record) => (
                <Space>
                  <Button size="small" type="link" onClick={() => openEdit(record)}>
                    编辑
                  </Button>
                  <Button size="small" type="link" danger onClick={() => void sprayStore.getState().removeSpray(record.id)}>
                    删除
                  </Button>
                </Space>
              )
            }
          ]}
        />
      </Card>

      {sprays.map((spray) => {
        const plan = plans.find((item) => item.sprayId === spray.id)
        const stale = plan ? staleMap.get(plan.id) ?? true : false
        const shortage = plan ? queuedShortage(plan) : 0
        const queuedCount = plan ? plan.assignments.filter((item) => item.shortageBoxes > 0).length : 0
        return (
          <Card
            key={spray.id}
            size="small"
            style={{ marginBottom: 16 }}
            title={
              <Space>
                <span>避让方案：{orchardName(spray.orchardId)}（{spray.sprayDate} 打药）</span>
                {!plan && <Tag>未计算</Tag>}
                {plan && stale && <Tag color="red">已失效 · 需重算</Tag>}
                {plan && !stale && <Tag color="green">可执行</Tag>}
              </Space>
            }
            extra={
              <Space>
                <Button size="small" type="primary" onClick={() => void recompute(spray.id)}>
                  {plan ? '重算方案' : '计算避让方案'}
                </Button>
                <Tooltip title={!plan ? '请先计算避让方案' : stale ? '方案已失效，重算完前不能作为可执行方案导出' : ''}>
                  <Button size="small" disabled={!plan || stale} onClick={() => plan && exportPlan(spray, plan)}>
                    导出避让方案（CSV）
                  </Button>
                </Tooltip>
              </Space>
            }
          >
            {!plan && (
              <Typography.Text type="secondary">
                尚未计算。点击「计算避让方案」后，将按蜂群台账找出 {orchardName(spray.orchardId)} 上受影响的群并就近安排备用投放点。
              </Typography.Text>
            )}
            {plan && (
              <>
                {stale && (
                  <Alert
                    type="error"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="打药日期、备用点容量或蜂群台账已变更，本方案随即失效，请重算；重算完前不得作为可执行方案导出。"
                  />
                )}
                {shortage > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message={`备用点容量不够：${queuedCount} 群排队中，共还差 ${shortage} 箱，已退回托管队协调。`}
                  />
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  计算时间 {dayjs(plan.computedAt).format('YYYY-MM-DD HH:mm')} · 安全间隔期 {spray.safetyIntervalDays} 天 · 可转回日期{' '}
                  {plan.safeReturnDate || '—'}
                </Typography.Text>
                <Table<AvoidanceAssignment>
                  dataSource={plan.assignments}
                  rowKey="colonyId"
                  size="small"
                  pagination={false}
                  style={{ marginTop: 8 }}
                  columns={assignmentColumns(plan, stale)}
                />
              </>
            )}
          </Card>
        )
      })}

      <Modal
        title={editing ? '编辑打药登记' : '新增打药登记'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        width={640}
      >
        <Form form={form} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="orchardId" label="打药地块" rules={[{ required: true, message: '请选择打药地块' }]}>
                <Select options={orchards.map((item) => ({ value: item.id, label: `${item.name}（${item.crop}）` }))} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="sprayDate" label="打药日期" rules={[{ required: true, message: '请选择打药日期' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="safetyIntervalDays" label="安全间隔期（天）" rules={[{ required: true }]}>
                <InputNumber min={0} max={30} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="pesticide" label="药剂名称">
                <Input placeholder="如 吡虫啉（防蚜）" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="operator" label="登记人（托管队）">
                <Input placeholder="如 托管一队" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="note" label="备注">
                <Input.TextArea rows={2} placeholder="如 花期临时打药，已通知蜂场避让" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  )
}
