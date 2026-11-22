# dsh-qqbot-guard · QQ 群管家

> 只做群管理：违规防护、入群审批、入群欢迎、公告发布与管理。  
> 不聊天、不发表情包、不处理图片/语音、不调用任何 AI 模型。

- 当前版本：**v1.0.1**
- 本仓库默认分支：**`main`**
- 适用宿主：**dsh ≥ 0.2.0-rc.2**
- 运行时要求：**Node.js ≥ 24.9.0**（dsh 0.2.x 的硬性要求）
- 许可证：MIT

---

## 项目来源与分支说明

本项目是**从原版 `dsh-qqbot` 衍生出来的重写版本（derivative rewrite）**，不是原版的官方仓库，也不是在原仓库上直接提交的分支。

| 项目 | 地址 / 说明 |
|---|---|
| 原版 | [https://github.com/zaofan-make/dsh-qqbot](https://github.com/zaofan-make/dsh-qqbot) |
| 本仓库 | [https://github.com/XIAOzsdn/dsh-qqbot-guard](https://github.com/XIAOzsdn/dsh-qqbot-guard) |
| 本版标签 | `v1.0.1` |
| 关系 | 保留原版核心群管理能力，移除 AI 对话/表情包/图片/语音等模块，并对架构、面板、依赖和资源占用做重写 |

### 与上游同步

本仓库不自动跟随上游更新。如需手动对比或同步原版：

```bash
git remote add upstream https://github.com/zaofan-make/dsh-qqbot.git
git fetch upstream
git diff main upstream/main --stat
```

> 原版版权归原作者 `zaofan-make` 所有。本仓库是基于其公开源码重写的衍生版本，请同时遵守原版仓库的许可证与使用条款。

---

## 1. 这是什么

`dsh-qqbot-guard` 是一个运行在 **dsh（Node.js 宿主）** 里的 QQ 群管理插件。它只订阅群事件，做四类事情：

1. **群聊违规防护**：本地词表/正则/链接/刷屏检测，命中后警告、禁言或移出。
2. **入群审批**：风险自动拒绝、关键词自动通过、面板手动审批。
3. **入群欢迎**：新成员入群自动发送欢迎语。
4. **公告与群成员管理**：公告草稿/定时/立即发布/历史，群注册表、成员台账、禁言/解除/移出。

所有能力通过一个六页 Web 面板操作：**总览 / 违规防护 / 公告 / 入群审批 / 群与成员 / 设置**。

---

## 2. 与原版相比有哪些改动

### 【1】 定位差异

| 维度 | 原版 `dsh-qqbot` | 本版 `dsh-qqbot-guard` |
|---|---|---|
| 定位 | 综合 QQ 机器人（AI 对话 + 多种媒体能力 + 群管理） | 纯群管理工具 |
| AI 模型 | 有，依赖 AI 会话/模型调用 | **完全没有**，零模型调用 |
| 聊天回复 | 有 | 无 |
| 表情包 / 图片 / 语音 | 有相关模块与依赖 | 全部移除 |
| 群管理 | 有，但与 AI 会话深度耦合 | 保留并重写为独立事件驱动 |
| Web 面板 | 大型内置设置页 | 重写为六页独立面板，按需拉取数据 |
| 源码规模 | 约 910 个文件 / 15.47 MB（不含 node_modules） | **30 个核心文件 / 约 187 KB**（不含 README、LICENSE、package-lock） |
| 发布包 | 体积大，模块多 | **约 81 KB 的 zip**（含 README、LICENSE） |
| 原生模块 | 依赖链较重 | **零原生模块**，无需编译工具链 |
| 安装依赖 | 较重 | 仅 `@tencent-connect/qqbot-nodejs` + `@deepseek-ai/schemastery` |

### 【2】 明确移除的能力

- AI 对话、模型配置、提示词、会话上下文、长期记忆
- 表情包、图片生成/识别、语音/音频处理
- 与聊天相关的限流、人格、工具调用、多模态处理
- 原版中与群管理无关的重型依赖与前端大包

### 【3】 保留并重写的群管理能力

- 违规词、正则、可疑链接、刷屏检测
- 警告 / 禁言 / 移出，以及失败时的降级链
- 多次违规自动升级
- 入群申请自动/手动审批
- 入群欢迎与多变体模板
- 公告草稿、定时、立即发布、暂停、删除、历史
- 群注册表、成员台账、禁言/解除/移出
- 违规与操作审计

### 【4】 资源与稳定性优化

- **单一 WebSocket 连接**，不轮询业务事件
- **单个 30 秒公告调度器**，不为每条公告创建定时器
- 状态文件**合并写盘**（默认 5 秒），避免每条消息都写磁盘
- 成员、待审批、违规记录、审计日志都有硬上限
- 令牌缓存 + 并发单飞，避免重复取票
- QQ API 调用统一经过**熔断器**，连续失败快速降级
- 面板只在可见时低频刷新状态
- 无 AI 请求、无模型上下文，内存与 CPU 占用显著降低

---

## 3. 功能说明

### 【1】 违规防护

在「违规防护」页配置：

- 启用/关闭防护
- 命中动作：警告 / 禁言 / 移出群聊
- 禁言时长、同一用户冷却时间
- 违规词（每行一个）
- 正则规则（每行一个）
- 可疑链接检测与域名白名单
- 刷屏检测：时间窗口 + 消息条数
- 多次违规升级：第 N 次违规后执行更重动作
- 豁免群 openid

执行失败时会降级：**禁言失败 → 警告**，**移出失败 → 禁言 → 警告**；不会因为某个接口失败而抛异常中断。

### 【2】 入群审批

在「入群审批」页：

- 查看本地待审批列表
- 从官方接口同步待审批列表
- 手动通过 / 拒绝
- 命中风险提示自动拒绝
- 关键词自动通过
- 关键词自动拒绝

> 入群申请事件需要 QQ 开放平台授权 `GROUP_MEMBER_EVENT`，并在插件设置中开启「订阅入群申请事件」。

### 【3】 入群欢迎

- 模板变量：`{user}`（@新成员）、`{name}`（昵称）、`{group}`（群名）
- 支持多条欢迎语变体
- 变体选择由 **种子随机** 驱动：同群、同成员、同一天固定，可复现
- 修改「随机种子盐」即可换一批欢迎语

### 【4】 公告

- 新建公告：标题（可选）+ 正文
- 保存为草稿 / 定时发布 / 创建后立即发布
- 暂停定时、删除、查看发布历史
- 发布结果按群记录成功/失败
- 定时调度器每 30 秒扫描到期公告

> **重要限制**：QQ 官方机器人接口不提供“设置群公告”能力。本插件的公告是以**机器人消息**形式发送到目标群，不能替换 QQ 客户端里的原生群公告。面板中也有相同提示。

### 【5】 群与成员

- 群注册表：收到群事件后自动登记，也可手动添加群 openid + 名称
- 成员台账：记录机器人见过的成员（入群申请、群消息）
- 成员搜索：昵称 / openid
- 禁言 / 解除禁言 / 移出群聊

> QQ 官方暂未开放“全量成员列表”接口，因此成员台账只能覆盖机器人见过的成员。

### 【6】 Web 面板

- 六个页签，全部在同源设置页内操作
- 写接口要求同源 + 自定义请求头，降低 CSRF 风险
- 「设置」页内置**兼容性自检**和**网络连通性检测**
- 状态轮询只在页面可见时进行

---

## 4. 兼容性

| 平台 | 结论 | 条件 / 说明 |
|---|---|---|
| Windows 10 / 11 x64 | 支持 | Node ≥ 24.9.0 + dsh |
| Windows Server 2016+ | 支持 | 同上 |
| Windows 10 LTSC / 精简版 | 有条件支持 | Node 与 dsh 能启动即可；不要移除 UCRT、Winsock、DNS、防火墙出站 443 |
| Windows arm64 | 有条件支持 | Node 24 对 Windows arm64 为 Tier 2 |
| Ubuntu 20.04+ / Debian 10+ / RHEL 8+ | 支持 | 内核 ≥ 4.18、glibc ≥ 2.28 |
| Alpine / musl | 有条件支持 | Node 官方列为 Experimental |
| macOS 13.5+ | 支持 | Node 24 要求 Darwin 22.6+ |
| Android / Termux | 实验性 | 可尝试，但不适合 24×7 运行，官方不支持 |

### 【1】 为什么有这些边界

1. **dsh 0.2.2 的 `engines` 要求 Node ≥ 24.9.0**，这是硬门槛。
2. Node 24 官方支持范围：
   - Windows 10 / Server 2016+（x64 为 Tier 1，arm64 为 Tier 2）
   - macOS 13.5+（Darwin 22.6+）
   - Linux 内核 ≥ 4.18、glibc ≥ 2.28
   - Alpine/musl 为 Experimental

### 【2】 Windows 精简版建议

1. 不要移除 **UCRT、Winsock、DNS Client、防火墙出站 443**。
2. 如果 dsh 报原生模块加载失败，安装 **Microsoft Visual C++ 2015–2022 Redistributable (x64)**。
3. 数据目录不要放在 `Program Files`，默认在 `~/.dsh/qqbot-guard/...` 即可。
4. 部署后先运行 `npm run doctor`，红色必检项未解决前不要上线。
5. 控制台中文乱码不影响功能；可执行 `chcp 65001` 切到 UTF-8。

### 【3】 兼容性自检

插件启动时会自动检查：

- Node 版本
- 操作系统 / CPU 架构
- Windows UCRT
- Linux glibc / 内核
- macOS Darwin
- 全局 `fetch` / `AbortSignal.timeout`
- 数据目录可写
- dsh Web 服务是否就绪

手动运行完整体检：

```bash
npm run doctor
```

体检还会检查：

- QQ SDK 与配置 Schema 依赖能否加载
- 依赖里是否存在原生模块
- `bots.qq.com` 与 `api.bot.qq.com` 是否可达

面板「设置 → 兼容性自检」也会展示同样的结果。

> 测试边界：本版在 Windows 11 x64 + Node 26.10 上完成 40 项单测与交付自检；代码中没有平台专用分支，但未在真实 Linux/macOS 内核上运行自动化测试。建议在目标机器上运行 `npm run doctor` 和 `npm test`。

---

## 5. 安装

### 前置条件

| 项目 | 要求 |
|---|---|
| dsh | ≥ 0.2.0-rc.2 |
| Node.js | ≥ 24.9.0 |
| 包管理器 | pnpm（dsh 插件安装需要） |
| QQ 机器人 | 在 QQ 开放平台创建，拿到 AppID / AppSecret |
| 群权限 | 机器人需为群管理员，并开通群管理/入群审批/禁言/移除成员等能力 |
| 消息权限 | 建议开通「群聊全量消息」，否则只能看到 @ 机器人的消息 |
| 事件权限 | 入群审批需要 `GROUP_MEMBER_EVENT` |

安装 pnpm（任选其一）：

```bash
npm install -g pnpm
# 或
corepack enable
corepack prepare pnpm@latest --activate
```

---

### AI 安装方式（推荐）

把下面这段提示词直接发给 DSH ，让它替你完成安装与验证：

请帮我安装 QQ 群管理插件 dsh-qqbot-guard。
链接：https://github.com/XIAOzsdn/dsh-qqbot-guard
要求：
1. 先检查 node -v 是否 >= 24.9.0，dsh --version 是否 >= 0.2.0-rc.2；
2. 如果 pnpm 不存在，执行 npm install -g pnpm；
3. 把仓库克隆到合适目录（如果机器没有 git，就下载 ZIP 并解压）：
   git clone https://github.com/XIAOzsdn/dsh-qqbot-guard.git
4. 进入目录执行 npm install；
5. 依次执行 npm run doctor、npm test、npm run validate，必须全部通过；
6. 执行 dsh plugin --profile web add "<插件绝对路径>"；
7. 重启 dsh web 服务；
8. 告诉我如何打开「设置 → QQ 群管家」，并提醒我填写 AppID / AppSecret；
9. 不要修改我的其他插件配置，不要删除现有数据。

如果任何一步失败，请先解释失败原因和修复方案，不要跳过校验。
```

AI 安装完成后，你需要手动完成两件事：

1. 在面板里填写 AppID / AppSecret 并保存。
2. 到 QQ 开放平台确认机器人已在目标群、已设为管理员、已开通所需权限。

---

### 手动安装方式

#### Windows（PowerShell）

```powershell
# 1. 检查环境
node -v
dsh --version

# 2. 安装 pnpm（如果还没有）
npm install -g pnpm

# 3. 获取源码
git clone https://github.com/XIAOzsdn/dsh-qqbot-guard.git
cd dsh-qqbot-guard

# 4. 安装依赖并自检
npm install
npm run doctor
npm test
npm run validate

# 5. 安装到 dsh 的 web profile
dsh plugin --profile web add "$PWD"

# 6. 重启 dsh web
# 关闭当前 dsh web 进程后重新启动，例如：
dsh web
```

#### Linux / macOS

```bash
# 1. 检查环境
node -v
dsh --version

# 2. 安装 pnpm（如果还没有）
npm install -g pnpm

# 3. 获取源码
git clone https://github.com/XIAOzsdn/dsh-qqbot-guard.git
cd dsh-qqbot-guard

# 4. 安装依赖并自检
npm install
npm run doctor
npm test
npm run validate

# 5. 安装到 dsh 的 web profile
dsh plugin --profile web add "$PWD"

# 6. 重启 dsh web
dsh web
```

#### 没有 git 的机器

1. 下载仓库 ZIP：`https://github.com/XIAOzsdn/dsh-qqbot-guard/archive/refs/heads/main.zip`
2. 解压到任意目录（不要放在 `Program Files`）。
3. 把上面的 `git clone` 步骤替换为 `cd 解压后的目录`，其余命令不变。

#### 安装后配置

1. 打开 dsh Web → 设置 → **QQ 群管家**。
2. 在「设置」页填写：
   - AppID
   - AppSecret
   - 是否启动时自动连接
   - 是否订阅入群申请事件
3. 点击「保存并重连」。
4. 回到「总览」确认状态为 **在线**。
5. 在「违规防护」里按需调整违规词和动作。
6. 在「入群审批」里配置自动审批与欢迎语。
7. 在「公告」里创建第一条公告或草稿。

#### 升级

```bash
cd dsh-qqbot-guard
git pull
npm install
npm test
dsh plugin --profile web add "$PWD"
# 重启 dsh web
```

数据目录独立于源码，升级不会清空设置和公告。

#### 卸载

```bash
dsh plugin --profile web remove dsh-qqbot-guard
```

> 不同 dsh 版本的插件管理命令可能略有差异；如果你的版本不支持 `remove`，请在 dsh 的插件管理入口中卸载。

如需彻底清理数据，再删除数据目录（默认 `~/.dsh/qqbot-guard/`）。

---

## QQ 开放平台权限

在 [QQ 开放平台](https://q.qq.com/) 创建/配置机器人时，至少确认：

- 机器人已发布到目标群，并被设为**群管理员**
- 开通群管理相关能力：入群审批、禁言、移除成员
- 开通「群聊全量消息」（否则只能收到 @ 机器人的消息）
- 开通 `GROUP_MEMBER_EVENT`（否则收不到入群申请）
- 如需 Markdown 警告/欢迎语，开通 Markdown 能力；未开通时插件会自动降级为纯文本

常见错误码会显示在面板审计记录中，例如：

- `11703`：没有接口权限 / 不是群管理员
- `40103004`：不能操作该成员（群主/管理员/机器人）
- `40103011`：机器人关闭了移除成员权限
- `304036`：Markdown 未授权（已自动降级纯文本）

---

## 7. 数据与安全

默认数据目录：

```text
~/.dsh/qqbot-guard/<profile>/<settingsNs>/
```

包含：

| 文件 | 内容 |
|---|---|
| `settings.json` | 凭据、违规规则、审批/欢迎/公告设置 |
| `state.json` | 群注册表、成员台账、待审批、违规计数、统计 |
| `announcements.json` | 公告与发布结果 |
| `audit.jsonl` | 审计日志（超过 2 MB 自动轮转一次） |

注意事项：

- AppSecret 以明文保存在数据目录中，请限制目录权限，不要提交到 Git。
- Web 写接口要求同源 + `x-qqbot-guard: 1` 请求头，降低 CSRF 风险。
- 所有对外接口返回统一信封：`{ ok, data, error, meta }`，`meta` 包含插件版本、生成时间、置信度。
- QQ API 连续失败会触发熔断，返回安全失败结果，不会把异常抛给宿主。
- 数据目录不可写时，插件会降级为内存模式；重启后设置和统计会丢失。

---

## 目录结构

```text
dsh-qqbot-guard/
├── index.js                 # Host 插件入口（apply / Config / 生命周期）
├── client.js                # 浏览器面板（手写模块，无需构建）
├── cordis.patch.yml         # dsh bundle 声明
├── icon.svg
├── locale/
│   ├── zh.json
│   └── en.json
├── lib/
│   ├── meta.js              # 插件身份与版本
│   ├── defaults.js          # 默认配置、阈值、上限
│   ├── config.js            # Cordis Config + 设置归一化
│   ├── store.js             # 设置/状态/公告/审计持久化
│   ├── rng.js               # 种子随机
│   ├── breaker.js           # 熔断器
│   ├── qq-api.js            # QQ 官方 REST 客户端
│   ├── bot.js               # WebSocket 连接与事件分发
│   ├── moderation.js        # 违规规则与降级执行链
│   ├── join.js              # 入群审批与欢迎
│   ├── announcements.js     # 公告 CRUD 与调度
│   ├── http.js              # 面板 API 路由
│   ├── envelope.js          # 统一响应信封
│   └── compat.js            # 跨平台兼容性自检
├── scripts/
│   ├── validate.mjs         # AST/Schema/清单自检
│   └── doctor.mjs           # 兼容性与网络体检
└── test/                    # 40 项单元测试
```

---

## 开发与校验

```bash
npm install
npm test           # 单元测试
npm run validate   # AST 语法 + Schema + 清单 + 兼容性自检
npm run doctor     # 当前机器的兼容性与网络体检
```

交付前要求：

- `node --check` 全部通过
- 配置 Schema、响应信封 Schema 通过
- 违规规则、审批、欢迎、公告、HTTP 接口单测通过
- `npm run doctor` 无必检失败项

---

## FAQ

**Q：机器人看不到群里的普通聊天？**  
A：需要在 QQ 开放平台开通「群聊全量消息」。否则机器人只能收到 @ 它的消息。

**Q：公告为什么不是 QQ 原生群公告？**  
A：QQ 官方机器人接口没有设置群公告的能力。本插件发送的是机器人消息，支持定时与历史管理。

**Q：收不到入群申请？**  
A：检查是否开通 `GROUP_MEMBER_EVENT`，以及插件设置里是否开启「订阅入群申请事件」。

**Q：禁言/移出失败？**  
A：机器人必须是群管理员，且不能操作群主/管理员/其他机器人。面板审计会显示官方错误码。

**Q：Windows 7 / 8.1 能用吗？**  
A：不能。dsh 要求 Node 24，而 Node 24 官方不支持 Windows 7/8.1。请升级系统或部署到 Linux 服务器。

**Q：iPhone 能安装吗？**  
A：不能作为宿主。把机器人部署在 Windows/Linux/macOS 或服务器上，然后用 iPhone Safari 打开 dsh 面板。

**Q：Windows 精简版缺依赖怎么办？**  
A：先运行 `npm run doctor`。常见修复是补装 UCRT/VC++ 2015–2022 运行库，并确保 Winsock、DNS、防火墙出站 443 正常。

**Q：会不会调用 AI 模型、消耗 token？**  
A：不会。本插件没有任何模型调用、会话或提示词逻辑。

---

## 11. 变更记录

### v1.0.1

- 新增跨平台兼容性自检模块
- 面板新增「兼容性自检」与「网络连通性检测」
- 新增 `npm run doctor`
- `package.json` 增加 `engines.node >= 24.9.0` 与 `os: win32 / linux / darwin`
- 违规警告优先使用被动回复，减少主动消息额度消耗
- Markdown 未授权时自动降级纯文本

### v1.0.0

- 从原版 `dsh-qqbot` 重写为纯群管理插件
- 移除全部 AI 对话、表情包、图片、语音相关模块
- 保留并重写违规防护、入群审批、入群欢迎、公告、群与成员管理
- 新增六页 Web 面板
- 体积从约 15.47 MB 源码降至约 187 KB，发布 zip 约 81 KB

---

## 12. 许可证与上游

- 上游原版：[zaofan-make/dsh-qqbot](https://github.com/zaofan-make/dsh-qqbot)
- 原版版权归原作者所有；本仓库是衍生重写版本，请同时遵守原版仓库的许可证与使用条款。
