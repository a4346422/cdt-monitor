# CDT Monitor

阿里云多账号 CDT 免费流量调度器。跑在 Cloudflare Worker 上，用一个 Durable Object 串行化调度，
让一台域名始终指向「当前当班」的那台 ECS，并在账号免费额度快耗尽时自动换到下一个账号。

> 部署步骤见 [CDT-Monitor-部署清单.md](CDT-Monitor-部署清单.md)。本文只讲**是什么**和**为什么**。

---

## 1. 它解决什么问题

阿里云 CDT（云数据传输）每月给每个账号一份**免费公网流量**。用超了要按量付费。
所以想长期白嫖，需要：

1. 盯着当月用量，别让它超过免费额度；
2. 一个账号快用完了，把服务切到另一个账号的机器上；
3. 域名要跟着切过去，用户无感知。

这个 Worker 就是干这三件事的。

---

## 2. 核心模型

### 2.1 账号池

配置里有一个 **N 个实例的列表**（默认空，需要手动添加），每个实例 = 一个阿里云账号 + 一台 ECS。

**任意时刻只有一台机器在运行**，其余全部处于 `StopCharging`（节省停机，不收计算费）。

```
账号A  ECS  Running       ← 当班
账号B  ECS  StopCharging
账号C  ECS  StopCharging
```

一个 Cloudflare DNS 记录（A 记录）始终指向**当班实例的公网 IP**。

### 2.2 耗尽判定

账号进入「耗尽」状态，当且仅当：

| 条件 | 说明 |
|---|---|
| 当月流量 ≥ 流量阈值 | 阈值按**实例地域**自动选用中国内地或非中国内地的一项 |
| **或** 当月账单 ≥ 账单阈值 | 账单阈值是**账号级**的（见 §5.3） |

两条都是 `0 = 关闭`。判定结果写入该账号的状态，面板上显示为「耗尽」徽章。

### 2.3 轮换触发

每一分钟巡检一次，满足任一条件就换班：

- **当班账号耗尽** → 立刻换；
- **定时轮换到期**：`rotationIntervalMinutes` 到了 → 换（`0` = 关闭，即只按流量/账单换）。

换班时**按列表顺序**找下一个**未耗尽**的账号。

### 2.4 全部耗尽

如果**所有**账号都耗尽：

1. 把当班实例**强制节省停机**（省钱，这是第一优先级）；
2. 推送 Telegram 通知；
3. 记录 `fusedMonth`，本月不再调度；
4. **下个月自动恢复**，不需要人工干预。

> **没有独立的"熔断状态机"。** 早期版本有一套 `isFused` / `fuseMonth` 状态，曾经因为旧状态缺少
> `fuseMonth` 字段而把引擎永久锁死。「全部账号耗尽」现在只是一个**计算结果**，不是一个需要维护的状态。

---

## 3. 关键机制

### 3.1 Durable Object 是权威状态

所有状态存在 **Durable Object 的 SQLite**（键 `state_v2`），不是 KV。

DO 天然单线程，所有请求在 `run()` 里排队串行执行，替代了 KV 上做不了的并发写。
KV 只用来存配置（`app_config`）、会话（`session:*`）和日志（`app_logs`）。

**不迁移旧版本状态。** 首次运行直接给一份干净的状态。

### 3.2 查询失败一律 fail-closed

**流量或账单查不出来时，绝不当作 0。** 直接进入保护状态并告警。

这是整套系统里最重要的一条约束：如果把查询失败当成"用量为 0"，就会在一个已经超额 200 GB 的账号上
继续跑一整天，然后收到一张真实的账单。

### 3.3 停机必须确认进入节省停机

发一条 `StopInstance` **不等于**停机成功。只有当实例状态是 `Stopped` 且
`StoppedMode = StopCharging` 时，才认为真的省钱了。

如果实例是 `Stopped` 但模式不是 `StopCharging`（比如 `KeepCharging`），**报故障**，
因为那台机器还在计费。

### 3.4 换班是一个三阶段状态机

换班跨多个巡检周期推进，进度存在 `state.transition` 里：

```
WAIT_START        启动目标实例，轮询到 Running
   ↓
WAIT_DNS_DRAIN    更新 Cloudflare DNS，然后等待 dnsDrainSeconds（默认 60s）
                  —— 给旧 IP 上的连接留时间自然断开，避免正在传输的请求被切断
   ↓
WAIT_STOP         停掉原当班实例，轮询确认 StopCharging
   ↓
完成              当班切换，推送报告
```

