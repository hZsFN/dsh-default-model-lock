# 安装与验证

目标环境：DSH 0.2.1-rc.2、Cordis 4.0.5。插件目录：`~/.deepseek harness/dsh-default-model-lock`。

## 1. 没有构建步骤

客户端产物 `lib/client.js` 是**手写**模块，启动时就带 `window.__ModuleLoader__.load({ id, inject, apply, factory })` 封装。页面用这个 envelope 收客户端插件，`factory(require)` 的 `require` 只能解析已声明的注入包，所以 esbuild 输出的 ESM 无法注册自己 —— 本插件不做打包。

`client/index.tsx`、`client/types.ts` 只作类型参考与迁移记录，不参与安装（`package.json` 的 `files` 也不含 `client/`）。

## 2. 装进 profile

插件通过 `link:` 依赖 + `cordis.patch.yml` 进入 profile：

```yaml
# cordis.patch.yml（随包发布）
- insert:
    - id: default-model-lock
      name: dsh-model-lock
      config:
        enabled: false
        provider: ''
        model: ''
        reasoningEffort: ''
```

在目标 profile 目录（例如 `~/.dsh/profiles/desktop`）里：

```bash
# 1) 把插件目录挂进 profile 的 node_modules（不要复制，改源码后重载即生效）
#    在 <profile>/package.json 里加依赖："dsh-model-lock": "link:<插件绝对路径>"
# 2) 确认 profile 的 cordis.patch.yml 已包含上面的 insert 段
```

重载插件后，设置页出现「默认模型锁定」一节。修改插件源码后必须重载/重启 DSH 才生效，刷新页面不够。

### 用脚本装 / 回滚

```powershell
# 先看会做什么（不写任何文件）
pwsh -File scripts/install-profile.ps1 -DryRun

# 真装：自动备份 package.json 与 cordis.patch.yml 到 .install-backup/<时间戳>/
pwsh -File scripts/install-profile.ps1 -Profile "$env:USERPROFILE\.dsh\profiles\desktop"

# 回滚：还原两个文件，并只删除 junction（不删插件源码目录）
pwsh -File scripts/restore-backup.ps1 -Profile "$env:USERPROFILE\.dsh\profiles\desktop" -BackupDir "<.install-backup 里的时间戳目录>"
```

脚本幂等：依赖已指向同一路径、patch 已含条目时跳过，不重复插入。

## 3. 自检（无需启动 DSH）

```bash
cd "~/.deepseek harness/dsh-default-model-lock"
npm run check     # node --check：index.js / core.mjs / lib/client.js
npm test          # 15 项：后端 6 项（真 Cordis + 真 AgentDefaultModel）+ 前端 9 项
```

前端测试用 `vm.runInThisContext` 加载真实的 `lib/client.js`，注入假的 `window.__ModuleLoader__`、`react`、`ctx`，因此测的是发布产物本身，不是它的副本。

## 4. 实机验证清单

1. 设置页 → 默认模型锁定 → 选出 provider / model（有 reasoning 的模型再选档位）→ 启用 → 保存。保存只发一次 `mutate`。
2. 聊天里切换模型：只改本会话；再看默认模型锁定的已保存值未被改写。
3. 新开会话：默认模型是锁定值。
4. 关闭锁定并保存：`enabled=false` 且 provider/model 被 `unset`，官方默认值恢复。
5. 把 provider 或 model 改成一个目录里不存在的值：页面显示「不可用」，不自动替换；启用状态下保存被拒。
6. 断开 Host 后打开设置页：显示目录加载错误，不出现任何伪造选项；此时仍可关闭锁定并保存。

## 5. 已知边界

- 插件在服务实例上包装 `currentSelection()` / `saveSelection()`，不改 prototype、不改磁盘、不调用模型接口。
- **已经排进原服务保存队列的写入无法撤销**：锁定生效前提交、尚未落盘的那一次保存仍会完成。
- 其他插件若在包装前缓存了方法的独立引用，可能绕过包装；通过 `ctx.agentDefaultModel`、`ctx.get('agentDefaultModel')`、`root.agentDefaultModel` 读取仍被覆盖。
- 只在加载了本插件的 profile/进程内生效。
- `settings` 采用可选注入：设置服务缺席时插件照常加载、锁定照常工作，只是不会隐藏官方自动生成的通用表单。因此设置页出现「两个入口」只会在 settings 不可用时发生。

## 6. 隔离运行验证（2026-10-20 实测）

用独立 `DSH_HOME` + 独立端口 3199 跑真实 Electron carrier，**不碰生产 profile**：

```powershell
node scripts/isolation-probe.mjs prepare    # 新建 .sandbox（已存在则拒绝覆盖）
node scripts/isolation-probe.mjs app-help   # 只打印 CLI 帮助
node scripts/isolation-probe.mjs start      # 前台起 127.0.0.1:3199（需手动 Ctrl+C）
```

实测结论（`settings/describe` 与 `session/modelCatalog` RPC，隔离实例内）：

| 项 | 结果 |
| --- | --- |
| 插件被真实 Loader 加载 | ✅ `settings.describe` 的 22 个 ns 里有 `default-model-lock` |
| Config 投影 | ✅ `enabled/provider/model/reasoningEffort` 四字段，默认全空/关闭，`applies: live` |
| 自动页去重 | ✅ `autoGenerate: false`（自定义设置页唯一入口） |
| 设置写入链路 | ✅ `settings/update` 落 `user` 段，revision 0→1，同时 `value` 立即生效 |
| `currentSelection()` 拦截 | ✅ 锁到 `probe-provider/probe-model` 后，`session/modelCatalog` 的 `default` 从 `deepseek-official/deepseek-flash` 变为 `probe-provider/probe-model` |
| 官方配置零写入 | ✅ `agent-default-model` ns 全程 `revision: 0`、值保持官方默认 |
| 解锁复原 | ✅ 关闭锁定后 `default` 回到 `deepseek-official/deepseek-flash` |

未覆盖：`saveSelection()` 被拦截后的具体落盘结果，因为隔离实例无凭据，`session/initializeDefaultModel` 在进入保存前就以 `provider "deepseek-account" has no available models` 退出；该行为的等价验证见 `test/core.test.mjs` 的 6 项真 Cordis 测试。
