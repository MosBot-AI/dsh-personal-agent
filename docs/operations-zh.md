# 常驻宿主运维

[English](operations.md) · [文档索引](README-zh.md)

dshpa 在所有者电脑上的一个命名前台 DSH Web Profile 中运行。浏览器连接或关闭时，SQLite 写入权、调度、Worker 和本地收件箱均由同一进程持有。macOS 可选择使用 LaunchAgent。Linux 无桌面部署可通过 systemd 用户服务运行相同的回环进程。模型和连接器的可用性取决于已配置的路由。

## 准备并运行 Profile

使用固定版本的 Node.js 和 pnpm 构建工作区。首次创建一个新的命名 Profile。DSH 初始化会替换同名 Profile。

```sh
export DSH_HOME="$PWD/.dshpa/resident-home"
pnpm install --frozen-lockfile
pnpm build
pnpm exec dsh --profile dshpa-resident --from-default-profile web --dump-config
pnpm exec dsh plugin --profile dshpa-resident add "link:$PWD/packages/personal-agent"
```

将以下所有者覆盖配置保存为 `$PWD/.dshpa/resident.yml`。Worker 或路由配置可添加到同一个 `inbox` 块。调度配置启用现有例行任务控制与精确唤醒对账。

```yaml
- id: dshpa
  config:
    inbox:
      storageDirectory: !!js dshHomePath('resident-state')
      workRoot: !!js dshHomePath('resident-work')
      routines: true
      resident: {}
```

```sh
dshpa_node=$(command -v node)
dshpa_overlay="$PWD/.dshpa/resident.yml"
sh deploy/run-resident.sh "$dshpa_node" "$DSH_HOME" dshpa-resident "$dshpa_overlay" 3080
```

启动器直接执行固定版本的 DSH 进程，绑定 `127.0.0.1`，并将原生私有输出排除在服务日志之外。原生调度解析就绪前先取得 SQLite 写入租约。竞争的常驻 Profile 会在取得所有权前退出。前台宿主可用 Ctrl+C 停止，服务管理器通过 `SIGTERM` 请求关闭。运行时停止接受新操作，释放自有工作并关闭存储。强制退出后，下次启动会从持久状态恢复。

## 检查宿主

```sh
dshpa_state="$DSH_HOME/resident-state"
curl --noproxy '*' http://127.0.0.1:3080/dshpa/live
curl --noproxy '*' http://127.0.0.1:3080/dshpa/ready
node deploy/ops.mjs inspect "$dshpa_state"
node deploy/ops.mjs owner-url "$dshpa_state"
```

存活端点报告进程是否可达。启动、对账、仅恢复检查及停止期间，就绪端点返回 HTTP 503。两条公开响应只含生命周期字段和当前进程标识。所有者检查使用已认证的本地载体，展示诊断代码及计数。显式调用 `owner-url` 可取得当前进程的浏览器登录链接。链接文件仅所有者可访问，正常关闭时会移除。

看门狗针对当前 Attempt 报告进展停滞、重复工具调用、计算限额及供应商故障，其用途是诊断。供应商认证失败时等待所有者重新验证。暂时性故障进入带时间条件的资源等待，并保留不确定计费证据。Worker 已释放且条件满足后，所有者可恢复。较长的心跳间隔触发有界的暖调度对账，并保留正在运行的工作和已取消代次。

## 按需启用登录启动

使用已准备好的 Profile 和相同路径生成服务描述。模板在登录或用户管理器启动时运行。进程故障或配置变更后由操作者重启。语义看门狗仅负责诊断。

### macOS LaunchAgent

```sh
dshpa_unit="$HOME/Library/LaunchAgents/org.mosbot.dshpa.dshpa-resident.plist"
mkdir -p "$HOME/Library/LaunchAgents"
node deploy/render-service.mjs launchd "$dshpa_node" "$DSH_HOME" dshpa-resident "$dshpa_overlay" 3080 > "$dshpa_unit"
plutil -lint "$dshpa_unit"
launchctl bootstrap "gui/$(id -u)" "$dshpa_unit"
```

运行 `launchctl bootout "gui/$(id -u)/org.mosbot.dshpa.dshpa-resident"` 停止并卸载。移除 plist 以关闭登录启动，保留命名 Profile 和状态以供复用。

### Linux 用户服务

```sh
mkdir -p "$HOME/.config/systemd/user"
dshpa_unit="$HOME/.config/systemd/user/dshpa-resident.service"
node deploy/render-service.mjs systemd "$dshpa_node" "$DSH_HOME" dshpa-resident "$dshpa_overlay" 3080 > "$dshpa_unit"
systemd-analyze verify "$dshpa_unit"
systemctl --user daemon-reload
systemctl --user enable --now dshpa-resident.service
```

服务使用运行中的 systemd 用户管理器。若需要在登录前启动或退出登录后继续运行，请使用宿主的用户管理器策略。运行 `systemctl --user disable --now dshpa-resident.service` 停止并关闭自动启动，移除服务描述后重新加载用户管理器。保留 Profile 和状态目录。

## 备份、恢复与保留

```sh
node deploy/ops.mjs backup "$dshpa_state"
node deploy/ops.mjs audit "$dshpa_state"
```

备份将已提交的 SQLite 视图和已封存产物字节复制到独立且仅所有者可访问的文件。默认目标是 WorkStore 下的 `resident-backups`。若使用独立卷，请将 `resident.backupDirectory` 设为此 WorkStore 专用的绝对路径，其父目录须已存在。成功备份后，保留策略在 `resident.maxBackupAgeDays` 内最多保留 `resident.maxBackups` 份受管快照，默认值分别为 30 天和七份。

如果同一所有者需要检查恢复后的 WorkStore，请单独保存权限为 `0600` 的所有者身份文件 `local-inbox-identity.json`。按[备份恢复流程](../README-zh.md#恢复独立工作备份)将独立数据库恢复到新目录。将匹配的身份文件复制到恢复目录，调整所有者覆盖配置后启动 Profile。恢复宿主允许限定范围的检查，进程处于存活状态，就绪则等待对账，旧派发授权继续受限。

审计命令输出已认证所有者范围内的固定元数据和计数。将 `nextAfterSequence` 作为可选的最后一个参数即可读取下一页。完整备份含有工作记录。看门狗诊断元数据默认在内存中最多保留 14 天、512 条。可用 `resident.watchdog.retentionDays` 和 `resident.watchdog.maxDiagnostics` 调整上限。权威工作记录及产物按所有者的保留与删除决定处理。