- 整个流程有 `transitionTimeoutMinutes`（默认 10 分钟）超时保护，超时发**专用**的
  「⚠️ 【换班异常报告】」，包含两台实例的状态。
- 目标实例启动失败**不会立刻报故障**，而是在 `startRetrySeconds`（默认 180 秒）窗口内
  每分钟重试；窗口用尽才报 `START_FAILED`。这覆盖了抢占式实例的 `OperationDenied.NoStock`
  （可用区暂时没有库存）这种稍后就好了的情况。
- 遇到已经是 `Stopping` 的实例**不会重复发停机指令**（重复调用会返回 `IncorrectInstanceStatus`）。

三种换班类型，报告标题不同：`SHIFT`（正常轮换）、`TEMPORARY`、`RECOVERY`。

### 3.5 保活

如果当班实例**意外停止**（被抢占、被误操作），自动把它拉起来。这是抢占式实例的必备能力。

限制条件（缺一不可）：

- 只对**当班**实例生效；
- 该账号**未耗尽**；
- `keepAlive` 开关打开（全局默认开，单账号可三态覆盖）；
- 如果在限定运行时段内（`scheduleEnabled`）。

**耗尽优先级高于保活** —— 额度用完了就算机器停了也不会去拉。

### 3.6 DDNS 跟随

换班完成后，用 Cloudflare API 把 A 记录改成新当班实例的公网 IP。

> **跨账号换班时 IP 一定会变**（不同实例、不同 EIP），这是设计使然。
> 只有同一实例的重启（保活）IP 才不变。

每个实例的 EIP 是**固定已知**的，所以域名实际上是在几个固定 IP 之间切换，比依赖重启后随机分配更可靠。

### 3.7 密钥不落明文

- 面板回传配置时，AK / SK / CF Token / TG Bot Token 全部打码成 `ab****yz`；
- 提交时如果发现是打码值，按 `id` 匹配旧配置**还原真实值**；
- 如果匹配不上（例如 `id` 丢了），**直接报 400 拒绝保存**，而不是把真实密钥静默覆写成 `****`。

### 3.8 配置合并不会丢字段

`sanitizeConfig` 的三段合并顺序是 **默认值 → 已有配置 → 提交内容**。

面板不会回传所有字段，缺失的必须沿用旧值。早期版本少了中间那一段，导致面板没回传的字段
被默认值悄悄覆盖（余额开关就是这么丢的）。

### 3.9 保护状态能自己解除

故障的触发条件可能已经不成立（例如实例被释放后，用户已把它从配置里删掉）。

- **自动解除**：`INSTANCE_NOT_FOUND` 且触发它的实例已不在配置里 → 下一轮巡检自动解除；
- **手动解除**：点「状态对账并清除故障」，会**重新核实真实状态**再决定清不清。
  如果还有实例不存在，会明确告诉你是哪几台，而不是笼统拒绝。

---

## 4. 面板

| 区域 | 内容 |
|---|---|
| 顶部 | 当班账号、立即巡检、设置、退出 |
| 保护状态横幅 | 故障码 + 消息 + **该故障怎么解**的提示 + 清除按钮 |
| 熔断横幅 | 全部账号额度耗尽 |
| 实例卡片 | 见下 |
| 日志 | 最近 60 条（AUDIT / ERROR / INFO） |

**实例卡片**显示：

```
实例 1                              [当班] [耗尽] [Running]
cn-hongkong · 非中国内地 · 额度 200GB

流量            12.3 / 188 GB
[==================--------------]
账单（账号级）  USD 0.0195 / USD 5.00
[==------------------------------]
该实例费用      USD 0.0038
账户余额        USD 0.00
公网 IP         47.x.x.x
停机模式        节省停机          ← 仅 Stopped 时显示
保活            开启
```

- **实例状态**带颜色：`Running` 绿 / `Stopped` 灰 / `Stopping`·`Starting` 黄 / 异常红；
- **停机模式**只在实例是 `Stopped` 时出现，**这是判断“是否真的在省钱”的唯一依据**：
  - `节省停机`（绿）= `StopCharging`，不收计算费；
  - `KeepCharging，仍在计费`（红）= 机器**还在扣钱**，要去控制台改成节省停机；
  - 所有停机指令都由后端写死 `StoppedMode: StopCharging`，网页上改不掉；
- **公网 IP** 是实例当前的**实际** IP。如果和配置里的「备用 EIP」不一致，会红字提示
  `⚠️ 与配置的 EIP 不一致：...` —— 这说明 DDNS 指向的可能不是你以为的那台；
