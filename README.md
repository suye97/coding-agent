# 飞书需求开发 Agent

DeepSeek Harness Host bundle。飞书单聊接收需求正文，项目可识别且正文有效时自动进入设计和单任务开发队列。插件保留任务历史、委派标识和待发送卡片。开发结果以独立 Git worktree 中的本地提交与实际检查结果为准。

## 本地验证

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run
```

需要 Node.js 24 或更高版本以及 Git。测试使用临时 SQLite 数据库、替身飞书和 Harness 服务、真实 Git worktree。任务开发运行在配置的本地项目中。

## 准备联调

1. 在 DSH 的 **插件 → 添加插件** 选择本目录。安装后从左侧栏打开**飞书需求开发**。上方显示调度路径，下方点击任务可查看需求修订、方案审批、执行、验证和交付记录。飞书长连接默认关闭，完成下列配置后可开启。
2. 在飞书开放平台启用自建应用的机器人能力，在事件与回调中选择长连接，配置 `im.message.receive_v1` 和新版卡片回传 `card.action.trigger`，授予接收机器人单聊消息和发送、更新机器人消息所需的权限。已发布的应用需要对审批人可用。
3. 打开左侧栏 **飞书需求开发 → 渠道配置 → 飞书**，填写 App ID、App Secret、审批人的 Open ID 和数据目录。App Secret 保存到 DSH 凭据服务，留空可保留已经保存的凭据。可以先保存配置，在项目仓库准备好后再勾选「开启飞书长连接」。
4. 打开 **飞书需求开发 → 项目仓库**，选择本机已有的 Git 仓库文件夹，填写飞书项目名，选择本地基线分支和推送远程，然后保存。也可以粘贴仓库绝对路径再读取 Git 配置。已有项目会出现在列表中，可编辑名称、别名、基线分支和远程。
5. 启用 DSH 官方 **Claude Code 子智能体** bundle。该 bundle 将 Claude Code 注册到 `ctx.subagents`，默认注册名为 `claude-code`，飞书插件可以通过 `ctx.subagents.startActivation()` 直接调用已注册的实例。设计可另注册 `claude-code-design` 并使用 `permissionMode: plan`。开发可使用 `claude-code`，由其原生权限配置和运行环境约束 worktree 的写入范围。完成这两条路线的权限联调后，在飞书插件配置中开启 `providerPoliciesVerified`。该开关记录联调确认。

```yaml
enabled: true
appId: cli_your_app
secretKey: FEISHU_DEV_APP_SECRET
userId: ou_your_approver
dataDirectory: 'E:\DSH-Data\feishu-dev'
designProvider: claude-code-design
developmentProvider: claude-code
providerPoliciesVerified: false
desktopTemplateDirectory: 'E:\DSH-Test\desktop-template'
desktopExecutable: 'E:\DeepSeek Harness\DeepSeek Harness.exe'
desktopReadinessCommand: node
desktopReadinessArgs: ['E:\DSH-Test\check-desktop.mjs']
desktopStartupTimeoutMs: 60000
projects:
  - name: 订单服务
    aliases: [订单]
    path: 'E:\Projects\order-service'
    baseBranch: main
    remote: origin
    checks:
      - label: 检查自测脚本
        command: node
        args: [scripts/check.mjs]
        timeoutMs: 120000
