# Atoms Demo

一句话生成可运行的网页应用：描述需求，智能体团队接力完成规划、编码、代码评审与质检，右侧实时预览；之后可以继续对话修改、回看和恢复历史版本、发布成公开链接，别人还能一键 Remix。

> 在线体验：https://atoms.smallway.cn （无需注册，打开即可用）
> 设计说明与取舍：[docs/笔试说明.md](docs/笔试说明.md)　·　安全设计：[docs/安全设计.md](docs/安全设计.md)　·　[部署与运维](docs/部署.md)　·　[接口说明](docs/接口.md)　·　[介绍视频的制作](docs/介绍视频.md)

## 功能

| 模块 | 说明 |
| --- | --- |
| 智能体生成 | 产品经理（规划）→ 工程师（写代码）→ 代码评审（对照需求找缺陷，有问题回给工程师修一轮）→ 质检（结构与脚本语法检查），全程流式展示 |
| 后台任务 | 生成任务在服务端独立运行，关掉页面、后退、断网都不会中断；回来后自动接上并回放全部进度。服务重启打断的任务会自动退还额度 |
| 实时预览 | 代码边生成边追加进同一个页面，不重载不闪烁；桌面 / 手机宽度切换；可查看、下载源码 |
| 对话迭代 | 在现有应用上继续提修改意见，每次生成保存为一个新版本 |
| 版本历史 | 任意版本可回看，恢复时复制为新版本，历史不被改写；超出保留数量的旧版本自动清理 |
| 发布与 Remix | 发布为 `/s/<slug>` 公开链接；访问者可复制到自己的工作区继续改 |
| 运行时自修复 | 预览里的 JS 报错会被捕获，一键把错误交给智能体修复 |
| 竞速模式 | 同一个需求让 2–3 个模型同时构建，并排实时预览，都可以直接试用，挑一版保留、其余丢弃。每个模型各消耗一次额度 |
| 模型切换 | 输入框旁可以选模型；可选范围由服务端白名单决定。免费次数只能用于免费模型（线上是 DeepSeek V4.1 Flash），其他模型每次消耗 1 积分 |
| 账号 | 首次使用自动创建访客身份（无登录墙）；登录只支持 Google，登录后访客项目原样保留；本站不保存任何密码 |
| 额度与积分 | 每天有免费次数，用完后扣积分；模型服务故障导致的失败自动退还；积分通过订单购买，管理员确认收款后到账 |
| 应用数据 | 生成的应用产生的数据存在云端，按「应用 + 用户」隔离；打开别人分享的应用时，自己的数据同样存在云端 |
| 介绍视频 | 新访客第一次打开首页会看到一段 100 秒的 Atoms 介绍片，之后收到页面一角；影片完全由代码逐帧渲染生成 |
| 视觉 | 浅色底、粉彩色块、圆润的角色，与 atoms.dev 保持同一种气质；徽标和角色是自己画的，没有照搬官方素材 |

## 本地运行

```bash
npm install
cp .env.example .env.local   # 至少填 LLM_API_KEY；生产环境还要填 AUTH_SECRET
npm run dev
```

不填 `LLM_API_KEY` 也能运行：会进入「演示模式」，用内置模板走完整个流程，方便调试界面。

```bash
npm test            # 单元测试：扣费与退款、订单结算、任务恢复、数据库迁移、HTML 与脚本检查
npm run typecheck
npm run lint
```

这三项加上构建会在每次推送时由 [GitHub Actions](.github/workflows/ci.yml) 执行。

## 技术选型

- **Next.js 16（App Router）+ TypeScript + Tailwind v4**：前后端一个仓库，Route Handler 直接做流式接口。
- **libSQL（`@libsql/client`）**：本地是一个 SQLite 文件，也可以换成托管 libSQL，同一套代码，只改环境变量。启动时自动建表。
- **OpenAI 兼容接口（`openai` SDK）**：默认接腾讯云 TokenHub 的 `glm-5.3`，换模型或服务商只改环境变量。
- **会话**：`jose` 签名的 httpOnly Cookie，可在服务端撤销；登录只走 Google OAuth，不保存密码。

## 架构

```
浏览器                              服务端（Next.js Route Handlers，单进程）          外部
──────────────────────────────────────────────────────────────────────────────────────────────
Home ── POST /api/projects ───────▶ 创建项目（必要时创建访客）
Workspace
  ├─ POST   /generate ────────────▶ 鉴权 → 扣额度 → 启动后台任务（立即返回）
  ├─ GET    /generate?from=N ◀──── 从第 N 个事件起回放并持续推送（NDJSON）   任务 ─▶ 模型服务
  ├─ DELETE /generate ────────────▶ 取消任务                                   └─▶ 保存版本与消息
  ├─ 竞速：POST /generate {models:[…]} → 一份计划、多路并行编码 → POST /race 采用一版
  ├─ 版本：GET / POST /api/projects/:id/versions/:vid
  └─ 发布：POST /api/projects/:id/publish
PreviewFrame（sandbox iframe）◀─ postMessage ─ 注入的垫片（存储桥 + 错误上报）
  └─ 应用数据：GET / PUT /api/apps/:id/storage（按 应用 + 用户 存取）
Billing ─ POST /api/billing/orders（下单）→ 管理员 POST /api/admin/orders/:id/settle（确认收款，发放积分）
```

