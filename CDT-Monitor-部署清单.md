# CDT Monitor 部署清单

按顺序做完即可。原理与设计说明见 [README-CDT-Monitor.md](README-CDT-Monitor.md)。

> 全程大约 20 分钟。**第 1、5、8 步最容易出错，请重点看。**

---

## 0. 前置条件

- [ ] **Node.js 18+**，能跑 `npx wrangler`
- [ ] **Cloudflare 账号**，且域名托管在 Cloudflare（DDNS 需要）
- [ ] **一个或多个阿里云账号**，每个账号一台 ECS
- [ ] 每台 ECS 有一个**固定 EIP**（不要用自动分配的公网 IP）
- [ ] **Telegram Bot Token + Chat ID**（可选，但强烈建议）
- [ ] 本机时间已同步

### ⚠️ 时区陷阱（必读）

`wrangler.toml` 的 `compatibility_date` **必须填部署当天的 UTC 日期，或更早**。

本机时区是 **UTC+8**，所以本地的"今天"很可能已经是 UTC 的"明天"。填成未来日期后：

- `wrangler deploy --dry-run` **不会报错**（本地检查不出来）
- 真正部署时 Cloudflare API 返回 **错误 10021: Can't set compatibility date in the future**

```bash
# 部署前先确认 UTC 日期
node -e "console.log(new Date().toISOString().slice(0,10))"
```

用这个日期填 `compatibility_date`。

---

## 1. 创建 KV 命名空间

```bash
npx wrangler kv namespace create STATE_KV
```

输出里会有一行 `id = "xxxxxxxxxxxxxxxxxxxx"`，**复制这个 id**。

打开 `wrangler.toml`，替换掉占位符：

```toml
[[kv_namespaces]]
binding = "STATE_KV"
id = "这里粘贴你的 id"      # ← 原值是 REPLACE_WITH_YOUR_KV_NAMESPACE_ID
```

> ⚠️ 忘了替换的话，部署会失败或者绑到一个不存在的命名空间。

### 想让这个 id 不进公开仓库？

仓库里 `wrangler.toml` 的 id 是**占位符**。你自己的真实 id 不要提交，
用 `skip-worktree` 让 git 永远忽略这个文件的本地改动：

```bash
# 把真实 id 填回 wrangler.toml，然后执行一次：
git update-index --skip-worktree wrangler.toml
```

之后 `git status` 看不到这个文件的改动，`git add -A` 也不会把它推上去。

> ⚠️ **代价**：以后你真改了 `wrangler.toml`（比如加路由），git 也会当没看见。
> 想恢复跟踪：`git update-index --no-skip-worktree wrangler.toml`。
> 想确认当前状态：`git ls-files -v wrangler.toml`（`S` 开头 = 已跳过）。
>
> **只用在自己一个人维护的仓库上。** 多人协作时这个静默跳过会很坑。

---

## 2. 确认 wrangler.toml

```toml
name = "cdt-monitor"
main = "worker.js"
compatibility_date = "YYYY-MM-DD"    # ← 第 0 步算出的 UTC 日期

preview_urls = false                 # 关掉预览 URL，少一个暴露面

[[kv_namespaces]]
binding = "STATE_KV"
id = "..."

[[migrations]]
tag = "v1"
new_sqlite_classes = ["EngineCoordinator"]

[[migrations]]
tag = "v2"
deleted_classes = ["EngineCoordinator"]

[triggers]
crons = ["*/2 * * * *"]              # 每 2 分钟巡检（每天 720 次写入，处于 KV 免费额度 1000 次内）
```

> **不需要 Durable Object**：状态已全部移至 KV 存储，免去 DO 时长超额风险。

### ⚠️ `workers_dev`：面板的访问入口

仓库里 `workers_dev` 是**注释掉的**（即保持开启），因为默认只靠
`https://<worker>.<subdomain>.workers.dev` 访问面板。

**代价：这个登录页没有速率限制，而面板后面存着能开机停机的 AK/SK。** 所以：

- [ ] `ADMIN_PASS` 必须用 `npx wrangler secret put ADMIN_PASS` 设一个**强密码**；
- [ ] 有条件的话，挂自定义域名 + Cloudflare Access，然后取消那行的注释：

```toml
routes = [{ pattern = "monitor.你的域名", custom_domain = true }]
workers_dev = false                  # 有了路由再关
```

> ⚠️ **没有路由就关 `workers_dev`，面板会彻底访问不了**（cron 巡检不受影响，
> 只是看不到界面）。恢复：把那行注释掉重新部署。

