[![](https://img.shields.io/badge/powered_by-dafeiyu-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/Dafeiyu111)

# 默认模型锁定

为 DeepSeek Harness 提供一把共享默认模型的锁：在设置页选好 provider、model 和推理档位，启用保存后，**共享默认值被钉死**。

起因：在 UI 里切一次模型，会把 `cordis.yml` 里的默认模型一起改掉（还会丢掉 `reasoningEffort` 行），于是心跳、看板定时任务、新会话全都跟着换模型。本插件把这件事变成显式开关。

## 安装

```powershell
# 先看会做什么（不写任何文件）
pwsh -File scripts/install-profile.ps1 -DryRun

# 装进目标 profile（自动备份 package.json 与 cordis.patch.yml）
pwsh -File scripts/install-profile.ps1 -Profile "$env:USERPROFILE\.dsh\profiles\desktop"
```

重载插件后，设置页出现「默认模型锁定」一节；改源码后必须重载/重启 DSH 才生效（刷新页面不够）。
卸载与还原步骤见 [docs/INSTALL.md](docs/INSTALL.md)。

## 行为

- **聊天里仍可自由切换模型**：`session.selectModel()` 只影响当前会话。
- **但切不动共享默认值**：`saveSelection()` 在进入原服务保存队列之前就被拦下，写入直接 fulfilled。
- `currentSelection()` 返回配置里的精确选择；新会话、headless、心跳、定时任务读到的是锁定值。
- 关闭锁定即恢复官方行为，并把 provider/model 从配置里 `unset`，官方默认值重新生效（插件从不改写官方默认模型配置）。
- 推理档位留空 = 交给模型适配器的默认档；填了就按填的。
- 无效 provider/model **fail closed**：不猜、不 fallback、不写任何东西。
- 只在加载了本插件的 profile 里生效。

## 拦截点

包装 `@deepseek-ai/dsh-agent-default-model` 服务实例上的 `currentSelection()` 与 `saveSelection()`：

- 用 Cordis 的 `symbols.original` 取回原始服务对象，在**实例**上包装 own methods —— 覆盖普通 `ctx` 属性、`ctx.get()`、`root`、headless 的同形读取，以及已缓存的服务对象。
- 不改 prototype、不改磁盘、不调模型接口。
- 卸载时恢复原 descriptor；服务重建时自动重新安装。

## 设置页

`settings.section` 槽位注册（经 `ctx.slots.inject`），页面读真实目录：`ctx.remote.session.modelCatalog()` → Typert `{ ok, value }` → `{ groups[{ id, name, models[{ id, name, reasoning: { efforts[{ id, name }], defaultEffort } }] }] }`。

- provider → model → effort 三级联动，只显示目录里真实存在的东西。
- 保存走一次原子 `mutate(ops, revision)`，`SettingsPathOpView` 操作，带 revision fence。
- 目录加载失败 → 显示错误、不给选项，此时只能关闭锁定。
- 已保存的模型若已不可用 → 标「不可用」，**不自动替换**。
- 关闭锁定时允许 provider/model 为空。

设置服务存在时，插件会调 `settings.configure({ auto: false })` 隐藏官方自动生成的通用表单，保证设置页只有这一个入口；设置服务本身按**可选注入**处理（缺席时不报错，锁定照常工作）。

已在独立 `DSH_HOME` + 端口 3199 的真实 Electron carrier 上跑通完整链路（真实 Loader 加载、Config 投影、`settings/update` 落盘、`currentSelection()` 拦截生效、官方配置零写入、解锁复原），结果见 [docs/INSTALL.md](docs/INSTALL.md) 第 6 节。

## 目录

```
index.js               插件入口 + Config schema（volatile 字段）
core.mjs               锁的实现（服务实例方法包装）
lib/client.js          客户端产物：手写 __ModuleLoader__ 模块（无构建步骤）
client/types.ts        真实 DSH 契约类型（参考，不参与安装）
client/index.tsx       初稿的迁移记录（已废弃）
test/core.test.mjs     后端 6 项：真 Cordis + 真 AgentDefaultModel
test/client.test.mjs   前端 9 项：直接加载 lib/client.js
scripts/install-profile.ps1    装进 profile（默认 dry-run，自动备份）
scripts/restore-backup.ps1     按备份回滚（只删 junction，不删源码）
scripts/isolation-probe.mjs    隔离验证探针（独立 DSH_HOME + 3199）
docs/INSTALL.md        安装、边界与隔离验证结果
```

## 自检

```bash
npm run check   # node --check：骨架与产物语法
npm test        # 15 项全绿
```

## 兼容性与边界

目标 DSH 0.2.1-rc.2 / Cordis 4.0.5；升级 DSH 后需重新验证包装契约。**已经提交进原保存队列的写入无法撤销** —— 锁定生效前那一刻排队的那次保存仍会落盘；此外，别的插件若在包装前缓存了方法引用，也可能绕开包装。插件不改核心源码，也不采用「监听配置变化再写回」的方案。

安装与实机验证见 [docs/INSTALL.md](docs/INSTALL.md)。
