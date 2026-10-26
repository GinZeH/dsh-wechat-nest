# 微巢 · DSH WeChat Nest

为 DSH 接入多个微信机器人，让每位用户拥有独立会话与工作空间。

版本 **v0.1.0** · 包名 **`dsh-wechat-nest`** · [GitHub](https://github.com/GinZeH/dsh-wechat-nest) · MIT

基于 [pan17/dsh-wechat](https://github.com/pan17/dsh-wechat) 开发，保留原项目许可证与署名。

把微信变成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 的第二客户端：在微信里和你的 agent 聊天，收发文字、图片、文件和语音，用 slash 命令管理会话、工作区、模型与权限，审批卡和提问卡在微信与桌面端同步弹出。

## 功能

微信与 DSH 双向同步：文字、图片、文件、语音直接发给 agent，回复与执行过程推回微信，审批卡和提问卡两端同弹、谁先答谁生效；`/at` 可引用其它会话或文件，把几条消息或「截图 + 问题」合成一轮，静默模式与结论模式控制推送频率；会话、工作区、Preset、模型、权限都能在微信里用 slash 命令管理，与 GUI 同源；另有秘密脱敏、文件范围限制、入站白名单与审计日志等边界，以及内嵌在 DSH 设置里的扫码登录、配置页与**指令帮助**（每条指令一句说明，点开看全部例子、点一下复制）。

**多用户**：同一个 bot 可被多个微信用户同时使用。每个人都有自己的会话、上下文、偏好、媒体目录和出站队列，不会互相占用微信的 10 条发送额度。会话列表、引用与推送按归属过滤；微信端的工作区切换和文件引用限制在管理员分配的目录内。入站白名单留空时，对所有能给 bot 发消息的人开放；从旧版升级时，已存在的用户会自动写入白名单。

目录边界不替代 DSH 的工具权限和操作系统沙箱。面向互不信任的用户部署时，还需要配置宿主文件与命令执行权限；管理员主动分配共享目录或开启「任意路径发送」会放宽文件边界。

## 安装

要求 DSH `>=0.2.1-0 <0.3.0-0`。

在 [Releases](https://github.com/GinZeH/dsh-wechat-nest/releases) 下载 `dsh-wechat-nest-0.1.0.tgz`，通过 DSH 设置 → 插件 → 添加插件选择本地安装包，或运行：

```bash
dsh plugin --profile desktop add ./dsh-wechat-nest-0.1.0.tgz
```

这个 `.tgz` 已包含编译后的服务端、设置页和 `dsh.bundle` 清单，就是官方 DSH Desktop 可安装的 bundle；不要选择 GitHub 自动生成的 Source code 压缩包。自行打包可运行 `npm run pack:release`，产物在 `release-assets/`，附带 `SHA256SUMS` 校验值。

npm 首次发布尚待完成账号授权；发布后可直接在插件页填写 `dsh-wechat-nest` 安装。原版 `dsh-wechat` 与微巢使用不同标识，但同一微信账号不能同时交给两个插件轮询；迁移时应先停用原插件。

安装后打开 **设置 → 微巢**。首次安装会自动创建一个 `main` bot，用要当机器人的微信扫码登录。

独立扫码页为 `http://127.0.0.1:3080/wechat-nest/qr`。旧数据迁移见 [迁移说明](docs/MIGRATION.md)。

## 多个 bot 同时在线

- **添加**：设置 → 微巢 顶部有 bot 标签和「+ 添加 bot」。每加一个都用对应微信扫码；多个 bot 会同时收消息，各自独立。
- **隔离**：每个 bot 有自己的 token、长轮询、用户、会话、工作区、偏好、媒体目录和发送队列；bot A 的用户和 bot B 的用户完全不共享状态。
- **自动工作区**：默认根目录是 `~/.dsh-wechat-nest/workspaces`（可在「连接与默认行为」改）。每个新 bot 得到 `<根目录>/<bot>-<hash>/`；开启「每个新微信用户自动分配独立工作目录」后，每个新用户再得到 `<根目录>/<bot>-<hash>/<user>-<hash>/` 并用它建会话。已有用户可在「微信用户」点「独立工作区」补上。
- **重扫 / 退出**：同一 bot 重扫或退出再登录会保留它的用户与队列；换一个微信号扫码（或添加新 bot）不会顶掉已有的 bot。
- **添加使用者**：不需要让对方扫码。用某个 bot 的微信扫码登录后，其他人直接给这个 bot 发消息，就会出现在该 bot 的「微信用户」里。

## 多用户

- **接入**：`allowedUsers` 为空即对所有能给该 bot 发消息的人开放（每人独立）；非空则只有名单内的 id 会被处理。升级时，`state.json` 里已有的用户会自动写入白名单，避免升级后被陌生人接管；要放行新用户，在 **设置 → 微巢 → 入站白名单** 添加，或清空名单重新开放。
- **管理**：**设置 → 微巢 → 微信用户** 会列出当前 bot 的已绑定账号，可逐个查看会话/工作区/队列，暂停或启用，调整该账号的静默、结论、推送、合并、提示词，加入或移出白名单，或移除桥接状态。暂停只忽略该账号的消息并停止推送，状态保留；移除只清桥接状态和队列，不删除 DSH 会话。
- **独立工作区与上下文**：每个账号有自己的 `cwd` 和会话绑定。「微信用户 → 改工作区」只改该账号，下一条消息会在新目录新建会话；「新会话」解绑当前上下文，旧会话仍保留在 DSH 侧栏。不同账号不会共用同一个会话或上下文。
- **隔离**：会话、上下文、偏好开关、模型默认、媒体下载目录、出站队列与 10 条发送窗口全部按微信用户分开；`/s list` 只列自己的会话，审批 / 提问卡只发给该会话的所有者。
- **目录边界**：管理员可在「微信用户 → 改工作区」分配目录；微信端只能查看和切换该目录内的工作区，不能自行扩大范围。旧用户以升级前的当前目录作为边界。桌面端未归属的会话不会因 bot 只有一名用户就自动开放。
- **共享**：DSH 的模型、Preset、权限预设本身是全局资源；每个用户首次出现时会快照自己的默认值，之后 `/model`、`/preset`、`/perm default` 只改自己的那一份，不影响别人。

## 微信命令

| 命令 | 说明 |
|---|---|
| `/help`（`/h`、`/?`） | 命令一览，含当前 profile 已注册的 DSH 原生命令 |
| `/help <命令>` | 该命令的全部例子，如 `/help s`、`/help merge` |
| `/status` | 工作区、会话、模型、上下文、权限、各开关状态 |
| `/workspace`（`/ws`） | `list` / `status` / `switch <编号\|路径>` / `add <路径>` |
| `/session`（`/s`） | `list [current]` / `switch [current]` / `pin` / `unpin` / `new` / `status` |
| `/preset`（`/p`） | `list` / `switch <名称\|编号>` / `status` — 默认 Preset，与 GUI 同步 |
| `/model` | `list` / `switch <提供商/模型>` / `status` |
| `/perm` | `status` / `list` / `switch <名称\|编号>` / `default [名称\|编号]` |
| `/reasoning` | 查看或切换推理等级 |
| `/enter`（`/busy`） | 繁忙时 `queue` 排队还是 `steer` 插话 |
| `/silent`（`/sl`） | 静默模式：每轮只发最终回复 |
| `/final on\|off\|status`（`/fo`） | 结论模式：整条任务只发一条结论 |
| `/merge`（`/mg`） | 打字合并开关与状态 |
| `/media`（`/md`） | 图片/文件合并开关；`at\|path` 切换附件交付措辞 |
| `/at` | 引用其它会话（`s`）或文件/目录（`f`），附加到下一条消息 |
| `/notify`（`/watch`） | 跨会话决策推送；`tasks on\|off` 单独控制任务提醒 |
| `/history` | 查看最近历史，`all` 含系统消息 |
| `/flush`（`/f`） | 立即取回结论模式暂存的结论 |
| `/surface`（`/wxprompt`） | 微信渠道提示词注入开关 |
| `/stop` | 中断当前任务 |
| `/next` | 继续发送被微信限流缓存的消息 |
| `/rq` | 关闭当前会话的待处理卡 |

其它 `/xxx` 作为文本转发给 agent。DSH 原生 slash 命令（`/plan`、`/goal`、`/compact` 等）由 bridge 直接交给原生 handler，微信端无需改动即可识别。

## 开发

```bash
npm ci
npm run build    # tsc → dist/
npm test         # vitest
```

改动代码后需**重启 DSH** 才会生效。架构、配置参考、命令接入细节、已知边界与宿主版本兼容见 **[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)**。

## 许可

MIT。`src/weixin/`、`src/adapter/` 移植自 [wechat-opencode](https://github.com/pan17/wechat-opencode)（MIT，原始来源 `@tencent-weixin/openclaw-weixin`），文件头保留出处注释。

## 免责声明

本项目与 DeepSeek Harness、腾讯微信官方**互不隶属**，非官方项目，纯属个人学习用途。使用本项目即表示你自行承担由此产生的一切后果。
