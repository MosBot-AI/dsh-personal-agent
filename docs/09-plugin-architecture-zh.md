# 09. 可替换能力与插件开发规范

[文档索引](README-zh.md) · [English](09-plugin-architecture.md)

架构将图片/视频创作和记忆定义为可独立替换的 **DSH/Cordis 插件**，拥有文档化、带版本的服务接口、配置和契约测试。PA-038 实现公开 API、注册表、策略消费者、测试工具包及免密钥本地示例。持久默认提供方与设置工作流由第 6 节中的任务负责。

## 1. 用户能够更改什么

| 能力 | 默认插件 | 可替换部分 | 保留在核心的职责 |
| --- | --- | --- | --- |
| 图片/视频生成 | `media-comfyui` | ComfyUI 实例、模型/工作流，或用户编写的本地/托管生成后端 | 作业记录、权限、预算、取消核对和成果登记 |
| 创作流程 | `creation-workflows` | 分镜、模板、图像变体、视频合成步骤与工具适配 | 任务验收、产物版本、发布授权 |
| 个人记忆 | `memory-sqlite` | 持久化、检索策略、索引；可使用文件或其他数据库后端 | 所有者/范围、事实更正、遗忘排除记录、数据外传策略 |
| 语音 | 后续 STT/TTS 插件 | 转写与语音合成提供商 | 对话身份、任务状态、审批与用量 |
| 凭据 | keychain/Bitwarden provider | 秘密保存及使用后端 | 安全输入协议、用途授权、审计脱敏 |
| 电脑/浏览器/VNC | 原生 DSH provider + dshpa 适配 | 驱动、桌面或虚拟环境 | 控制权、用户接管和设备授权 |

上述是拟议包目录名，不是已发布 npm 包。使用者可以在设置页选择已安装插件并调整配置；开发者可以安装本地目录或包形式的自定义插件，而无需 fork dshpa 主代码。无需构建在线插件市场才能做到这点。

## 2. 分发与依赖方向

```text
packages/
  personal-agent/       # DSH bundle、可信控制服务、UI、服务消费者
  plugin-api/           # 服务定义、版本、公开类型、注册与生命周期契约
  plugin-testkit/       # keyless 契约测试和开发夹具
  memory-sqlite/        # 默认记忆存储/关键词检索 provider
  media-comfyui/        # 默认生成 provider
  creation-workflows/  # 默认图片与视频创作流程
examples/plugins/      # 明确标注的记忆示例和媒体模拟 provider
```

依赖方向是核心消费者 → `plugin-api` ← provider；provider 不能导入核心私有目录，也不能直接修改核心任务/授权数据库。bundle 默认组合这些插件，但用户可以按支持的配置覆盖 provider。保持 Service Definition / Provider / Consumer 三种角色完整；不把每个辅助类都拆成 npm 包。

预稳定的 `@mosbot-ai/dshpa-plugin-api` 包版本为 `0.1.0`，使用确切的能力 API 版本 `1`。`ProviderDefinition` 将清单、配置 Schema、校验和启动结合起来。`dshpaPlugins.register(definition, instance, config)` 返回 `ready` 与 `dispose`。宿主在启动前校验版本和配置，再接受对已就绪实例的明确选择。卸载先关闭准入，等待实际调用及迟到的启动结果，再排空并执行一次停止。健康与声明元数据和私有配置分开。

### 加载免密钥示例

在工作区根目录使用已安装 dshpa 的现有命名 DSH Profile。

```sh
pnpm build
pnpm exec dsh plugin --profile your-profile add "link:$PWD/examples/plugins/memory-local"
pnpm exec dsh plugin --profile your-profile add "link:$PWD/examples/plugins/media-mock"
```

记忆示例在内存中保存测试记录，支持快照往返。媒体示例声明 `mock: true`，提供测试夹具元数据。配置字段在各示例中分别说明。[本地记忆](../examples/plugins/memory-local/README-zh.md) · [模拟媒体](../examples/plugins/media-mock/README-zh.md)

## 3. Provider 契约