---

## 3. 设置管理员密码

```bash
npx wrangler secret put ADMIN_PASS
```

**强烈建议用 secret 而不是面板里设密码** —— 面板密码存在 KV 里，而 `workers.dev` 上的登录页没有速率限制。

> 没设 secret 且面板密码为空时，登录接口返回 **503**，面板完全进不去。

---

## 4. 部署

```bash
npx wrangler deploy
```

先干跑一次确认打包正常（**注意干跑查不出 `compatibility_date` 未来日期的问题**）：

```bash
npx wrangler deploy --dry-run
```

部署成功后记录：

- Worker URL（形如 `https://cdt-monitor.<subdomain>.workers.dev`）
- 绑定的 KV 命名空间名称

> 如果 `workers_dev = false` 且没有自定义域名，会没有可访问的 URL。先确认这一点。

---

## 5. 配置阿里云 RAM 权限

给**每个**账号的 RAM 用户授权这七个动作（最后一个是可选的）：

| 动作 | 必需性 |
|---|---|
| `cdt:ListCdtInternetTraffic` | 必需 |
| `ecs:DescribeInstances` | 必需 |
| `ecs:StartInstance` | 必需 |
| `ecs:StopInstance` | 必需 |
| `bss:DescribeAcccount` | 必需（查余额） |
| `bss:DescribeInstanceBill` | 按账单阈值轮换时必需 |
| `ecs:DescribeEips` | 可选，但强烈建议（诊断闲置 EIP） |

> ### ⚠️ `bss:DescribeAcccount` 是三个 c
>
> 这是**阿里云自己的拼写**，不是笔误。
> `bss:QueryAccountBalance` 是 **OpenAPI 的动作名**，**不是 RAM 权限名**。
> 网上大量教程写成后者，照着填会得到 `NoPermission`。
>
> **看到这里请不要再"修正"它。**

---

## 6. 配置分组与 Cloudflare DDNS（可选）

如果不需要域名跟随或轮换，实例保留在「默认分组」即可。

- [ ] 点击顶部导航「📁 分组与 DDNS」，可查看或新增自定义分组（如香港组、测试组）
- [ ] 创建 API Token，权限：`Zone → DNS → Edit`，范围限定到目标 Zone
- [ ] 拿到 **Zone ID**（域名概览页右侧）
- [ ] 创建目标 **A 记录**，拿到 **Record ID**

```bash
# 查 Record ID
curl -s -X GET "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records?type=A&name=<你的域名>" \
  -H "Authorization: Bearer <API_TOKEN>" | grep -o '"id":"[^"]*"' | head -1
```

- [ ] 在分组设置中填入 API Token、Zone ID、Record ID 与解析域名
- [ ] **设置定时轮换周期**：支持按分钟、小时、天设置（如 `2 小时` 或 `1 天`；设为 0 表示不自动轮换）
- [ ] **未开定时轮换时的 DDNS 解析**：若轮换周期设为 0，界面提供「主解析实例」下拉框，可显式指定该组由哪个实例承载 DDNS 域名解析
- [ ] 把 A 记录的 **TTL 设小**（60 秒或 Auto），换班时生效更快
- [ ] **不要开 Cloudflare 代理（橙云）**，否则解析到的是 Cloudflare 的 IP，DDNS 没有意义

---

## 7. 部署后验证

- [ ] 打开 Worker URL，看到登录页（**不是白屏**）
- [ ] 用 `ADMIN_PASS` 登录成功
- [ ] 顶部操作栏显示完整：`+ 添加实例`、`📁 分组与 DDNS`、`⚙️ 全局设置`、`立即巡检`
- [ ] 显示「还没有实例。点「+ 添加实例」开始。」

> **白屏** = 客户端脚本报错。开浏览器控制台看 `SyntaxError`。

---

## 8. 添加实例与分组管理

点「+ 添加实例」，填：

| 字段 | 填什么 |
|---|---|
| 名称 | 随便，比如 `实例 1` |
| 归属分组 | 选择已有分组（默认分组、或自定义分组） |
| ECS 实例 ID | `i-xxxxxxxxxxxxxxxxx` |
| AccessKey ID / Secret | 第 5 步那个 RAM 用户的 AK/SK |
| 地域 | **实例实际所在地域**（决定走哪个 CDT 免费池） |
| 站点类型 | 国际站账号选 `international`，中国站选 `china` |
| 备用 EIP | 该实例绑定的 EIP（可留空） |
| 流量阈值覆盖 | 留空 = 跟随全局 |
| 账单阈值覆盖 | 留空 = 跟随全局 |
| 保活 | 跟随全局 / 开启 / 关闭 |
| 限定运行时段 | 支持小时（00~23）与分钟（00~59）双列下拉框精准选择每日开机与关机时段 |