- **账单（账号级）**是阈值判定用的数字；**该实例费用**只是展示，用来对照；
- **账户余额**来自 `QueryAccountBalance`，查询失败显示「查询失败」而不是假的 `0`。

---

## 5. 阿里云计费事实

这一节是踩坑踩出来的，改动相关逻辑前请先读。

### 5.1 CDT 免费额度分两个独立的池

**按账号计**，且中国内地与非中国内地**互不通用**：

| 池 | 免费额度 |
|---|---|
| 中国内地 | 20 GB / 月 |
| 非中国内地 | 200 GB / 月 |

（总量自 2025-06-01 起由 200 GB 提高到 220 GB。）

**所以阈值必须按地域分类，不能用一个数字。**

`ListCdtInternetTraffic` 返回的 `TrafficDetails` 里**同时包含两个池的记录**，
必须按 `BusinessRegionId` 过滤到实例所属的类别再求和。

> 早期版本把所有行直接相加，导致：中国内地实例的用量被算进 200 GB 池，
> 而它真实的额度只有 20 GB —— 按 188 GB 的阈值永远不会触发，一路超额到扣钱。
> `temp/run-tests.mjs` 里有专门的回归断言锁住这个行为。

**注意 `cn-hongkong` 属于「非中国内地」** —— 它虽然叫 `cn-` 开头，但走的是 200 GB 池。

### 5.2 账单是事后兜底，不是预防手段

- 免费额度内的用量按**单价 0** 记账，所以 `PretaxAmount` 在额度用尽前**恒为 0**；
- BSS 数据**延迟约 24 小时**，当月数据官方说明仅供参考，不能用于对账。

**结论：想防止超额，只能靠流量阈值。账单阈值的作用是给流量监控覆盖不到的部分兜底** ——
按量计费的 ECS、云盘、快照、EIP、其他产品的公网流量、以及超出额度后的流量费。

### 5.3 账单阈值按账号级

`DescribeInstanceBill` 可以按 `InstanceID` 过滤，但**阈值判定用的是不带 `InstanceID` 的整账号金额**。

原因：CDT 免费额度是**账号级**的。只盯着一台实例，会漏掉同账号下第二台 ECS、
EIP、OSS 等一切在花钱的东西 —— 它们烧的是同一个额度池。

面板同时显示两个数字，方便对照。

### 5.4 EIP 保有费（配置费）

| 场景 | 收费 |
|---|---|
| EIP 直接绑定到 VPC 类型 ECS 实例，且账号 EIP 配额 ≤ 2000 | **免费** |
| 其他（未绑定 / 闲置 / 非 ECS 直绑） | **按小时收费** |

中国香港地域单价 **0.04 元/小时/个**（2026-07-01 起，此前 0.056），国际站约 **$0.005/小时**。

**含义：**

- 实例 `StopCharging` 但 **EIP 仍绑着** → 不产生保有费（这也是轮换能做到零固定成本的原因）；
- 实例**被释放**或 EIP 被**解绑** → EIP 变 `Available`，**开始按小时漏钱**。

> 释放实例时**记得一并释放对应的 EIP**。三个闲置 EIP 一个月就是 $10+，
> 比 ECS 计算费高两个数量级。

面板的「账单接口诊断」会调用 `DescribeEips` 列出每个 EIP 的状态、绑定对象和计费方式，
`Status = Available` 就是正在漏钱。

### 5.5 接口细节

| 项 | 值 |
|---|---|
| CDT 流量 | `cdt.aliyuncs.com`，`RegionId=cn-hongkong`，`Version=2021-08-13`，`ListCdtInternetTraffic` |
| ECS | `ecs.<regionId>.aliyuncs.com`，`Version=2014-05-26` |
| BSS（中国站） | `business.aliyuncs.com`，`region cn-hangzhou` |
| BSS（国际站） | `business.ap-southeast-1.aliyuncs.com`，`region ap-southeast-1` |
| 余额 | `QueryAccountBalance` → `Data.AvailableAmount` + `Data.Currency` |
| 账单 | `DescribeInstanceBill`，`BillingCycle` + `Granularity=MONTHLY`，求和 `PretaxAmount` |
| 签名 | POST form-urlencoded + HMAC-SHA1，`secret + "&"` |

**`DescribeInstanceBill` 没有 `PageSize` 参数**，分页只有 `MaxResults`（默认 20，最大 300）+ `NextToken`。
不看 `NextToken` 会静默漏掉条目。本实现用 `MaxResults=300` 并循环 `NextToken`。