关键文件：

- [src/lib/agents.ts](src/lib/agents.ts)：智能体流水线与提示词
- [src/lib/jobs.ts](src/lib/jobs.ts)：后台任务、事件回放、取消与超时、重启后的额度退还
- [src/lib/store.ts](src/lib/store.ts)：数据访问、额度扣减与退还、订单结算
- [src/lib/config.ts](src/lib/config.ts)：全部配置项
- [src/lib/html.ts](src/lib/html.ts)：HTML 提取、结构检查、预览垫片
- [src/lib/syntax.ts](src/lib/syntax.ts)：脚本语法检查（只编译，不执行）
- [src/lib/db.ts](src/lib/db.ts)：建表与有记录的数据库迁移
- [src/components/Workspace.tsx](src/components/Workspace.tsx) / [PreviewFrame.tsx](src/components/PreviewFrame.tsx)：工作台与沙箱预览

### 智能体流水线

每次生成的上下文都是**重新构造**的：本次需求、产品计划、当前代码，外加最近几条需求摘要。聊天记录不会被整段回放，所以对话再长也不会撑爆模型上下文，只有应用自身的体积会增长；超过阈值时会明确提示用户拆分，而不是让模型服务报一个看不懂的错。

1. **Emma · 产品经理**：把需求整理成简短的构建计划（新应用同时起名）。
2. **Alex · 工程师**：输出完整的单文件 HTML。输出被截断时自动续写一次。
3. **Bob · 代码评审**：只找"不能用"或"没做到需求"的问题。发现问题时把清单回给工程师修一轮；修出来的结果不完整就保留原稿。评审之外，服务端还会用 V8 把每段内联脚本编译一遍（只编译、不执行）：语法错误是确定的事实，不管模型怎么判断都会进入修复清单。
4. **质检**：对最终文档做结构检查和脚本语法检查，结果写进对话。

**竞速模式**走另一条路径：产品经理只规划一次，然后每个模型各起一个工程师并行编码，事件带上"第几路"的编号，由同一条事件流推给页面。竞速不跑代码评审，因为这时由人来当评委。完成的候选先落库而不是直接成为版本，所以刷新页面、换设备回来都还能挑。

### 数据模型

| 表 | 内容 |
| --- | --- |
| `users` | 账号；访客也是一行，登录时原地升级 |
| `projects` | 项目与发布状态（`published_slug`、`published_version_id`） |
| `versions` | 每次生成的完整 HTML 快照；按项目保留最近 N 个，已发布的版本永远保留 |
| `messages` | 对话记录，可关联到它产生的版本 |
| `app_storage` | 生成的应用的数据，主键是 `(project_id, user_id)` |
| `usage` | 每个用户每天用掉的免费次数 |
| `credit_ledger` | 积分流水，只追加不修改；余额 = `SUM(delta)` |
| `orders` | 积分订单；支付确认时积分只会发放一次 |
| `race_candidates` | 竞速模式里等待挑选的候选版本；采用一版、全部放弃或开始下一次生成时清空 |
| `jobs` | 每个生成任务一行，记着它扣了哪些额度；重启后据此找出被打断的任务并退还 |
| `schema_migrations` | 已执行的数据库迁移 |

版本存完整快照而不是差异：单个应用只有几十 KB，快照让回看、恢复、发布都只是一次主键查询，没有重放链路。

## 配置

所有配置集中在 [src/lib/config.ts](src/lib/config.ts)，全部来自环境变量并有默认值。完整清单和说明见 [.env.example](.env.example)，常用的几项：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `LLM_API_KEY` / `LLM_BASE_URL` | 无 / TokenHub | 模型服务；不填密钥进入演示模式 |
| `LLM_MODEL` | `glm-5.3` | 写代码的默认模型 |
| `LLM_MODELS` | 仅默认模型 | 用户可选模型的白名单，`id=名称` 用逗号分隔 |
| `LLM_REASONING_EFFORT` | `low` | 推理强度；`low` 时几秒内开始出代码。DeepSeek 系列改为直接关闭推理（`LLM_NO_THINKING_MODELS`） |
| `REVIEW_MODE` | `fix` | `off` 关闭评审，`report` 只报告，`fix` 自动修复一轮 |
| `AUTH_SECRET` | 无 | 会话签名密钥，生产环境必填 |
| `LLM_FREE_MODEL` | 无 | 设置后，免费次数只能用于这些模型（逗号分隔），其他模型每次消耗 1 积分 |
| `RACE_MODE` / `RACE_MAX_LANES` | 开 / 3 | 竞速模式开关，以及最多几个模型同时竞速 |
| `DAILY_FREE_GUEST` / `DAILY_FREE_USER` | 3 / 10 | 每天免费生成次数（访客 / 登录用户） |
| `DAILY_FREE_PER_IP` | 15 | 同一个 IP 下所有访客每天共用的免费次数 |
| `SITE_DAILY_GENERATION_LIMIT` | 500 | 全站每日生成上限，兜住模型账单 |
| `BILLING_MODE` | `off` | `off` 关闭购买；`manual` 下单后由管理员确认到账；`mock` 自助到账，仅限本地演示 |
| `ADMIN_TOKEN` | 无 | 管理接口的令牌；不设则管理接口不存在 |
| `MAX_VERSIONS_PER_PROJECT` | 50 | 每个项目保留的版本数 |