> ### 💡 实例跨组迁移提示
> 保存实例后，看板上支持直接按住卡片左上角的 `⋮⋮ 拖拽` 手柄，将其拖放至其他分组的虚线区域完成跨组归属调整。

> ### ⚠️ 地域决定额度，别选错
>
> - **中国内地**地域（cn-hangzhou / cn-shanghai / cn-beijing …）→ 免费额度只有 **20 GB/月**
> - **非中国内地**地域（含 **cn-hongkong**）→ 免费额度 **200 GB/月**
>
> `cn-hongkong` 名字带 `cn-` 但属于**非中国内地**，走 200 GB 池。
>
> 选错地域会让阈值判定完全错位：中国内地实例按 188 GB 判，永远不会触发，一路超额扣钱。

保存后回到主页面。

---

## 9. 跑一次账单接口诊断

**这是部署后最该做的一步。** 设置 → 诊断 → 「账单接口诊断」。

它会输出每个账号的：

- 三个 BSS 端点（国际站 / 中国站 / 备用）各自能不能用
- 账户余额（金额 + 币种）
- 四组账单：本月该实例 / 本月整账号 / 本月整账号仅非零 / 上月整账号
- 按产品分组的费用（ecs / eip / oss / cdt …）
- **EIP 列表**：状态、绑定到哪台实例、计费方式

### 怎么读结果

| 现象 | 结论 |
|---|---|
| `ok: true` + 有金额 | 账单接口可用，可以启用账单阈值 |
| `NotApplicable` | 国际站不支持该接口 → **不要启用账单阈值** |
| `NoPermission` | 回第 5 步补 RAM 权限 |
| 余额 `-` 或查询失败 | BSS 端点不对，或权限缺失 |

### 重点看两件事

**1. EIP 有没有闲置的**

```json
"eips": {
  "idle": 2,                    ← 闲置数量，不为 0 就在漏钱
  "eips": [{ "status": "Available", "boundTo": null, ... }]
}
```

`Status = Available` 的 EIP **每小时都在收费**（香港约 $0.005/小时）。
**去阿里云控制台把它们释放掉。**

**2. 有没有 `cdt` 产品条目**

`byProduct` 里如果出现 `cdt`，说明**流量已经超出免费额度在扣费了**。
正常情况只有 `ecs` / `eip` / `oss`。

> 零金额的记录是会被列出来的，所以**没有 `cdt` 条目 = 确实没有流量费**，不是被过滤掉了。

---

## 10. 第一次巡检

- [ ] 点「立即巡检」
- [ ] 等 30 秒刷新，或等下一次 cron（每 2 分钟）
- [ ] 实例卡片显示流量数字、账单、余额、实例状态
- [ ] **停机模式**行显示「节省停机」（如果是「仍在计费」，去控制台改成节省停机）
- [ ] **公网 IP** 行与配置的 EIP 一致（不一致会红字告警）
- [ ] 顶部显示当班账号

如果第一台机器是停着的，保活会在**下一次巡检（2 分钟内）**把它拉起来。

### 建议的阈值设置

| 你的场景 | 流量阈值 | 账单阈值 | 定时轮换 |
|---|---|---|---|
| 一个账号慢慢用 | 默认 | 0 | 0 |
| 多账号分摊流量 | 默认 | 0 | 0 |
| 只想定时换 | 0 | 0 | 1440（一天） |
| 想要成本上限 | 默认 | 按需 | 0 |

> **账单阈值挡不住当天超额**（BSS 延迟 24 小时）。防超额只能靠流量阈值。

---

## 11. 故障处理

故障时引擎停止一切调度，直到故障被清除。面板的红色横幅会显示**故障码 + 消息 + 怎么解**。

**通用恢复流程：**

1. 看横幅上的「👉」提示，按提示处理（通常是去设置里改配置或补权限）；
2. 点「状态对账并清除故障」；
3. 如果还有问题，弹窗会明确告诉你还差什么。

**常见故障：**