`bssopenapi.aliyuncs.com` **不在官方端点表里**。用错端点时 `QueryAccountBalance` 会把失败
吞成余额 `-`，面板上看不出任何异常 —— 所以端点必须写对。

**重试策略**：3 次指数退避，网络错误 / 5xx / 429 / 限流 / `Timestamp` 错误重试；
4xx 鉴权错误**不重试**。

---

## 6. RAM 权限

给每个账号的 RAM 用户授权以下动作（**七个**，最后一个是可选的）：

| 动作 | 用途 |
|---|---|
| `cdt:ListCdtInternetTraffic` | 查当月 CDT 流量 |
| `ecs:DescribeInstances` | 查实例状态、节省停机模式、公网 IP |
| `ecs:StartInstance` | 启动实例（换班 / 保活） |
| `ecs:StopInstance` | 停机实例 |
| `ecs:DescribeEips` | 诊断用：列出 EIP 状态（可选，但强烈建议） |
| `bss:DescribeAcccount` | 查账户余额 |
| `bss:DescribeInstanceBill` | 查当月账单（按账单阈值轮换时才需要） |

> ⚠️ **`bss:DescribeAcccount` 是阿里云自己的拼写（三个 c），不是笔误。**
> `bss:QueryAccountBalance` 是 **OpenAPI 的动作名**，不是 RAM 权限名。
> 网上大量资料写成后者，照着填会得到 `NoPermission`。**不要"修正"它。**

---

## 7. 配置项

### 7.1 全局（`system`）

| 项 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `trafficThresholdChina` | 18 | 1–20 | 中国内地流量阈值 GB |
| `trafficThresholdIntl` | 188 | 1–200 | 非中国内地流量阈值 GB |
| `billThreshold` | 0 | 0–1e6 | 账单阈值（账号级），0 = 关闭 |
| `rotationIntervalMinutes` | 0 | 0–525600 | 定时轮换，0 = 关闭 |
| `keepAlive` | `true` | — | 保活全局默认 |
| `dnsDrainSeconds` | 60 | 0–600 | DNS 切换后的缓冲等待 |
| `transitionTimeoutMinutes` | 10 | 1–60 | 换班超时 |
| `startRetrySeconds` | 180 | 0–3600 | 启动重试窗口 |
| `billCheckMinutes` | 30 | 5–1440 | 账单查询节流间隔 |
| `dailyReport` | `false` | — | 每日日报 |
| `dailyReportTime` | `23:58` | `HH:mm` | 日报时间（北京时间） |

默认流量阈值 = 额度的 90%（中国内地 18 / 非中国内地 188），留出安全余量。

**常见组合：**

- **纯定时轮换**：流量和账单阈值设 0，`rotationIntervalMinutes` 设 1440（一天一换）
- **纯流量**：`rotationIntervalMinutes` = 0，流量阈值按需设
- **纯账单**：流量阈值设 0，账单阈值按需设（注意 §5.2 的 24 小时延迟）

### 7.2 单实例（可覆盖全局）

| 项 | 说明 |
|---|---|
| `name` | 显示名 |
| `ak` / `sk` | 该账号的 AccessKey |
| `regionId` | 实例地域（24 个可选，决定走哪个 CDT 池） |
| `instanceId` | ECS 实例 ID |
| `siteType` | `international` / `china` —— **决定 BSS 端点**，与流量池无关 |
| `eip` | 该实例的 EIP（用于 DDNS 与诊断比对，可留空） |
| `trafficThresholdGb` | 流量阈值覆盖（留空 = 跟随全局） |
| `billThreshold` | 账单阈值覆盖（留空 = 跟随全局） |
| `keepAlive` | 三态：`null` 跟随全局 / `true` 强制开 / `false` 强制关 |
| `scheduleEnabled` + `startTime`/`stopTime` | 限定运行时段，支持跨午夜 |
| `remark` | 备注 |

> **`siteType` 和流量池是两个独立的东西。**
> `cn-hongkong` 的账号 `siteType = international`（走国际站 BSS），
> 但它的流量走**非中国内地 200 GB 池**。不要混为一谈。

---

## 8. 故障码与恢复

故障时引擎**停止一切调度操作**（`halted`），直到故障被清除。

