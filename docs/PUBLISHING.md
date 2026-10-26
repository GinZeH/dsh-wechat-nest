# 发布微巢

官方 DSH 的 bundle 是带 `dsh.bundle.patch` 声明和补丁文件的 npm 包，不是单独的扩展名。本项目的 `.tgz` 包含预编译的服务端和客户端，无需在用户机器上编译。格式依据：[官方插件打包说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。

## 安装包

```sh
npm ci
npm test
npm run pack:release
```

`release-assets/` 生成 `dsh-wechat-nest-<版本>.tgz` 和 `SHA256SUMS`。脚本检查发布范围、bundle 清单和补丁，并解压到临时目录加载服务端和客户端入口，验证安装包不依赖源码或开发依赖。它不执行真实微信扫码联调。

用户在官方 DSH Desktop 的插件页安装该 `.tgz`，或运行 `dsh plugin --profile desktop add ./dsh-wechat-nest-0.1.0.tgz`。不要安装 GitHub 自动生成的 Source code 压缩包。

## GitHub Release 与 npm

`release.yml` 支持版本 tag `v<版本>`、发布分支 `release/v<版本>` 或手动运行。发布分支用于只能创建分支的 GitHub API 客户端；分支和 tag 都必须与 `package.json` 一致。

流程执行测试、构建、安装包验证，然后创建指向该提交的 GitHub Release，附上 `.tgz` 和校验值；最后向 npm 发布同一个文件。不会为 npm 重新构建。已存在的 tag 若指向别的提交则拒绝发布；npm 已存在版本只有在 SHA-512 完全一致时才视为成功，绝不覆盖或移动版本。

首次发布需要 npm 账号授权。可先 `npm login --registry=https://registry.npmjs.org`，下载 GitHub Release 中的 `.tgz` 到 `release-assets/`，运行 `npm run publish:release`。保留下载的原文件，避免跨平台重新打包造成字节差异；npm 的发布者资料可能公开，应自行选择适合公开发布的账号资料。密码、验证码和 token 不应写入仓库。

首次包创建后，推荐在 npm 包设置中配置 Trusted Publisher：

- GitHub 用户：`GinZeH`
- 仓库：`dsh-wechat-nest`
- Workflow filename：`release.yml`
- Environment：留空
- 授予直接 `npm publish` 权限

工作流已配置 `id-token: write` 和支持 OIDC 的 npm CLI。也可在仓库 Actions secrets 配置有该包发布权限的 `DSH_WECHAT_NEST_NPM_TOKEN`；不要将 token 放进源码。无需再设置 `NPM_PUBLISH_ENABLED`。

如果 npm 任务因未授权失败，GitHub Release 的 bundle 仍可安装；配置授权或手动发布同一文件后，重跑失败的 npm 任务即可。后续版本按 `npm run release -- <版本> --push` 发布，版本号不可复用。

参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。
