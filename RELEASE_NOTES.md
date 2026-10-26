# 微巢 · DSH WeChat Nest v0.1.0

项目：[GinZeH/dsh-wechat-nest](https://github.com/GinZeH/dsh-wechat-nest)。基于 [pan17/dsh-wechat](https://github.com/pan17/dsh-wechat) 的多 bot / 多用户修改版，从 0.1.0 独立计版。

## 本次修复

1. 会话归属始终生效：单用户 bot 也不能列出、切换、复用或接收其他 bot/桌面端的未归属会话。
2. `/at s` 的关键词候选与最终引用均校验归属，缓存会话列表重新检查权限。
3. 为每个用户保存管理员分配的目录边界。工作区切换、新增、列表、文件引用和提示均受边界限制；`wechat_nest_send` 不再信任全部注册工作区，缓存文件实际发送前也重新检查。真实路径检查覆盖 `..` 和符号链接/Windows junction 越界。
4. 管理器缓存命令服务，在启动前注入或运行中新增 bot 时均可正确继承原生命令。

## 升级行为

- 已有用户的当前 cwd 成为初始目录边界，保留其现有会话归属记录。
- 如需访问其他目录，由管理员在 DSH 设置 → 微巢 → 微信用户 → 改工作区中重新分配。
- 微信端可在分配范围内切换子目录；不能自行扩大范围。
- 未归属的桌面会话不会再因 bot 只有一个用户而自动开放。
- 管理员将两人分配到同一目录即主动共享文件；`allowAnyFilePath=true` 会显式放宽附件路径限制。
- Agent 的 shell/read 等工具权限仍由宿主管理；插件目录检查不能替代进程或操作系统沙箱。

## 验证与发布状态

- 构建命令：`npm run build`。
- 测试命令：`npm test`，新增 `tests/isolation-boundaries.test.ts` 的 13 条回归用例。
- 尚未进行真实 DSH + 微信双 bot 扫码联调。
- 首版版本号为 `0.1.0`。GitHub Release 附带可供官方 DSH Desktop 安装的预编译 `.tgz` bundle 和 SHA-256 校验值；npm 使用同一份安装包，首次发布需要所有者完成 npm 授权。
- 仓库、npm 包、插件入口和设置页标识：`dsh-wechat-nest`；设置页名称：微巢。
- 路由：`/wechat-nest/*`；工具：`wechat_nest_send`；默认存储：`~/.dsh-wechat-nest`。
- 同一微信账号应只由一个插件实例轮询；旧版迁移见 [迁移说明](docs/MIGRATION.md)。
- 保留原项目 MIT LICENSE、来源注释与历史变更记录。

## 发布配置

GitHub Actions 优先使用 npm Trusted Publishing，也支持仓库 secret `DSH_WECHAT_NEST_NPM_TOKEN`。配置与首次发布见 [发布说明](docs/PUBLISHING.md)。没有沿用原作者的发布身份。
