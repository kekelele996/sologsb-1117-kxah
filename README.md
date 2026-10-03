# 蜜蜂授粉路线规划器（gbbeeroute）

面向果园托管服务队与蜂场技术员，把「果园地块 → 花期 → 蜂群投放点 → 转场路线」排成季内可执行的授粉安排，解决花期重叠时蜂群撞车、转场距离过远、投放点与地块不匹配的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21817>

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地）
```

`.env` 可调：

```
COMPOSE_PROJECT_NAME=gbbeeroute
FRONTEND_PORT=21817
VITE_AMAP_KEY=            # 可选，留空即自动降级为本地 SVG 网格视图
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 |
| 语言 | TypeScript（`tsc --noEmit` 类型检查零错误） |
| UI 组件库 | Ant Design 5 |
| 地图 | 高德地图 JS API 2.0（可选，key 走 `VITE_AMAP_KEY`） |
| 状态管理 | Zustand |
| 路由 | React Router 6（nginx `try_files` 回落） |
| 构建 | Vite 5 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、高德地图 Key 与降级策略

- 在 `.env` 里填写 `VITE_AMAP_KEY=<你的 key>` 后**重新构建**（`docker compose up -d --build`），地图将使用高德 JS API 渲染地块、投放点与转场折线；
- **未配置 key 或脚本加载失败时，`RouteMap` 自动降级为本地 SVG 网格视图**：按经纬度线性映射渲染地块、投放点与转场折线，支持点选拾取坐标；
- **构建与运行都不依赖该 key**：未配置 key 时不会注入任何外部脚本（避免无谓请求与报错），Docker 构建零网络依赖即可通过；
- 页面右上角始终显示当前数据源（高德地图 JS API / 本地 SVG 网格视图）。

## 四、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21817
npm run build      # 类型检查 + 生产构建
```

## 五、目录结构

```
sologsb-1117/
├── docker-compose.yml          # 顶层 name: gbbeeroute，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # orchard / colony / droppoint / route / spray + index
│       ├── stores/             # orchardStore / colonyStore / droppointStore / routeStore / avoidanceStore
│       ├── components/common/  # RouteMap / FlowerWindowBar / StatusTag / AvoidanceStatusTag / CoordPicker
│       ├── hooks/              # useAmap / usePersistentStore
│       ├── pages/              # SchedulePage / OrchardsPage / ColoniesPage / AvoidancePage / RoutesPage / ExportPage
│       ├── router/index.tsx
│       └── utils/              # geo.ts / avoidance.ts / export.ts / id.ts
```

## 六、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Orchard 果园地块 | 地块名、作物、面积、经纬度、盛花期起止、需蜂强度（箱/亩）、园主联系方式、可达性、历史授粉年份 | `orchards` |
| BeeColony 蜂群 | 群号、蜂种、群势（足框）、箱型、当前所在地块、状态（待投放/在园/转场中/回场）、最近检查日期、健康备注 | `colonies` |
| DropPoint 投放点 | 所属地块、坐标、编号、可容纳箱数、遮阴条件、水源距离、投放时间窗、撤场时间、责任人、安排群号 | `dropPoints` |
| TransitRoute 转场路线 | 出发/到达投放点、预计里程与耗时、车辆类型、出发时刻、风险备注、实际记录 | `routes` |
| SprayRecord 打药登记 | 托管队登记：打药地块、打药日期、安全间隔期（天）、药剂备注 | `sprays` |
| AvoidancePlan 避让安排 | 技术员重算：受影响群、原投放点、就近备用点、距离、排队缺口、状态（待执行/转场中/在园/已转回/退回托管队）、容量快照与失效标记 | `avoidances` |

- 数据库名 `gbbeeroute`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史投放点补齐「可容纳箱数」（默认 8 箱）；
- `version(3)` 新增打药登记与避让安排两张表，旧数据缺失字段统一按默认补齐（安全间隔期默认 7 天，避让单默认标记为待重算）；读取水合时会再兜底归一化一次；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 七、主要页面

| 路由 | 功能 |
| --- | --- |
| `/` | 季内授粉安排总表：花期条带 + 已投放群体，冲突（同一蜂群被排入花期重叠的不同地块）标红并汇总 |
| `/orchards` | 果园地块管理：面积与需蜂强度自动算建议箱数、可达性标记、花期重叠提示、投放点维护（含坐标拾取） |
| `/colonies` | 蜂群台账：按群势与状态筛选，批量改状态、批量记录检查备注 |
| `/avoidance` | 花期打药避让：托管队登记打药地块/日期/安全间隔期，技术员重算就近备用点并执行转移 |
| `/routes` | 转场路线规划：地图依次选点生成顺序与里程，拖动或上下移动调整顺序并实时重算，写回路线表 |
| `/export` | 导出授粉安排清单 / 转场路线表 / 打药避让执行单（CSV）、全量 JSON 备份，并提供横向/纵向打印视图 |

## 八、计算约定

- 建议箱数 = ⌈面积(亩) × 需蜂强度(箱/亩)⌉，最少 1 箱；
- 转场里程按 Haversine 球面距离累计，耗时按平均 32 km/h + 0.25 h 装卸估算；
- 花期重叠：两地块盛花期区间交集天数 ≥ 1 即视为重叠；同一群号在重叠期内被排入两个地块 → 冲突。

### 花期打药避让

- **受影响群**：蜂群台账中 `currentOrchardId` 等于打药地块的群；
- **备用点**：排除本打药地的全部投放点，按「原投放点 → 备用点」Haversine 距离就近优先；容量 = 可容纳箱数 − 点上非避让群号 − 其他生效避让单的落位群（避让转移到点后群号已挂到备用点，计算时会扣除本单托管群，避免重复计数）；
- **排队**：装不下的群无备用点，逐群记 1 箱缺口、整体「退回托管队」并写明还差几箱，缺口不消不能开始转场；
- **执行流转**：待执行 →（开始转场，群记「转场中」）→ 转场中 →（到点登记，群记「在园」，所在地块与投放点群号一起换到备用点）→ 在园 →（打药日期 + 安全间隔期到解禁日，转回原投放点、群号挂回原点、地块恢复）→ 已转回；
- **失效重算**：打药日期 / 安全间隔期一改（保存打药登记即自动重算）、备用点容量一改或删点（投放点保存 / 删除即自动重算全部未结束安排），避让安排立即失效；页面顶部有「立即重算」，重算完成前标记「失效待重算」，导出页不将其计入可执行执行单、导出按钮禁用；
- **执行中的单**重算时沿用既定备用点，只按当前容量复核缺口，不临时改派。
