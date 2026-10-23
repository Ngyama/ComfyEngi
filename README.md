# ComfyEngi

本地 ComfyUI 套图任务与 Prompt 管理工具。Electron + React + TypeScript，保留现有 Prompt 组合、计划展开和队列执行逻辑。

## 启动

Node.js 22.17+：`npm ci`，`npm run dev`。Windows 也可运行 `start.bat`。
首次启动选择创建空工作区、打开已有工作区，或从旧版数据库迁移。最近工作区记录保存在系统应用目录；创作数据位于所选 Vault。
设置 → ComfyUI 连接顶部提供工作区管理。运行期间禁止切换；切换验证目标后重启应用，不热替换数据库。切换前等待自动保存完成。

## 工作区

```text
prompts/
  characters/     # 角色
  outfits/        # 服装，通过 character_id 关联角色
  poses/ expressions/ cameras/ male/ global/ stories/
loras/
  metadata/       # 独立 JSON 管理信息
  previews/       # 用户主动选择的预览
workflows/        # 工作流和映射的唯一 JSON 真值
output/           # 预留；不会默认复制图片
logs/             # 错误日志
data/
  comfyengi.db    # 设置、任务草稿、队列、逐张快照、恢复信息、历史
  backups/        # 迁移前与每日 SQLite 备份
.comfyengi/
  vault.json      # 格式版本与迁移验证标志
  trash/          # 应用内删除的资源，保留以便手动恢复
```

工作区可整体复制。外部模型目录、ComfyUI 输出路径属于机器设置，换电脑后重新配置。SQLite 备份不包含 Markdown 和 LoRA 管理信息：完整备份应复制整个 Vault，复制前关闭应用。

## Markdown 格式与编辑

采用严格的 YAML frontmatter 子集：每行一个键，值必须是 JSON 值（JSON 引号字符串也是合法 YAML）。不支持任意 YAML 多行块、注释、锚点。Prompt 全文位于 positive/negative 字段，正文不参与解析。这样不会把 Prompt 中的标题、分隔线、代码围栏或权重语法误识别成格式标记。

```md
---
id: 1780000000000
type: "templates"
kind: "pose"
name: "姿态"
positive: "  (wariza:1.2), #tag\n---\n```  "
negative: "bad anatomy"
category: "sitting"
tags: "indoor"
note: ""
sort: 1
---
```

角色 type 为 characters，含 tag、loras 数组；服装为 outfits，含 character_id；剧情为 stories，scenes 数组保存有序场景及其完整正负 Prompt。数字 ID 在同类资源内稳定，文件名和所在子目录不是身份。复制资源产生新 ID。

应用写入临时文件后替换；删除移动到内部 trash。缺失 ID、重复 ID、格式错误和无效角色引用会报错，阻止加载错误索引。允许重命名和移动文件到 prompts 子目录。
文件监控防抖提示外部更改，设置中的刷新重新加载；不会自动替换正在编辑的草稿。保存检测文件版本，遇到冲突保留外部文件并提示用户复制界面草稿后刷新。请勿在冲突未处理时关闭或刷新应用。Prompt 不进行排序、去重或语义改写。

## 迁移

欢迎页或设置选择「从旧版数据库迁移到新工作区」，选择空目录。源为旧版 `%APPDATA%/ComfyEngi/comfyengi.db`（开发可通过 COMFYENGI_DATA_DIR 指定旧目录）。

在临时目录通过 SQLite 一致性快照复制源库，保留源库；在目标建立迁移前备份。逐字段核对模板数量、内容及 ID，并比较所有草稿展开后的 Prompt、Seed、LoRA、工作流输入和诊断。保留数字 ID，因此草稿引用、旧队列和历史不需改号。成功后清空目标 SQLite 模板内容，Markdown/工作流 JSON 成为唯一模板真值。队列原有冻结快照不变。

验证通过后发布目录，失败回滚发布目录并清理本次临时目录，不覆盖现有用户文件。已有工作区拒绝重复迁移。旧版数据库和目标备份不会自动清理。进程崩溃留下的 `.comfyengi-import-*` 目录可在确认无运行实例后手动检查或清理。

## LoRA Manager

主导航 → LoRA 管理 → 添加目录 / 重新扫描，可多选目录；取消目录选择则重新扫描已登记目录，支持 extra_model_paths 中实际目录的手动注册。扫描递归查找 safetensors，不复制、移动或修改模型。文件丢失保留记录并标记。

卡片支持名称、分类、标签搜索；详情可编辑分类、标签、备注、推荐权重、角色关联，以及手动替换预览，查看路径、大小、时间、基础元数据和打开所在目录。无预览使用占位符，不自动联网。
异步顺序扫描，只读最多 16 MiB safetensors JSON 文件头，不加载权重；损坏头部仍可管理。

角色库 → LoRA → 从 LoRA Manager 添加资源，保存 resource_id 和该角色的实际权重。Manager 的角色关联仅作分类，不会自动改写角色配置。
必须在 Manager 详情填写 ComfyUI Loader 选项中的相对模型名称，例如 `characters/a.safetensors`。外部物理路径不会直接写入 Loader。未配置名称、模型缺失会阻止新计划执行；仍可使用原有手工名称，实际可识别性通过工作流联网检查确认。
设置 → 工作流与映射中仅映射明确用于角色的 Loader 名称与强度，固定画风 LoRA 节点不映射，保留原值。所有映射的角色槽位必须有 LoRA，否则阻止入队；不会假定强度 0 可以禁用任意自定义 Loader。已入队保存的是解析后的实际节点输入，后续元数据编辑不会影响快照。

## 输出

保持 ComfyUI 原有保存行为。设置 ComfyUI 输出目录或其他实际输出目录用于本地定位；也可通过 API 查看图片。不会假定 filename_prefix 能写入 Vault 绝对路径，不默认复制模型或输出图片。

## 验证与边界

`npm run typecheck`、`npm test`、`npm run build`、`npm run e2e`。
测试包含旧库兼容、迁移内容及计划一致性、特殊字符往返、重命名、重复 ID、外部编辑冲突、冻结队列、LoRA 扫描损坏/缺失/不修改模型，以及现有 Mock ComfyUI 暂停、恢复、中断和队列逻辑。
E2E 启动真实 Electron，使用临时 Vault 和 Mock ComfyUI 检查任务编辑、预览、执行和历史页面。

未实现：模型文件主动迁移、自动解析 extra_model_paths.yaml、在线模型服务、任意 YAML 语法、海量文件增量索引、草稿冲突自动合并。Markdown 索引目前在主进程同步扫描；尚未做数千文件性能基准。真实 ComfyUI/GPU 和自定义 Loader 的生图兼容性仍需用户环境验证。
