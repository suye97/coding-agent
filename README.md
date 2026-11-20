# 飞书需求开发 Agent

DeepSeek Harness Host bundle。飞书单聊接收需求和验收条件，方案经指定审批人确认后进入单任务开发队列。插件保留任务历史、审批版本、委派标识和待发送卡片。开发结果以独立 Git worktree 中的本地提交与实际检查结果为准。

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

向机器人发送以下文本即可创建任务。若先发送链接，可在需求确认卡片填写正文和验收条件，或者回复卡片补充。

```text
开发需求｜订单服务
需求正文：为订单列表增加状态筛选
验收条件：旧订单仍可读取，查询支持按状态筛选
```

使用 `开发需求｜项目名` 创建需求分支 `feature/<任务编号>_YYYYMMDD`，使用 `修复缺陷｜项目名` 或 `修复bug｜项目名` 创建修复分支 `fix/<任务编号>_YYYYMMDD`。日期按北京时间取值。插件在任务工作树中检查本地提交与已配置的检查命令，全部通过后将验证过的提交推送到项目远程的同名分支。远程推送失败会显示为阻塞，可修正凭据或远程配置后重试。

## 联调状态

当前 DSH Desktop 0.2.2-rc.5 的 profile 已安装官方 `@deepseek-ai/dsh-subagent-claude-code`，当前会话通过 `subagent_claude_code` 成功委派过任务。飞书插件直接调用同一注册服务的路径已通过本地适配器测试，实际 Host 激活后的飞书表单、委派和权限联调待验证。官方 provider 的权限模式按实例配置，权限提示由无人值守逻辑处理。当前飞书插件提供业务审批，DSH 原生单次工具授权、Claude Code 原生权限回传、草稿 PR 和 TAPD 回写仍待接入。首次发送使用 SQLite 保存的发送标识和卡片内容，依赖飞书消息 API 的一小时 `uuid` 去重窗口。超过窗口的重试可能出现重复卡片，卡片动作仍须通过数据库中的消息和版本校验。