**MediaProvider：** `capabilities`、`submit`、`inspect`、`cancel`、`collect`，提供持久句柄和结构化错误。声明图/视频、编辑/生成、支持规格、取消粒度、资源、目的地与价格。图片和视频可配置不同 provider，也可共享一个 ComfyUI 实例。每个 MediaJob 固定配置实例、实现 ID、插件版本和配置修订。选择变更仅影响新作业。读回解析已记录的确切句柄，原绑定缺失时报告其提供方不可用。

**CreationWorkflowProvider：** 声明输入/输出、依赖能力、工作流版本、步骤与恢复点。核心包装的媒体与工具回调继承确切任务范围，并在返回、取消或提供方排空时关闭。核心在交接前记录子媒体意图，在工作流取得句柄前记录已受理回执。核心策略检查每个子调用及声明的结果结构。

**MemoryProvider：** `read`、`search`、`upsert`、`supersede`、`forget`、`exportSnapshot`、`importSnapshot`、`health`。记录格式保留稳定 ID、owner/scope、内容、来源、显式/推断、有效期、revision 和删除标记。只支持向量检索的组件实现可选 `MemoryRetrievalProvider`，不能伪装成完整记忆存储；检索返回稳定记录 ID、分数和来源，核心再次检查范围与遗忘排除项。

记忆 provider 的记录保存个人事实，核心任务、授权、交付和排除记录保存在核心数据库。遗忘会先记录核心排除项，再请求提供方删除，并区分完成和待处理。检索候选通过范围一致的规范记录读回核实，在返回前再检查披露权限。快照导入保留已获确切核心排除确认的墓碑。处于排除范围内的活动记录无法召回或导入。

## 4. 用户配置和切换

设置页提供插件 ID/版本、能力、配置表单、健康状态、数据位置、网络去向、活动作业和“测试连接/设为默认/禁用”。秘密字段走安全输入卡片，配置只保存 CredentialRef。任意部署配置默认值必须经过 schema 校验，错误不能悄然回退。

1. 安装或选择插件，展示它需要的资源/数据访问；本地文件插件与联网插件区别清晰。
2. 校验版本和配置，运行 keyless 契约测试及所需连接探测；保存配置版本。
3. 媒体切换在新作业边界生效；旧实例保留至其作业结束或完成取消核对。
4. 记忆切换先冻结记忆写入，导出版本化快照（包括删除标记），导入候选后端并比对记录数量、ID、内容哈希和权限/检索用例。
5. 通过后原子切换核心的活动 provider 指针；新上下文请求使用新版本。旧快照按保留策略保存，原始任务和会话不迁移。
6. 导入失败保持原后端；回滚前将切换后的更正/删除通过变更日志补齐，不能简单指向过时副本而复活旧事实。无法补齐时先修复迁移，不自动回滚。

不承诺任意插件热替换：无活动作业时可以 drain 后换载；有活动作业则等待、核对取消或明确要求重启。插件不可用时任务显示该能力不可用；可以继续不依赖它的工作，不静默改用外部付费服务。

## 5. 权限和可信度

同进程 Cordis 插件属于可信代码，npm 包和 TypeScript 接口不是沙箱。用户编写且信任的 provider 可以进程内运行；不可信第三方实现需要受限子进程/RPC 或 VM，不能给它核心数据库路径、完整环境变量或密码库读权限。插件安装许可与每个任务的数据/动作许可分开。

所有外部模型/检索后端都声明数据目的地。切换到联网记忆检索或远程媒体服务时重新判断披露范围；不可把旧插件的读取许可当成新服务的数据上传许可。

## 6. 实施和验收

PA-038 建立插件 API、注册表、测试工具和示例；PA-012 实现独立默认记忆插件；PA-033/034 实现独立媒体与创作流程插件；PA-039 实现用户设置、配置切换、记忆迁移及回滚。

E21 必须证明：外部示例插件无需改核心即可加载；不兼容版本明确拒绝；两个媒体 provider 的新旧作业绑定正确；记忆后端往返迁移不丢记录/来源/删除标记；迁移失败保留原服务；更正/遗忘后回滚不复活旧事实；卸载无残留执行。示例媒体 provider 是测试模拟，不能用来宣称真实生图/视频能力。

模型调度与 API 网关也采用独立插件；自动难度/effort 选择、用户模型池、额度耗尽兜底及 DSH 请求边界见 [10](10-model-routing-and-gateway-zh.md)。