```

`dataDirectory` 应位于项目仓库之外。验证命令由 Host 配置，按可执行文件和参数数组运行。Windows 上需要执行 npm 脚本时，可用 `node` 加 npm CLI 的绝对路径。验证界面会显示有限长度的命令输出，请选用输出适合发送给审批人的检查命令。

同一条飞书消息带上有效需求正文即可自动进入设计和开发队列。正文可以放在下一行，也可以写成 `开发需求|订单服务：为订单列表增加状态筛选` 或 `修复缺陷｜订单服务｜修复保存失败`。只发送项目名或来源链接时，可在待补充需求卡片填写正文，或者回复卡片补充。
旧消息中独立的「验收条件」段落会被忽略；历史记录无需迁移，读取调度详情和委派时只使用正文。

```text
开发需求｜订单服务
需求正文：为订单列表增加状态筛选
```

使用 `开发需求｜项目名` 创建需求分支 `feature/<任务编号>_YYYYMMDD`，使用 `修复缺陷｜项目名` 或 `修复bug｜项目名` 创建修复分支 `fix/<任务编号>_YYYYMMDD`。日期按北京时间取值。插件在任务工作树中检查本地提交与已配置的检查命令，全部通过后将验证过的提交推送到项目远程的同名分支。远程推送失败会显示为阻塞，可修正凭据或远程配置后重试。

## 飞书群任务

群内发送 `开发需求| 项目名` 或 `修复缺陷｜项目名`。带正文的命令直接入队，只有项目名时在群里发补充卡片。普通群聊消息会被忽略。机器人能否收到未 @ 的命令由飞书应用权限决定。接收群内真人 @ 机器人可用 `im:message.group_at_msg:readonly`，接收未 @ 的真人消息可用 `im:message.group_msg`，接收其他机器人的群卡片用 `im:message.group_msg.include_bot:read`。应用需订阅 `im.message.receive_v1`，并发布有对应权限的版本。

渠道配置的操作人 Open ID 可留空，此时任何收到的真人关键词命令均可创建任务。多个 Open ID 用英文逗号分隔。任务卡片的补充、审批和验收仍与发起人及原会话绑定。

让 TAPD 自动发出的卡片开工时，到「渠道配置 → TAPD 群卡片来源」保存来源。先由 TAPD 发一张新卡片，点击「读取最近收到的群卡片」，核对来源后点击「填入这张卡片的来源」。此操作只填表，保存后才启用该来源，随后新卡片可触发任务。若面板没有收到卡片，检查飞书当前发布版本是否有 `im:message.group_msg.include_bot:read` 和长连接事件 `im.message.receive_v1`。也可以在插件配置中直接填写 `tapdCardSource`。`chatId` 填群 ID，`senderId` 填飞书事件中的 TAPD 机器人发送方 ID，`operatorId` 填负责该来源任务的真人 Open ID。如果渠道配置了操作人名单，该 ID 须在名单内。卡片标题使用上述命令格式，正文用 `详细描述：` 字段。插件按飞书消息 ID 去重。如果同一工单发出多条独立消息，每条消息仍会单独处理。

## 截图和原型

先发送 `开发需求｜项目名` 获取任务卡片。直接回复该卡片发送 PNG、JPEG 或 WebP 图片，然后另发纯文本说明需求。每条任务最多 8 张，单张最多 8 MiB，总计最多 24 MiB。图片关联到对应任务，设计和开发通过原生图片读取工具查看它们。飞书应用需具备读取消息资源的权限。图片内容提供设计参考，文件删除等授权写在需求正文里。

## 操作验证与人工审核

验证按证据来源分层，不再为每个小更新重复启动 Agent。涉及界面、浏览器、Desktop 或明确用户操作的需求使用操作验证；纯代码结构、接口和命令行逻辑可以使用项目回归检查。缺陷修复仍需基线复现和修复后回归，但不强制 GUI 操作。

需要操作验证时，Host 在变更审核和固定项目检查通过后依次选择证据：优先采用维护者配置的 `kind: operation` 项目检查报告；没有报告时，复核开发 Agent 在同一待交付提交上已经采集的完整实测证据；证据缺失、过期或步骤不完整时，才委派独立验证 Agent 补验。开发阶段只复用已经配置好的测试或运行环境，不额外搭建 Desktop 登录环境；空提交以及没有增量差异的返工会在固定 Git 检查中直接拦截。推送失败后的重试复用同一提交的有效证据；缺陷返工可复用同一基线已有的复现记录，只验证新提交的修复结果。

Agent 证据从 Codex 命令执行或 Claude Code Bash 工具结果采集，把提交、验证委派 ID、逐步观察、工具记录 ID 和输出 SHA-256 保存在任务详情。摘要、编译结果、普通文件内容或模型自述无法单独通过操作验证。Git worktree 不包含 `node_modules`，Host 会在调用验证 Agent 前按锁文件安装隔离依赖（npm 项目使用 `npm ci --no-audit --no-fund`，允许锁文件声明的必要生命周期脚本），并记录锁文件和 `package.json` 的指纹；缓存命中前使用固定 `npm ls --depth=0` 检查依赖完整性，失败时重新安装，不会复用其他工作树的依赖。

独立 UI 验证按有效工具记录即时保存检查点，卡片和调度面板显示环境准备、基线、当前步骤、本步耗时和推送状态；调度面板也会持续轮询并展示验证委派的实际模型输出。失败或 Host 重启后，同一提交、需求、方案、完整步骤和基线可以从未完成步骤继续，已经通过的步骤与缺陷基线不重复采集证据；临时数据丢失时先幂等重建前置状态，任何身份不匹配都会丢弃旧检查点。开发阶段的不完整证据也按相同身份进入检查点，只补缺失步骤。阻塞后本步耗时冻结，不再随卡片刷新继续增长。最终交付仍会合并并完整校验所有步骤。独立委派有 10 分钟总时限、60 秒父会话/activation 启动时限、3 分钟无协议进展时限和 3 分钟单步时限，整个验证阶段（固定检查、实测和推送）有 15 分钟总预算，资源清理最多等待 10 秒；首步计时从 activation 就绪后开始，持续输出或排查日志不会重置单步时限。超时后保留检查点并进入可重试状态。Provider、模型和宿主环境不属于验证 Agent 的修复范围，环境未就绪应立即报告，不允许通过修改 Provider、模型、endpoint、权限或仓库配置延长验证。Agent 只执行交付计划中的必检步骤，全量回归交给项目固定检查；缺少环境或逐步记录时任务会补验或阻塞，不会直接交付。

### 可复用的隔离 Desktop 验证环境

明确要求 DSH Desktop 的任务不再让 Agent 创建 profile、安装 Provider 或处理登录。Host 从 `desktopTemplateDirectory/profile` 复制专用测试环境到 `<dataDirectory>/desktop-validation/tasks/<任务编号>/profile`，用 `desktopExecutable` 和 Electron 的 `--user-data-dir=<隔离目录>` 启动独立实例。每个任务使用自己的目录，不共享运行实例；同任务重试保留 profile，跨任务不复用目录。模板清单和全部模板文件的 SHA-256 变化时重建副本，健康检查失败也会停止实例并在下次重试重建。Agent 完成后 Host 停止自己启动的进程树，插件停止时也会清理活动实例。

模板根目录必须包含 `feishu-desktop-environment.json`：

```json
{
  "provider": "claude-code",
  "fixturesVersion": "2026-11-22.1",
  "fixtureRepository": "E:\\DSH-Test\\sample-tasks",
  "fixtureOrigin": "https://git.example.invalid/test/sample-tasks.git"
}
```

`provider` 必须等于 `developmentProvider`。`fixtureRepository` 是专用样例任务库的本地 Git 仓库，Host 在每次启动前固定执行 `git remote get-url origin` 和 `git rev-parse --verify HEAD`，实际 origin 必须等于 `fixtureOrigin`。`profile` 应预先配置测试 Provider、插件和样例数据；只能引用专用测试凭据，不能复制或改写用户正在使用的真实 Desktop profile，也不要把 API Key 写进清单、健康检查参数或日志。

`desktopReadinessCommand` 与 `desktopReadinessArgs` 是维护者控制的固定健康检查，不能留空。Host 会重复执行到成功或 `desktopStartupTimeoutMs` 超时；只有确认目标隔离实例已经启动、Provider 可调用、插件与样例任务库可用时才返回退出码 0。检查程序从 `FEISHU_DESKTOP_PROFILE`、`FEISHU_DESKTOP_PROVIDER`、`FEISHU_DESKTOP_FIXTURES_VERSION`、`FEISHU_DESKTOP_FIXTURE_REPOSITORY`、`FEISHU_VALIDATED_COMMIT` 和 `FEISHU_TASK_WORKTREE` 读取输入。它还应核实 DSH 实际使用了预期隔离目录；若当前 DSH 版本不接受该启动方式，必须失败而不是误操作用户实例。健康检查输出不会作为操作证据，也不会显示原始环境值。未配置模板或健康检查时，Desktop 任务会在委派前明确阻塞，不会退回 Agent 自行搭建环境。

仍可配置由维护者控制的 `kind: operation` 检查。验证程序放在任务工作树之外，使用绝对路径。程序从 `FEISHU_OPERATION_VALIDATION` 读取验证场景，`FEISHU_VALIDATED_COMMIT` 提供待验证提交。实际操作并断言结果后，程序在 stdout 输出 `FEISHU_OPERATION_EVIDENCE ` 加 JSON。字段包括 `operation`、`expected`、顺序一致的 `steps`（每步有 `action`、`observed`）、整体 `observed` 和 `passed: true`。缺陷任务还需要 `baseline: { reproduced: true, observed: "实际复现结果" }`。

与原需求冲突的替代方案通过飞书卡片交给操作人审核。文件删除可以在需求正文单独一行写 `删除文件：repo/relative.txt` 授权指定路径。提交中其他删除及匹配可疑脚本规则的变更会在 Host 运行项目检查和推送之前进入人工审核。脚本规则覆盖常见风险模式，告警需要结合变更内容判断。审核与待交付提交绑定。Agent 在独立工作树内使用开发 provider 已配置的权限。当前 Desktop provider 没有把单次文件删除转给飞书审批的接口，因此审批约束 Host 执行检查和推送。开发提示也要求在执行可疑脚本或删除范围不明确的文件前停下并报告。验证和审核通过后由 Host 自动推送。

## 联调状态

当前 DSH Desktop 0.2.2-rc.5 的 profile 已安装官方 `@deepseek-ai/dsh-subagent-claude-code`，当前会话通过 `subagent_claude_code` 成功委派过任务。飞书插件直接调用同一注册服务的路径已通过本地适配器测试，实际 Host 激活后的飞书表单、委派和权限联调待验证。官方 provider 的权限模式按实例配置，权限提示由无人值守逻辑处理。当前飞书插件提供业务审批，DSH 原生单次工具授权、Claude Code 原生权限回传、草稿 PR 和 TAPD 回写仍待接入。首次发送使用 SQLite 保存的发送标识和卡片内容，依赖飞书消息 API 的一小时 `uuid` 去重窗口。超过窗口的重试可能出现重复卡片，卡片动作仍须通过数据库中的消息和版本校验。