| 故障码 | 含义 | 怎么解 |
|---|---|---|
| `ACCOUNT_NOT_CONFIGURED` | 实例缺 AK/SK/地域/实例 ID | 设置里补全 |
| `CONFIG_INVALID` | 配置参数不合法 | 设置里按提示范围修正 |
| `CDT_QUERY_FAILED` | 流量查询失败（fail-closed） | 检查 `cdt:ListCdtInternetTraffic` 权限 |
| `BILL_QUERY_FAILED` | 账单查询失败（fail-closed） | 检查 `bss:DescribeInstanceBill` 权限，或把账单阈值设为 0 |
| `ECS_DESCRIBE_FAILED` | 查实例状态失败 | 检查 `ecs:DescribeInstances` 权限 |
| `INSTANCE_NOT_FOUND` | 实例不存在或已被释放 | 设置里删除该实例或改成正确的实例 ID（**可自动解除**） |
| `START_FAILED` | 重试窗口内启动始终失败 | 确认实例可用（常见于库存不足） |
| `STOP_FAILED` | 停机指令失败 | 检查 `ecs:StopInstance` 权限 |
| `STOP_CHARGING_NOT_CONFIRMED` | 停机但没进节省停机模式 | 控制台确认实例状态，那台机器还在计费 |
| `FUSE_STOP_CHARGING_NOT_CONFIRMED` | 全部耗尽后停机未确认 | 同上 |
| `DNS_UPDATE_FAILED` | Cloudflare DNS 更新失败 | 检查 API Token / Zone ID / Record ID / 域名 |
| `TRANSITION_TIMEOUT` | 换班超时未收敛 | 确认两台实例状态后重试 |
| `TRANSITION_CONFIG_INVALID` | 换班配置不合法 | 检查账号列表 |
| `TARGET_NOT_RUNNING_AFTER_DNS` | DNS 切换后目标实例又停了 | 检查该实例 |
| `UNKNOWN_TRANSITION_STEP` | 未知换班步骤 | 报告 bug |

**清除故障**（面板上的「状态对账并清除故障」）不是简单地把 `fault` 置空，而是：

1. 如果所有账号都已耗尽 → 确认熔断状态；
2. 如果换班在推进 → 重新查两台实例，**如果实际已经完成就直接确认完成**，没完成就保留进度；
3. **重新核实所有已配置实例是否都存在** —— 还有不存在的就拒绝清除，并列出是哪几台；
4. 都通过了才清除，并写审计日志。

---

## 9. 已知限制

1. **同账号下的第二台机器看不见流量。** CDT 额度是账号级的，但监控只查配置里那一台的状态。
   如果同账号还有别的机器在跑，它会一起烧额度，而面板看不出来。账单阈值能事后发现，但已经晚了。
2. **账单阈值挡不住当天超额。** BSS 有 24 小时延迟（§5.2）。
3. **国际站的 BSS 接口可用性靠实测。** 官方文档提到国际站可能对部分 BSS 接口返回
   `NotApplicable`。用面板的「账单接口诊断」先验证再依赖。
4. **`workers.dev` 上的登录页没有速率限制**，而面板后面存着 AK/SK。建议：
   - 用 `ADMIN_PASS` secret 而不是 KV 里的密码；
   - 或者挂自定义域名 + Cloudflare Access；
   - 并在 `wrangler.toml` 里关掉 `preview_urls`（预览 URL 是第二个入口）。
5. **账户余额 0 是正常的。** 按量付费（后付费）账号没有预存余额。
   真正该看的数字是「账单（账号级）」。

---

## 10. 测试

`temp/check-docs.py` 校验**文档与代码是否一致**（故障码、RAM 动作、配置默认值与范围）：

```bash
python temp/check-docs.py
```

`temp/run-tests.mjs` 是一套纯离线的引擎测试（不需要网络、不需要真实阿里云账号），
用假的 ECS / CDT / BSS 响应驱动整个 `runEngineCron`。

```bash
node temp/run-tests.mjs
```

覆盖的关键行为：

- 流量按 `BusinessRegionId` 分类求和（删掉过滤会让断言失败）
- 账单阈值按账号级判定，实例级仅展示
- 查询失败 fail-closed，不当成 0
- 停机必须确认 `Stopped + StopCharging`
- 启动重试窗口内的重试与超时后报错
- 换班三阶段的推进、DNS 缓冲、超时
- 全部耗尽 → 强制停机 + 熔断 + 次月恢复
- 实例缺失的保护与恢复路径（含自动解除）
- 配置合并不丢字段
- **生成的页面客户端脚本语法正确**（防止模板字面量转义把页面搞成白屏）
- **实例卡片真的把停机模式渲染出来**（把客户端脚本跑起来，直接断言它产出的 HTML）

前一条是踩过坑加的：`\n` 写在生成页面的模板字面量里会被解释成真正的换行，
把单引号字符串拆成两行 → 整段脚本 SyntaxError → 白屏。