| 故障码 | 处理 |
|---|---|
| `INSTANCE_NOT_FOUND` | 设置里删除该实例或改成正确 ID。**从配置里删掉后会自动解除** |
| `CDT_QUERY_FAILED` | 补 `cdt:ListCdtInternetTraffic` 权限 |
| `BILL_QUERY_FAILED` | 补 `bss:DescribeInstanceBill` 权限，或把账单阈值设为 0 |
| `DNS_UPDATE_FAILED` | 检查 CF Token / Zone ID / Record ID / 域名 |
| `STOP_CHARGING_NOT_CONFIRMED` | **去控制台确认** —— 那台机器还在计费 |
| `START_FAILED` | 多半是抢占式实例库存不足，稍后重试 |

### 重置状态

面板没有暴露重置按钮，需要调用 API：

```bash
curl -X POST "https://<你的域名>/api/action" \
  -H "Cookie: cdt_session=<你的会话 cookie>" \
  -H "Content-Type: application/json" \
  -d '{"action":"reset_state"}'
```

> 重置只清 KV 里的运行状态（`state_v2`），**不动 KV 里的配置**（`app_config`）。账号和阈值会保留。

---

## 12. 日常运维

- [ ] **每月初**确认上月熔断已自动恢复（下个月第一天自动恢复调度）
- [ ] **定期看账单诊断**，确认没有闲置 EIP
- [ ] **换班后**确认域名解析已指向新 IP
- [ ] Telegram 通知保持开启

### 换班时会收到什么

| 标题 | 时机 |
|---|---|
| ✅ 【换班完成报告】 | 正常轮换 |
| ✅ 【临时换班完成报告】 | 临时换班 |
| ✅ 【当班恢复报告】 | 当班恢复 |
| 🔄 【实例保活启动】 | 当班实例意外停止，自动拉起 |
| 🔴 【超限停机报告】 | 额度耗尽，强制停机 |
| ⚠️ 【换班异常报告】 | 换班超时 |
| 📊 【每日流量日报】 | 每天定时（需开启） |

---

## 13. 最后检查清单

**部署**

- [ ] `compatibility_date` 是 **UTC** 日期，不是本地日期
- [ ] KV namespace id 已替换（不是 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`）
- [ ] `ADMIN_PASS` secret 已设置
- [ ] `npx wrangler deploy` 成功
- [ ] 打开页面**不是白屏**，能登录

**阿里云**

- [ ] 每个账号的 RAM 用户有全部六个权限
- [ ] `bss:DescribeAcccount` **是三个 c**（不要改）
- [ ] 每台 ECS 绑定**固定 EIP**（不是自动分配的公网 IP）
- [ ] **没有闲置的 EIP**（诊断里 `idle` 为 0）
- [ ] 每台 ECS 的 `StoppedMode` 是 `StopCharging`

**配置**

- [ ] 每个实例的**地域选对了**（决定走 20 GB 还是 200 GB 池）
- [ ] 每个实例的**站点类型选对了**（国际站 / 中国站）
- [ ] 流量阈值与地域匹配（中国内地 ≤20，非中国内地 ≤200）
- [ ] 账单接口诊断跑过，结果符合预期

**Cloudflare**

- [ ] A 记录存在，TTL 设小
- [ ] **没有开橙云代理**
- [ ] API Token 权限是 `Zone → DNS → Edit`

**安全**

- [ ] 用 `ADMIN_PASS` secret，而不是 KV 里的面板密码
- [ ] `preview_urls = false`
- [ ] 有条件的话挂自定义域名 + Cloudflare Access

---

## 附：常见问题

**Q：面板显示「查询失败」，但诊断能查到余额？**

余额查询和诊断走的是不同路径。先「设置 → 保存」一次，让配置写进 KV。

**Q：账户余额是 0，正常吗？**

**正常。** 按量付费（后付费）账号没有预存余额。该看的数字是「账单（账号级）」。

**Q：流量显示 0，但机器在跑？**

检查 `cdt:ListCdtInternetTraffic` 权限。查询失败会**直接进保护状态**，不会显示 0。

**Q：换班后域名没变？**

跨账号换班 IP **一定会变**。检查 CF Token / Zone ID / Record ID，看日志里的 `DNS_UPDATE_FAILED`。

**Q：能不能只用一个账号？**

可以。一个账号时不会换班，但仍有耗尽判定、保活和全部耗尽停机。

**Q：账单阈值该设多少？**

先跑诊断，看「本月 · 整账号」的金额构成。如果有闲置 EIP，先把 EIP 处理掉再定阈值 ——
否则 EIP 的固定开销会让阈值在月中就误触发，而换班解决不了 EIP 的问题。