## 安全

要点如下，完整的威胁分析见 [docs/安全设计.md](docs/安全设计.md)。

- **生成的代码只在浏览器里运行**：服务端从不执行模型写出的代码，智能体也没有任何工具（不能读文件、发请求、执行命令），所以提示词注入最多只能影响生成出来的网页。
- **预览沙箱**：预览和分享页都在不带 `allow-same-origin` 的 `sandbox` iframe 里，拿不到本站 Cookie、存储和 DOM。
- **访问控制**：每个项目接口都按会话里的用户校验归属，访问别人的资源一律返回 404；后台任务也只对发起它的用户可见。
- **密钥**：模型密钥和 OAuth 密钥只在服务端读取，构建产物里不含；`.env*` 被 git 忽略。
- **费用**：按用户限免费次数；访客还按 IP 共用一个每日额度池，清 Cookie 换身份也绕不过去；全站另有每日上限；模型只能从服务端白名单里选。
- **进程隔离**：线上以受限的 systemd 服务运行（不能提权、读不到 SSH 密钥、只能写数据库目录），只监听本机端口。

## 部署

需要一个能长期运行 Node 进程的环境：生成任务在进程内后台运行，所以只能单实例部署，不适合函数会在响应后被冻结的 Serverless 平台。

**一键安装**到一台全新的 Ubuntu / Debian 服务器（装 Node、systemd 服务、每日备份、nginx 和 https 证书，然后发布）：

```bash
DEPLOY_HOST=my-server DOMAIN=atoms.example.com EMAIL=me@example.com ./scripts/setup.sh
```

**之后每次发布**。新版本在独立目录里构建，成功后才切换；健康检查不过会自动切回上一版：

```bash
DEPLOY_HOST=my-server ./scripts/deploy.sh
```

**回滚**到上一次发布：

```bash
DEPLOY_HOST=my-server ./scripts/deploy.sh --rollback
```

**Docker**：

```bash
docker compose up -d --build
```

参数、手动安装、备份与恢复、日志、升级和排查见 [docs/部署.md](docs/部署.md)。

## 积分订单的确认

`BILLING_MODE=manual` 时，用户下单后订单处于"待确认"，不会自动到账。管理员收到款后用管理接口确认（需要 `ADMIN_TOKEN`）：

```bash
# 查看待确认的订单
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your-domain.com/api/admin/orders

# 确认某一笔已收款，积分立即到账（重复调用不会重复发放）
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://your-domain.com/api/admin/orders/<订单号>/settle
```

`BILLING_MODE=mock` 会让订单无需付款就自助到账，等于免费发积分，只应在本地演示时使用。

## 已知限制与后续

- **单进程假设**：后台任务的事件流和限流计数都在进程内存里，适合单机部署。要横向扩展，需要把它们放到共享存储（如 Redis）。服务重启会打断正在运行的任务：额度会在下次启动时自动退还，但用户需要重新发起。
- **只生成单文件 HTML 应用**：预览零构建、秒开、沙箱简单；代价是做不了多文件工程和自定义后端。下一步是引入浏览器内打包支持多文件项目。
- **迭代是整文件重写**：实现简单且稳定，但大文件修改更慢、更费 token。下一步是让工程师输出补丁。
- **评审主要靠模型读代码**。能确定的只有脚本语法（服务端编译检查）和预览里捕获到的运行时报错；逻辑是否正确没有真实运行的依据。下一步可以加无头浏览器执行和截图。
- **没有接真实支付渠道**：订单、幂等发放、流水都是完整的，但收款确认靠管理员手动完成（见下）。接入渠道时，只需让渠道的签名回调调用同一个 `settleOrder`。
- **应用数据是每人一份的私有数据**，应用之间、用户之间不共享，所以还做不了留言板这类多人共享数据的应用。
- **登录只支持 Google**，面向国际用户。打不开 Google 的网络下只能以访客身份使用：功能完整，但每日免费次数较少、不能购买积分、换设备后项目不跟随。
- **自动化测试只覆盖服务端逻辑**（扣费与退款、订单、任务恢复、迁移、HTML 检查）。界面和完整的生成流程仍靠浏览器手动验证。
- **一键安装脚本和 Docker 镜像还没有在真实环境里跑过**；发布脚本的构建、切换、回滚在本机验证过。
