# 微巢 · DSH WeChat Nest Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-10-26

微巢从 v0.1.0 开始独立计版，基于 dsh-wechat 的多 bot / 多用户修改版。原项目与前期版本记录保留在 [历史变更](docs/UPSTREAM_CHANGELOG.md)。

### Fixed

- 无论每个 bot 有几名用户，会话列表、切换、空白会话复用和审批/提问/工具推送都按 owner 限制；缓存的会话列表也重新检查归属。
- `/at s` 的宿主关键词候选和最终引用检查会话归属，不能引用其他用户或其他 bot 的会话。
- 为用户持久保存管理员分配的目录边界。微信端的工作区列表、切换、新增、文件引用和候选提示限制在边界内；附件发送不再放行全部宿主工作区。缓存文件在发送时再次检查边界，拒绝目录穿越和符号链接越界。
- bot 管理器保存命令服务，在启动前注入以及运行中新增 bot 时都正确继承原生命令。
- bot 注册表忽略路径穿越标识和重复标识，避免异常本地配置让多个 bot 指向同一存储目录。

### Changed

- 旧用户的当前工作目录作为初始目录边界，管理员可在设置页重新分配。原来对未归属桌面会话与目录的隐式访问不再保留。
- 统一中文名「微巢」、英文名 DSH WeChat Nest、仓库及包名 `dsh-wechat-nest`，仓库地址为 `GinZeH/dsh-wechat-nest`。
- 插件入口、客户端模块与设置页标识统一为 `dsh-wechat-nest`，设置页显示「微巢」。HTTP 路由使用 `/wechat-nest/*`，工具使用 `wechat_nest_send`，默认存储使用 `~/.dsh-wechat-nest`。
- 浏览器缓存与样式标识、日志前缀、动态提示词、发布脚本及 npm 发布凭据名称独立于原插件；不自动读取或迁移原插件凭据。
- 保留原 MIT 许可证、来源说明与历史；新增旧版本迁移文档。
- 发布前排除上游聊天截图、机器路径日志及过期的 pnpm 锁文件；增加凭据与运行数据忽略规则。npm 发布改为独立启用，默认只发布 GitHub。

上游与前期修改版的历史记录见 [docs/UPSTREAM_CHANGELOG.md](docs/UPSTREAM_CHANGELOG.md)。
