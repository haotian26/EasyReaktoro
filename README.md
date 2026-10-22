# EasyReaktoro

**English and 简体中文** — switch instantly in Settings → General → Interface language. Database management, equilibrium simulations and the result viewer share the same language. Switching preserves your inputs, code, plots and saved data.

EasyReaktoro 是面向 Reaktoro 的非官方 macOS 图形界面。v0.17.1 提供数据库发现、浏览、组建、编辑、验证、导出、Python/notebook RTDB 读取接口，以及平衡模拟工作台。模拟用路径位置与反应轮次组织单点平衡、温压扫描和多轮水岩反应，可在同一次反应中同时改变温压、composition 每份含量、加入份数和物料取用比例。首次起点、首轮后续位置、后续轮起点和后续轮其余位置分别列出实际加入的 composition 或反应后物料，可按相态或指定 species 取用，支持分流、混合与回流。可一键切换图形设置与完整分模块 Python 程序，保留参数与自定义求解代码；全部代码随设置和结果保存。

应用依赖用户自行安装的外部 Reaktoro Python 环境，不打包 Python、Reaktoro、官方数据库或个人数据库。

源码仓库：[haotian26/EasyReaktoro](https://github.com/haotian26/EasyReaktoro)。项目代码采用 [MIT 许可证](LICENSE)；第三方代码和品牌标识的边界见 [第三方说明](THIRD_PARTY_NOTICES.md)。可从 [GitHub Releases](https://github.com/haotian26/EasyReaktoro/releases) 下载 macOS 安装包。

## 运行

支持 Apple Silicon macOS 13 及以上；已在装有外部 Reaktoro 的独立用户 Apple Silicon macOS 虚拟机验收；尚未覆盖从零安装 Reaktoro，Intel Mac 与 Windows 也尚未验收。从 [v0.17.1 Release](https://github.com/haotian26/EasyReaktoro/releases/tag/v0.17.1) 下载 `EasyReaktoro-v0.17.1.dmg`，打开后将 EasyReaktoro 拖入 Applications。安装包采用 ad-hoc 签名，未经 Apple 公证；仍需自行安装外部 Reaktoro Python 环境。Git 仓库不包含 `.app`，从源码运行请按下文构建。已有本地构建包的用户可在 Finder 双击 `release/EasyReaktoro-v0.17.1.app`，或运行：

```bash
open release/EasyReaktoro-v0.17.1.app
```

首次启动时，应用会自动探测可用的 Reaktoro 环境。也可以选择具体的 Reaktoro Python，或选择 Conda/Reaktoro 环境目录。存在多个环境时可在“设置 → Reaktoro 环境”中切换、测试连接并查看诊断。

自动探测不是固定路径：应用会检查环境变量、`/Applications` 下的应用环境、常见 Homebrew/Conda/Mamba 安装位置、用户级 Conda/Micromamba/Pyenv 环境以及系统 Python，并只显示能够真实导入 Reaktoro 的候选项。候选项按 Python 规范路径、环境根目录和 Reaktoro 版本去重。

## v0.17.1

- 局部条件直接编辑并保留继承规则；错误提示定位到具体输入，公式变量就地说明，连续输入按一次撤销处理。
- 预览与校验按每轮实际长度处理；保留暂未经过的位置设置，明确显示当前生效范围，避免引用不存在的前轮位置。
- 跨页书签可定位到实际结果；返回结果首页会取消未完成的跳转，继续查看时保留位置和图表设置。

## v0.17.0

- **直接定义反应步骤**：首轮与后续轮次分别填写初始步、后续步的 T、P、Composition；数值、公式和结束条件都在同一页编辑。预览、Python 参数代码与实际计算使用同一份设置。
- **可展开的流程示意图**：短流程直接显示，长流程按重复步骤概括；显示实际物料传递、数值范围和局部条件，可跳到任意位置查看连续的附近步骤。
- **局部设置保持原规则**：只覆盖实际修改的参数，例如修改温度后，未改动的 Psat(T) 仍随温度计算。各轮长度不同时，拒绝引用上一轮不存在的位置。

- **数据库历史版本**：保存有改动的个人数据库时保留上一版，默认每库保留 10 份。在“操作 → 历史版本”中查看变化、恢复为新副本、删除版本或调整保留设置。历史存放在当前用户的应用数据目录，不修改原来的导出文件。
- **Reaktoro 连接帮助**：未找到环境时提供官方安装说明、选择环境文件夹和选择 Python；区分所选 Python 缺少 Reaktoro 与其他连接错误。Reaktoro 仍由用户自行安装。
- **pH 与气体逸度目标**：在“计算流程 → 添加指定条件”添加，指定调节物质或气体、作用范围及变化方式。目标可按步、轮次和局部设置变化；所需外部物质交换量计入逐点与累计元素收支，随结果保存。



## 当前工作区

首页按数据库与物种管理、构建平衡计算、查看与比较结果组织入口，左侧窄导航同时显示图标和名称。数据库选择将“我的数据库”与只读“系统数据库”分开展示，可分别搜索；紧凑列表显示名称、物种数和元素数。自己的数据库从文件读取实际数量，未保存的修改单独标记；为模拟选择数据库后直接进入模拟。结果可独立打开，不要求先选数据库或连接 Reaktoro。

数据库使用顶部统一操作栏，搜索与详情占据窗口主体。名称、化学式（支持下标输入）、原始名称和模型可以组合查找；精确匹配优先。⌘F 搜索，↑↓ 浏览当前页，Enter 查看。元素周期表、相态和模型可组合筛选，页码可直接跳转。

模拟可一键切换图形设置与 Python 代码。六个参数模块与图形界面同步，`schedule` 保存计算规模、各参数的变化方式和局部设置，随后八个执行模块展示并实际运行体系构建、平衡求解、物料库存、逐位置与逐轮传递和结果保存。修改执行模块进入自定义模式，返回图形界面保留代码；每次运行在全新独立进程中从头执行全部模块。详见 [模拟说明](docs/SIMULATION.md)。

模拟底部显示当前填写进度和可直接定位的缺项；“已填写”只表示基础字段完整，运行前仍由 Reaktoro 检查。活度模型将必要参数放在公式前面，逐项说明缺失的离子尺寸或来源。结果首点计算中、空图表和失败状态均提供对应操作，避免停留在无法继续的页面。

## 基本使用

1. 在首页确认 Reaktoro 已连接；未连接时仍可离线打开和编辑 `.rtdb`，但电脑上需要可用的外部 Python 3。离线不代表应用自带 Python。
2. 进入“数据库”查看“我的数据库”和由外部 Reaktoro 提供的 PHREEQC、SUPCRT、NASA 数据库。
3. 系统数据库为只读。可选择物种创建可编辑 `.rtdb`，或尝试复制整个数据库；依赖缺失或循环会阻止提交。
4. 可编辑数据库的工具栏直接提供“新建物种”。创建时先从 118 元素周期表选择组成和数量，再指定电荷、相态及模型；系统生成的化学式可以继续修改并实时预览。模型参数、有效温压范围、形成反应和扩展 Debye–Hückel 离子尺寸均使用图形化字段，不输入 JSON。
5. MRB 既可直接填写三个参数，也可输入至少三组温度、压力与 \(pK\) 或 \(\log K\) 数据进行真实最小二乘拟合。形成反应通过可搜索的已有物种选择器输入，并实时显示排版后的反应式。
6. 参考文献可以直接整段粘贴；作者、年份、题目、期刊和 DOI 等结构化字段仅在需要时展开填写。
7. 数据库显示名称采用 `.rtdb` 文件名；从系统数据库创建时在系统保存面板中直接命名文件。
8. 可编辑数据库还支持从 YAML、其他 `.rtdb` 或安全的已转换数据文件夹导入、验证、保存及另存为。
9. “保留模型参数（YAML）”导出 Reaktoro 支持的记录，并在保存前重新加载验证；“温压插值数据（YAML）”按指定温压网格采样，并检查插值误差。

使用提示：`⌘S` 保存当前页面的数据库、模拟设置或结果工作区；数据库页的 `⌘F` 聚焦物种搜索。物种表单顶部可跳转章节，底部固定显示保存操作；保存物种后会定位到该记录。周期表支持元素符号、中英文检索，单个精确匹配可按 Enter 选择；筛选只有点击“应用筛选”才生效，取消不改变当前筛选。重要错误会保留到手动关闭。

同名且来源无法确定的形成反应不会自动绑定任意记录，会显示具体引用链和候选来源。导出仅接受 `.yaml` / `.yml`，并检查符号链接的实际目标，防止覆盖 `.rtdb`。自定义模型详情中的参数名称和单位来自统一模型定义，不从数值猜测。

关闭有未保存修改的数据库时必须选择保存、放弃或取消；保存失败不会关闭数据库。

“保存物种”和 MRB“拟合完成”先更新当前数据库/表单；仍需点击数据库“保存”才写入 `.rtdb` 文件。拟合结果会说明当前写入状态，保存失败时保留修改。

若文件被其他程序修改、删除或正在由其他 SQLite 程序写入，保存会拒绝覆盖，可选择“操作 → 另存为”保存到新文件。创建和另存为也不覆盖已有文件，请使用新文件名。旧 v1 数据库只在内存副本中迁移，明确保存后才升级原文件。

## 平衡模拟

数据库、模拟、结果是同级工作区。左侧保留带名称的窄导航栏，按需展开导航抽屉；顶部一行放置当前页面的名称与操作。模拟分为系统物种、初始物质、计算流程、活度模型四页。species 采用紧凑网格，复用元素周期表筛选；初始投料从已选体系中建立独立 composition，支持 mol、g、kg。未投入但选入体系的 species 仍可在反应中生成。新建模拟预选数据库中可唯一识别的水、H⁺、OH⁻，不自动填写初始投料；多个数据版本需明确选择，已有模拟保留原选择。默认按基础 species、络合物的顺序浏览，水、H⁺ 和 OH⁻ 优先；同化学式的多个版本相邻展示，悬停或键盘聚焦查看模型参数、单位和文献，并显示暂不可算记录的具体原因。

当前数据库中已不存在的 species 单独列出，可逐项或全部移除。清理同时处理 composition 投料、各处物料来源中的指定 species、水溶剂、离子尺寸和关联投料变化量，支持撤销；只移除失效的参数引用，保留计算步数、轮数和其他参数。

计算流程在同一页展示首轮与后续轮次，各自填写第一步和后续步的 T、P、Composition。直接输入数值或公式，例如 `250`、`T-50`、`Psat(T)`，无需先选择变化方式。用 `i = 3` 指定 4 步，用 `N = 2` 指定 3 轮；也可按 `P < 150` 等条件结束，各轮长度可以不同。满足结束条件的当前步仍计算。

Composition 每项选择来源、相态或指定 species，再填写乘数。新 composition 的乘数表示份数，已有输出的乘数表示取用比例：`0.5` 表示半份或 50%。用量、温压均可按步或轮次变化；参数承接与物料传递分别设置。四处组成可以一次性复制后分别编辑，单点与多点沿用同一页面布局。

预览显示横向路径与纵向轮次，箭头只表示实际物料传递并标明相态。短流程直接显示；长流程概括重复步骤、实际变化范围和局部条件，展开后显示所选位置附近的连续步骤。选中点显示实际条件与用量，可直接单独修改。长路径可输入确切坐标；已结束的位置不绘制虚假计算点。旧配置保留原含义，无法无损转换的复杂逐位置来源保留原编辑方式。

压力公式 `Psat(T)` 使用本步温度，适用 0.01 ≤ T < 373.946 °C。它是纯水参考压力，不计算盐水或混合气泡点，也不会自动加入气相。温压、物料和其他指定条件可独立设置。更多语法、停止规则及兼容性说明见 [模拟说明](docs/SIMULATION.md)。

Extended Debye–Hückel、Davies、HKF、PHREEQC 与理想水相，以及气相模型，都提供渲染后的方程、参数解释和对应引用；页末列出文献及外部链接。数据库标准态数据和活度模型分别选择、分别记录。

运行前通过系统窗口选择保存位置，以模拟名称创建文件夹，结果逐点写入。同名结果已存在时，可明确选择“覆盖结果”或“另存为…”；另存只改变本次结果名称，不改模拟名称，不自动添加随机后缀。无法安全识别为计算结果的已有文件或目录不提供覆盖。取消不会启动计算。退出后可重新打开，异常中断后仍可查看已完成点的结果。保存与载入通用 `.ersim.json` 设置，旧版设置自动迁移。

“查看结果”进入同级结果页；“打开已保存结果”读取整个计算文件夹，“保存位置”在 Finder 中定位该文件夹。图表可返回“结果首页”，通过“继续查看”恢复原视图。结果跟随应用语言和浅色/深色主题，两侧面板可折叠、调整宽度，也可专注图表。以 pH、系统性质或 species 数值为横轴时，默认使用散点，X/Y 来自同一采样点；可比较当前轮次或全部已载入轮次，也可按采样顺序分别连线。矿物的 molality 不适用，应查看已输出的平衡量 amount / mol、入口量或净变化量。提供多图、条件叠加、长按按钮连续浏览、参考点、书签、变化定位及 SVG/CSV/HTML 工作区导出；运行目录另存完整独立探索器。

组成与物料传递示例、模型边界和文件说明见 [模拟使用说明](docs/SIMULATION.md)。

## 模拟历史与保存

模拟与结果的“历史”均位于工作区顶部左侧。“新建”保留当前模拟并开始新的一份；模拟历史可搜索、复制、切换及移到“最近删除”，最近删除可恢复、永久删除或一键清空。清空需确认数量，仅删除当时列出的模拟设置文件，计算结果文件保留。结果历史区分“计算结果”和“图表工作区”，记录已打开的计算目录及已保存、打开的 HTML 工作区，支持搜索和重新打开；移除记录不会删除结果文件。每份模拟独立保存参数、代码和最近结果引用；历史位于当前用户的应用数据目录 `Simulations/`，目录根路径由操作系统决定。模拟历史抽屉可在 Finder 中定位设置文件夹。另存 `.ersim.json` 用于备份和分享；历史不内嵌数据库，重算需要对应数据库。

历史中的每份模拟使用独立文件编号，名称可修改；条目显示对应的 JSON 文件名，“显示文件”可定位实际文件。返回应用时会刷新外部文件变化。原文件若已在 Finder 中删除，当前编辑可保留为新模拟、放弃或继续编辑，自动保存不会重新创建被删文件。载入 `.ersim.json` 会建立独立历史副本，使用当前选定数据库；后续修改不写回原设置文件。结果目录被删除后，关联模拟仍可打开，失效的“查看结果”入口会清除。

默认自动保存，也可关闭并使用“保存”或 ⌘S；未保存时切换模拟、数据库或退出，会选择保存、放弃或继续编辑。支持整个模拟的撤销、重做及恢复到上次保存；撤销记录仅在本次打开期间保留，输入框和代码编辑器保留自己的文本撤销。运行会保存本次计算快照。⇧⌘S 另存设置文件。

模拟右上角可搜索并快速切换系统或自己的数据库，各库保留独立的模拟。“跨库选择物种”支持从多个系统数据库和 `.rtdb` 创建新的组合数据库，预览依赖及参数冲突。同参数记录合并补充文献、备注和来源；不同参数保留为可辨认的版本，不修改来源文件。结构检查不能代替对标准态、活度约定和参数来源相容性的科学判断。

软件“设置”包含外观、启动行为、文件位置、默认数据库、保存方式及 Reaktoro 环境。模拟参数在对应步骤设置，图表与播放在结果页直接调整；不设重复的工作区偏好窗口。已有模拟、用户参数代码与结果工作区继续保留自身配置。

新建物种的元素选择在完整周期表中完成，支持搜索、方向键、已选标签和一键清除；取消只放弃尚未应用的元素选择。表单取消与应用退出使用居中的未保存确认，继续编辑可保留内容。

## 开发与测试

Python/notebook 可以通过 `easyreaktoro_runtime.load_database(path)` 将完整可计算的 `.rtdb` 读取为普通 Reaktoro `Database`。这不是 `Reaktoro.Database.fromFile()` 原生支持的新文件格式，也不会自动选择活度模型。路径配置、版本要求、离子尺寸读取和求解器示例见 [RTDB Python 接口](docs/RTDB_PYTHON.md)。

构建需要 Node.js 20+、npm、Rust 稳定工具链及 Xcode Command Line Tools。运行还需要独立安装的 Python；完整功能需要该 Python 能够导入 Reaktoro。本版数值与目录回归的基线为 Reaktoro 2.13.0 / Python 3.12。

```bash
git clone https://github.com/haotian26/EasyReaktoro.git
cd EasyReaktoro
npm ci
npm test -- --run
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
CARGO_PROFILE_RELEASE_STRIP=none npx tauri build --bundles app
codesign --force --deep --sign - src-tauri/target/release/bundle/macos/EasyReaktoro.app
codesign --verify --deep --strict src-tauri/target/release/bundle/macos/EasyReaktoro.app
bash scripts/package-macos.sh
```

默认构建产物为 `src-tauri/target/release/bundle/macos/EasyReaktoro.app`；可用 `open src-tauri/target/release/bundle/macos/EasyReaktoro.app` 启动。打包脚本将版本一致的应用和 Applications 链接放入 `release/EasyReaktoro-v<version>.dmg`；`release/` 不进入 Git。图标资源与原生保存面板补丁均随源码提供；构建不下载或打包 Reaktoro 数据库。

Bridge 集成测试需要外部 Reaktoro：

```bash
EASYREAKTORO_PYTHON=/path/to/environment/bin/python /path/to/environment/bin/python -B -m unittest discover -s tests -v
```

不含 Reaktoro 的离线子集可运行 `python3 -B -m unittest discover -s tests -p test_quality.py -v`；需要 Reaktoro 的用例会跳过。完整测试中的目录数量和版本断言针对上述基线，不表示任意 Reaktoro 版本具有相同目录。

参与开发前请阅读 [贡献指南](CONTRIBUTING.md)、[隐私说明](PRIVACY.md) 和 [安全说明](SECURITY.md)。

## 数据与架构

`.rtdb` 是带版本迁移的 SQLite 数据库，结构化保存数据库元数据、物种、组成、模型参数与范围、反应和依赖、活度参数、来源、参考文献、disabled drafts、验证和 audit。保存采用同目录临时文件原子替换；旧 schema 迁移失败时不改动原文件。

Rust 使用所选外部 Python 启动持久 NDJSON Bridge。应用包只包含轻量 Python 源码 `bridge/easyreaktoro_runtime`，不包含 Python 解释器、Reaktoro 或数据库副本。

打开与保存路径使用 Tauri 原生 Dialog。项目保留一份带 macOS `showsTagField=false` 小补丁的官方 `rfd 0.16.0` 源码，以确保 `.rtdb` 和 YAML 保存面板不显示无关的 Finder Tags，并让该行为可以在其他电脑上复现构建。

## 已知限制

- 模拟支持平衡点、物料传递、指定 pH 与气体逸度目标；尚不包含动力学、流速/弥散、固溶体、指定 Eh 或中断续算。
- 当前 Reaktoro 2.13.0 的部分 PHREEQC 基础物种未暴露原生模型参数；不能将其伪造为零 Gibbs 能模型。`phreeqc.dat` 的 Native YAML 导出因此不可用（依赖这些基础物种的记录也必须排除）。SUPCRT 原生导出和重新加载已测试通过。真实依赖环也可能阻止整库复制。
- Interpolation 仅对能真实计算的记录采样，并在每个网格单元的中点由正式 Reaktoro 重新加载后检验。误差指标是各 SI 属性的 `abs(interpolated-source)/max(1,abs(source))`；这是有限采样检查，不是连续温压域的严格全局误差保证。不应在导出范围之外使用。
- 从零创建目前开放三种已有完整参数定义和数值回归的模型：Modified Ryzhenko–Bryzgalin、Extended Maier–Kelley、Akinfiev–Diamond。water/OH、gas-reference 和未知模型仅可随已有来源记录保留，不能从界面伪造。
- 通用读取器支持显式的 `converted-standard-state/v1` 数据记录，包括分段热容、MRB、AD、water/OH 和气相参考。它不执行数据库中的 Python，不自动把任意第三方文件夹转换为此格式。来源系数、反应及身份在通用编辑器中保护，名称、有效范围、文献、活度参数和备注可编辑；未知模型仍不能计算。
- Reaktoro 2.13.0 的便捷 `EquilibriumSolver(system)` 路径可在含 Python 标准态回调的进程退出时触发缓存析构错误。Python 示例使用显式 `EquilibriumSpecs`，已测试重复读取、求解和正常退出；不修改或替换 Reaktoro。
- 已通过 [GitHub Release](https://github.com/haotian26/EasyReaktoro/releases/tag/v0.17.1) 发布 Apple Silicon macOS DMG 安装包。应用采用 ad-hoc 签名，尚未经过 Apple 公证；系统可能要求用户确认来源。安装包不包含 Python 或 Reaktoro。

- 模型数值回归不等于对任意物种、任意温压的科学验证。MRB/AD 仍需用户核对参数来源、适用范围与形成反应。Extended Debye–Hückel 使用数据库明确保存的 aᵢ，缺少参数时阻止计算；是否采用数据库默认尺寸及有理由但无文献的已记录尺寸，由活度模型页的选项控制；新模拟默认允许这两类记录。
- 新复制的原生物种保存来源索引与参数 fingerprint；来源模型或 Reaktoro 版本改变时拒绝静默代用。旧文件若存在无法区分的同名原生记录，需要从当前运行时重新创建副本。
- 文件夹导入仅识别已有的转换记录/YAML，不执行 Python；多个候选主文件不明确时拒绝导入。不支持原始 HCh/Unitherm 转换或所有第三方文件夹布局。
- 数据库保存时可保留历史版本；尚未实现崩溃后的未保存草稿恢复或多人并发编辑。普通关闭和 Command-Q 有未保存保护。模拟结果另采用逐点持久记录，重新打开可恢复完整保存的点。

详细检查范围和未验证项见 [测试报告](docs/TEST_REPORT.md)。
