# EasyReaktoro

EasyReaktoro 是面向 Reaktoro 的非官方 macOS 图形界面。v0.2.0 首先完成数据库发现、浏览、组建、编辑、验证与导出闭环；Simulation 仍为明确的计划中功能。

应用依赖用户自行安装的外部 Reaktoro Python 环境，不打包 Python、Reaktoro、官方数据库或个人数据库。

源码仓库：[haotian26/EasyReaktoro](https://github.com/haotian26/EasyReaktoro)。项目代码采用 [MIT 许可证](LICENSE)；第三方代码和品牌标识的边界见 [第三方说明](THIRD_PARTY_NOTICES.md)。当前仅公开源码，不提供 GitHub Release 或安装包下载。

## 运行

支持 Apple Silicon macOS 13 及以上；尚未在第二台电脑上验收。Git 仓库不包含 `.app`，克隆后请先按下文构建。已有本地交付包的用户可在 Finder 双击 `release/EasyReaktoro.app`，或运行：

```bash
open release/EasyReaktoro.app
```

首次启动时，应用会自动探测可用的 Reaktoro 环境。也可以选择具体的 Reaktoro Python，或选择 Conda/Reaktoro 环境目录。存在多个环境时可在“设置 → Reaktoro 环境”中切换、测试连接并查看诊断。

自动探测不是固定路径：应用会检查环境变量、`/Applications` 下的应用环境、常见 Homebrew/Conda/Mamba 安装位置、用户级 Conda/Micromamba/Pyenv 环境以及系统 Python，并只显示能够真实导入 Reaktoro 的候选项。候选项按 Python 规范路径、环境根目录和 Reaktoro 版本去重。

## 基本使用

1. 在首页确认 Reaktoro 已连接；未连接时仍可离线打开和编辑 `.rtdb`，但电脑上需要可用的外部 Python 3。离线不代表应用自带 Python。
2. 进入“数据库”查看“我的数据库”和由外部 Reaktoro 提供的 PHREEQC、SUPCRT、NASA 数据库。
3. 内置数据库为只读。可选择物种创建可编辑 `.rtdb`，或尝试复制整个数据库；依赖缺失或循环会阻止提交。
4. 可编辑数据库的工具栏直接提供“新建物种”。创建时先从 118 元素周期表选择组成和数量，再指定电荷、相态及模型；系统生成的化学式可以继续修改并实时预览。模型参数、有效温压范围、形成反应和扩展 Debye–Hückel 离子尺寸均使用图形化字段，不输入 JSON。
5. MRB 既可直接填写三个参数，也可输入至少三组温度、压力与 \(pK\) 或 \(\log K\) 数据进行真实最小二乘拟合。形成反应通过可搜索的已有物种选择器输入，并实时显示排版后的反应式。
6. 参考文献可以直接整段粘贴；作者、年份、题目、期刊和 DOI 等结构化字段仅在需要时展开填写。
7. 数据库显示名称采用 `.rtdb` 文件名；从内置数据库创建时在系统保存面板中直接命名文件。
8. 可编辑数据库还支持从 YAML、其他 `.rtdb` 或安全的已转换数据文件夹导入、验证、保存及另存为。
9. Native YAML 只导出 Reaktoro 原生可表达的记录，并在写入前由当前 Reaktoro 正式重新加载验证。Interpolation YAML 会按指定温压网格采样并进行独立误差检查。

使用提示：`⌘S` 保存当前数据库，`⌘F` 聚焦物种搜索。物种表单顶部可跳转章节，底部固定显示保存操作；保存物种后会定位到该记录。周期表支持元素符号、中英文检索，单个精确匹配可按 Enter 选择；筛选只有点击“应用筛选”才生效，取消不改变当前筛选。重要错误会保留到手动关闭。

同名且来源无法确定的形成反应不会自动绑定任意记录，会显示具体引用链和候选来源。导出仅接受 `.yaml` / `.yml`，并检查符号链接的实际目标，防止覆盖 `.rtdb`。自定义模型详情中的参数名称和单位来自统一模型定义，不从数值猜测。

关闭 dirty 数据库时必须选择保存、放弃或取消；保存失败不会关闭数据库。

“保存物种”和 MRB“拟合完成”先更新当前数据库/表单；仍需点击数据库“保存”才写入 `.rtdb` 文件。拟合结果会说明当前写入状态，保存失败时保留修改。

若文件被其他程序修改、删除或正在由其他 SQLite 程序写入，保存会拒绝覆盖，可选择“操作 → 另存为”保存到新文件。创建和另存为也不覆盖已有文件，请使用新文件名。旧 v1 数据库只在内存副本中迁移，明确保存后才升级原文件。

## 开发与测试

构建需要 Node.js 20+、npm、Rust 稳定工具链及 Xcode Command Line Tools。运行还需要独立安装的 Python；完整功能需要该 Python 能够导入 Reaktoro。本版数值与目录回归的基线为 Reaktoro 2.13.0 / Python 3.12。

```bash
git clone https://github.com/haotian26/EasyReaktoro.git
cd EasyReaktoro
npm ci
npm test -- --run
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
CARGO_PROFILE_RELEASE_STRIP=none npx tauri build --bundles app
```

默认构建产物为 `src-tauri/target/release/bundle/macos/EasyReaktoro.app`；可用 `open src-tauri/target/release/bundle/macos/EasyReaktoro.app` 启动。`release/` 是本地交付目录，不由上述构建命令自动填充，也不进入 Git。图标资源与原生保存面板补丁均随源码提供；构建不下载或打包 Reaktoro 数据库。

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

## v0.2.0 已知限制

- Simulation 不执行计算，仅显示计划中状态。
- 界面本轮统一为中文；i18n 接口保留，英文资源尚未精确翻译。
- 当前 Reaktoro 2.13.0 的部分 PHREEQC 基础物种未暴露原生模型参数；不能将其伪造为零 Gibbs 能模型。`phreeqc.dat` 的 Native YAML 导出因此不可用（依赖这些基础物种的记录也必须排除）。SUPCRT 原生导出和重新加载已测试通过。真实依赖环也可能阻止整库复制。
- Interpolation 仅对能真实计算的记录采样，并在每个网格单元的中点由正式 Reaktoro 重新加载后检验。误差指标是各 SI 属性的 `abs(interpolated-source)/max(1,abs(source))`；这是有限采样检查，不是连续温压域的严格全局误差保证。不应在导出范围之外使用。
- 从零创建目前开放三种已有完整参数定义和数值回归的模型：Modified Ryzhenko–Bryzgalin、Extended Maier–Kelley、Akinfiev–Diamond。water/OH、gas-reference 和未知模型仅可随已有来源记录保留，不能从界面伪造。
- 本地应用为 ad-hoc 签名的 Apple Silicon 构建，未经过 Apple 公证。系统可能要求用户确认来源；项目没有提供公证安装包，也没有发布 GitHub Release 或 DMG。

- 模型数值回归不等于对任意物种、任意温压的科学验证。MRB/AD 仍需用户核对参数来源、适用范围与形成反应。离子尺寸 aᵢ 只保存为相应活度模型的经验参数，本版不执行活度或平衡模拟。
- 新复制的原生物种保存来源索引与参数 fingerprint；来源模型或 Reaktoro 版本改变时拒绝静默代用。旧文件若存在无法区分的同名原生记录，需要从当前运行时重新创建副本。
- 文件夹导入仅识别已有的转换记录/YAML，不执行 Python；多个候选主文件不明确时拒绝导入。不支持原始 HCh/Unitherm 转换或所有第三方文件夹布局。
- 未实现自动恢复、轮换备份或多人并发编辑。普通关闭和 Command-Q 有未保存保护；强制退出、崩溃和断电仍可能丢失未保存内容。

详细检查范围和未验证项见 [测试报告](docs/TEST_REPORT.md)。
