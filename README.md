# ComfyEngi

本地 ComfyUI 套图任务与 Prompt 管理工具。Electron + React + TypeScript，保留现有 Prompt 组合、计划展开和队列执行逻辑。

## 启动

Node.js 22.17+：`npm ci`，`npm run dev`。Windows 也可运行 `start.bat`。
首次启动选择创建空工作区、打开已有工作区，或从旧版数据库迁移。最近工作区记录保存在系统应用目录；创作数据位于所选 Vault。
设置 → 常规顶部提供工作区管理。运行期间禁止切换；切换验证目标后重启应用，不热替换数据库。切换前等待自动保存完成。

## 安装与更新

从 [GitHub Releases](https://github.com/Ngyama/ComfyEngi/releases) 下载 `ComfyEngi-<版本>-setup.exe` 安装，无需 Node.js。可选择安装目录（默认 `%LOCALAPPDATA%\Programs\ComfyEngi`），安装后从开始菜单或桌面启动，在「应用和功能」中卸载。

设置 → 数据与维护 →「关于与更新」可手动检查更新：查询 GitHub 最新正式 Release，按语义化版本与当前版本比较；有新版时打开 Release 页面，由用户下载新安装程序覆盖安装。不会自动下载或安装。

安装、升级和卸载只处理安装目录：工作区（Vault）、`%APPDATA%\ComfyEngi` 中的最近工作区记录都不会被修改或删除；应用也不允许把工作区或输出目录选在安装目录内。安装包目前未签名，SmartScreen 可能提示，选择「更多信息 → 仍要运行」。发布流程见 [RELEASING.md](RELEASING.md)。

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
output/           # 默认的任务输出目录：生成完成后复制最终图片到这里
logs/             # 错误日志
data/
  comfyengi.db    # 设置、任务草稿、队列、逐张快照、恢复信息、历史
  backups/        # 迁移前与每日 SQLite 备份
.comfyengi/
  vault.json      # 格式版本与迁移验证标志
  trash/          # 应用内删除的资源，保留以便手动恢复
```

工作区可整体复制。外部模型目录、ComfyUI 输出路径属于机器设置，换电脑后重新配置。

备份分两种（设置 → 数据与维护）：

- 数据库备份：`data/backups/` 下的 SQLite 快照，包含设置、任务草稿、执行队列、逐张生成快照和运行记录。每天首次启动自动备份（保留 10 份），迁移/升级前也会备份，也可手动「立即备份数据库」。
- 完整备份：数据库备份不包含 Prompt 资料（prompts/ 下的 Markdown）、工作流 JSON、LoRA 管理信息与预览、输出图片。完整备份请关闭应用后复制整个工作区文件夹。

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
LoRA 写入工作流有两种方式：

- 任务级 LoRA 配置（套图任务页 LoRA 区）：自动读取所选工作流 LoRA Loader 中已有的 LoRA，分「角色 LoRA」与「工作流 LoRA」显示；可在本任务内调整权重、启用/停用、追加或替换，修改只保存在任务中，不修改工作流文件和 LoRA 文件。LoraManager 的 Lora Loader 只执行 `loras` 列表中启用的项。
- 高级映射（设置 → 工作流管理）：把指定 Loader 的名称与强度映射为角色槽位；被映射的 Loader 由映射控制。所有映射的角色槽位必须有 LoRA，否则阻止入队。

已入队保存的是解析后的实际节点输入，之后修改任务、元数据或工作流不会影响快照。

## 输出

ComfyUI 只能保存到它自己的 output 目录，因此分两步：

1. 文件名前缀（任务设置，新任务默认值见设置 → 生成默认值）写入工作流映射的「输出文件名前缀」节点，例如 `%date:yyyy-MM-dd%/image`。日期由 ComfyEngi 展开，路径中的非法字符和 `..` 会被清理；只能是相对路径。留空时使用工作流映射中的模板。
2. 生成完成后，通过 ComfyUI 的 `/view` 接口下载最终保存节点的图片（不含中间预览），复制到任务输出目录（默认工作区 `output/`，可按任务指定）。同名文件不覆盖，自动追加 ` (2)` 等序号；ComfyUI 中的原文件保留。

输出目录和前缀在入队时冻结到每张图片的快照中。复制失败时图片仍算已生成，但在执行队列和运行记录中标记为「未保存」并显示原因；修复目录后可「重试保存」，只重新下载复制，不重新生图。

设置 → 常规中的 ComfyUI 输出目录是可选的基础路径，仅用于在运行记录中定位 ComfyUI 保存的原文件。

## 历史 Prompt 提取

入口：侧边栏「Prompt 提取」，或素材库右上角「从历史图片提取」。读取过去生成的图片（PNG，以及 JPEG / WebP 的 EXIF 参数），找出反复出现的标签组合，选择后保存为素材。全部在本地完成：不联网、不调用任何 AI 服务、不需要 ComfyUI 运行。图片只以只读方式读取元数据，不修改、移动或重新编码。

1. 读取：「添加图片」（可多选）或「添加文件夹」（可勾选包含子文件夹），可多次添加。左侧显示发现图片 / 读到元数据 / 提取成功 / 需确认 / 失败 / 参与分析的数量和读取进度，扫描可取消；单张失败只显示原因，不影响整批。失败原因按类别汇总（点击可筛选出对应图片）。文件夹中没有可读取的图片时，会说明扫描了几个文件夹、是否包含子文件夹，以及找到了哪些不支持的格式。
2. 正向 Prompt 的识别（详见下方「支持的元数据格式」）：ComfyUI 的 `prompt` 元数据是整个 API 工作流，程序从采样器的 positive 输入沿连线向上追踪到文本编码节点，再解析文本。不会把所有 CLIPTextEncode 的文本拼在一起，未连接到采样器的文本节点不读取；多个采样阶段的 Prompt 不拼接。同一文本节点同时连到正负两侧、无法确定主采样器、或经过 Prompt 风格节点（模板内容未保存）时标记为「需要确认」，默认不参与分析，左侧会提示并可「全部纳入」或逐张检查。
3. 检查与补救：点击图片打开详情，有三页——
   - 正向 Prompt：提取结果、负向 Prompt、提取说明或失败原因；可「手动修改」或（失败时）「手动输入 Prompt」，「恢复自动提取」撤销。
   - Prompt 来源：元数据中所有可能是 Prompt 的文本（工作流中每个文本节点 / 编码节点、parameters 的正向部分、NovelAI 的 prompt、其他文本字段），标出它连到正向、负向还是未连接采样器；通配符模板、仍含通配符语法的文本会单独提示。选择一项即作为这张图片的正向 Prompt，然后可以：
     - 「应用到 N 张」：在其他图片中查找同类型节点（class_type）的同一字段，不要求其他节点和连线一致（采样器、LoRA 节点不同也能匹配），每张图片读取自己节点中的文本。同一图片中有多个同类型节点时，依次用连接方向、节点标题、局部连接结构、节点编号区分，仍无法区分时视为歧义、不随机选择；连到负向的节点不会被当作正向。可勾选「只匹配节点 #N」严格按节点编号匹配（同时校验类型与字段）。应用前显示扫描总数、可应用数，以及已是此来源、自动提取已成功（默认保留，可勾选一起替换）、缺少节点、歧义、连到负向、节点编号类型不同、已手动修改（跳过）、没有元数据等数量。应用后这些图片直接参与分析并自动重新分析。直接保存在字段中的文本（如 parameters、Comment）按字段名应用。
     - 「保存为来源规则」：保存在工作区 `data/prompt-source-rules.json`（随 Vault 迁移，重启后仍有效）。以后扫描图片时，自动提取失败、需要确认或只是已知节点识别的图片，按规则读取唯一匹配的节点字段；自动提取可靠时不覆盖，规则结果不同则标记「差异」并可一键改用。页面右上角「来源规则」可查看命中数、重命名、停用、调整顺序（靠前优先）、切换严格节点编号、删除。
     优先级：手动指定 > 已验证的自动解析 > 保存的来源规则 > 已知节点的专用识别 > 其他候选（等待确认）。手动修改过文本的图片不会被批量或规则覆盖。
   - 原始元数据：图片实际包含的全部文本字段（字段名、存放位置如 tEXt / iTXt / EXIF UserComment、字符数），可展开查看，JSON 自动格式化；单个字段只显示前 40 万字符，「复制原文」复制完整内容。提取失败时也能查看。
4. 分析：读取完成后自动分析（手动指定的图片也参与），可调整参数后「重新分析」。参数：最小共同出现（默认 3 张）、全局公共阈值（默认 90%）、最少标签数（默认 2）、关联强度（默认 2×）、最多显示（默认 60）。
5. 结果分三页：
   - 重复组合：每个组合显示完整标签、覆盖图片数与比例、关联度、来源图片、与已有素材是否重复。可修改名称（默认「提取组合 001」这类临时编号，不推断含义）、直接编辑 Prompt、删除其中的标签。展开后可查看变化标签（只在部分图片中出现的标签，只描述共现差异，不代表互斥）、扩展组合（在部分图片中还一起出现的其他标签），以及弱关联标签；可以把选中的标签加入组合或另存为新组合。
   - 全局公共：出现比例达到阈值的标签及频率，可作为组合加入保存列表。
   - 全部标签：每个标签的出现次数、比例、不同写法（权重）与来源，默认显示未被任何组合覆盖的标签（只出现一次的也会显示），可勾选若干标签创建组合。
6. 保存：勾选组合（可全选），选择保存类别（单人动作、主体位、子体位（需选所属主体位）、行为、表情、场景、镜头、全局 Prompt），点击「保存所选」。通过现有的素材保存接口写入 Vault 的 Markdown 文件（新 ID、名称、positive，负面为空），遵守现有的文件命名与冲突规则。标签集合（忽略顺序与权重）与已有素材或本批更早的组合相同时提示并跳过，不覆盖、不修改任何已有素材，也不影响任务、队列与运行记录。

支持的元数据格式（按文件内容识别，扩展名与内容不符时按实际格式读取并提示）：

- PNG 文本块 tEXt / zTXt / iTXt（中文按 UTF-8）；JPEG 的 EXIF、注释与 XMP；WebP 的 EXIF / XMP。文件在中途截断时，之前已读到的元数据仍然有效。
- ComfyUI `prompt`（API 工作流，优先）：原生 KSampler / KSamplerAdvanced / SamplerCustom、SamplerCustomAdvanced + CFGGuider / BasicGuider；CLIPTextEncode、SDXL（text_g / text_l）、Flux（clip_l / t5xxl，负向为 ConditioningZeroOut 时不误判）以及名称含 TextEncode 的自定义编码节点；ConditioningCombine / Concat / SetArea、FluxGuidance、ControlNet（按输出槽区分正负）；字符串常量、Text Multiline、文本拼接（StringConcatenate、WAS Text Concatenate、Join Strings 等，忽略 clean_whitespace 之类的选项）；Efficiency Nodes（Efficient Loader + KSampler (Efficient)）、Easy-Use / ttN 管道采样、rgthree Power Prompt、Impact Pack 的 ImpactWildcardProcessor / ImpactWildcardEncode（采用保存的展开后文本 populated_text，按 Impact 的规则去掉 # 注释行；仍含 `__x__` / `{a|b}` 语法时运行时会再次随机展开，标记为需要确认；wildcard_text 只是模板）。LoraManager：Lora Loader 的 text 是 LoRA 语法、TriggerWord Toggle 的触发词在运行时生成，拼接时省略触发词并说明，Prompt (LoraManager) 读取 text。追踪在不认识的节点处中断时，如果正向链路（按连线可达性判断）上的通配符节点保存了展开后文本，自动采用并说明；无法确认连接方向时标记为需要确认。Hires 第二阶段、FaceDetailer 等使用不同 Prompt 时采用第一阶段。Python 写出的 `NaN` / `Infinity` 也能读取。
- ComfyUI `workflow`（界面格式，没有可用的 `prompt` 时）：原生节点、字符串常量节点、被绕过的节点（直通）、KJNodes Set / Get 节点；子图无法展开。ComfyUI 保存的 WebP（EXIF 中的 `prompt:` / `workflow:`）同样读取。
- WebUI / Forge / reForge 的 `parameters`（PNG 文本块，或 JPEG / WebP 的 EXIF UserComment）：`Negative prompt:` 之前的全部行为正向，多行、BREAK、LoRA、权重原样保留。工作流有歧义而自定义保存节点另外写了 `parameters` 时，采用 `parameters`。
- NovelAI（Comment 的 prompt / uc，或 Description；V4 的角色提示词单独列在来源中）、InvokeAI（invokeai_metadata、sd-metadata、Dream）、SwarmUI 与 Fooocus（JSON 格式的 parameters）、Easy Diffusion（纯文本 prompt 字段）。
- 不能恢复的情况：动态 Prompt / 随机通配符 / LLM 生成 / 图像反推（WD14 Tagger 等）节点在运行时生成文本，PNG 中只有模板或设置，程序报告原因而不把模板当作结果；未保存展开结果的通配符同理。这类图片可在「Prompt 来源」中选择最接近的文本或手动输入。NovelAI 的隐写（alpha 通道）元数据、AVIF / GIF 等格式不读取。

挖掘算法（确定性）：

- 标签：只在最外层的逗号 / 换行处切分，括号内（权重组、`{a|b}`、LoRA）不切分，也不按空格拆分多词标签。比较键去掉外层权重（`(x:1.2)`、`((x))`、`[x]`）、反转义 `\(` `\)`、忽略大小写，空格与下划线统一。原写法与权重保留：同一标签的不同权重算作同一标签并记录各写法的次数，组合默认使用出现最多的写法。同一图片内重复的标签只计一次。
- 全局公共标签：出现比例 ≥ 阈值的标签，从局部挖掘中排除，避免 `masterpiece`、`1girl` 等与所有组合产生虚假关联。
- 局部组合：对其余标签做闭频繁项集挖掘（LCM，前缀保持的闭包扩展，每个闭项集只枚举一次），即「一批图片共同拥有的全部标签」，天然去掉了覆盖相同图片的子集。然后逐个检查组合中的标签：与其余标签一起出现的频率至少是随机搭配的 N 倍（提升度 ≥ 关联强度），或总是与其余标签一起出现且不能用随机搭配解释（二项检验 p < 0.05），否则移出组合（例如随机出现的场景、表情）。
- 去冗余与排序：覆盖图片数不少于 80% 的超组合存在时只保留更完整的；包含已列出组合的超组合嵌套为「扩展组合」（例如较短组合覆盖 20 张、较长组合覆盖 10 张时两者都能看到）。按「覆盖图片数 × 标签数」排序。
- 规模：约 100 张图片、数千个标签在一秒内完成，分析在独立线程中运行。组合数量超过上限时自动提高最小共同出现图片数并提示，不会无限运行。相同图片与参数总是得到相同结果（图片按路径排序，与选择 / 遍历顺序无关）。

标签词典（可选）：页面右上角「词典」→ 导入本地 CSV / TXT / JSON（CSV 第一列为标签名；a1111-tagcomplete 格式的第四列作为别名；TXT 每行一个；JSON 为标签数组或 `{name, aliases}` 数组）。词典保存在工作区 `data/tag-dictionary.json`，不随程序打包。作用是统一别名、标记词典外的标签；不会按 Danbooru 类别自动分类，词典外的标签（自定义标签、触发词）照常参与分析。没有词典时功能完全正常。

## 验证与边界

`npm run typecheck`、`npm test`、`npm run build`、`npm run e2e`（Prompt 提取另有 `scripts/e2e-mining.mjs`，LoRA 管理另有 `scripts/e2e-loras.mjs`）。
测试包含任务自动保存（快速连续修改、请求重叠、切换任务）、任务输出复制与重试保存、新任务默认值、旧库兼容、迁移内容及计划一致性、特殊字符往返、重命名、重复 ID、外部编辑冲突、冻结队列、LoRA 扫描损坏/缺失/不修改模型，以及现有 Mock ComfyUI 暂停、恢复、中断和队列逻辑。
E2E 启动真实 Electron，使用临时 Vault 和 Mock ComfyUI 检查任务编辑、预览、执行和历史页面。

未实现：模型文件主动迁移、自动解析 extra_model_paths.yaml、在线模型服务、任意 YAML 语法、海量文件增量索引、草稿冲突自动合并。Markdown 索引目前在主进程同步扫描；尚未做数千文件性能基准。真实 ComfyUI/GPU 和自定义 Loader 的生图兼容性仍需用户环境验证。
