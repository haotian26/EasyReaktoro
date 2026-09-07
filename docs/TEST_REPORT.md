# EasyReaktoro v0.2.0 检查与测试报告

日期：2026-09-07。平台：本机 Apple Silicon macOS。外部运行时：Reaktoro 2.13.0 / Python 3.12。所有写入测试使用独立临时数据库，未编辑用户数据库；测试修改的应用设置在结束后还原。

## 修复清单

| 范围 | 修复与检查 |
| --- | --- |
| 未保存保护 | 返回目录不遗失 dirty workspace；保存失败不关闭；保存成功不重复弹旧提示；窗口关闭、Command-Q 统一确认。 |
| 持久化 | 创建/另存为不覆盖；v1 在内存副本迁移；保留 audit/validation；外部文件变化、删除和活动 WAL/journal 阻止覆盖。 |
| 导入与组建 | 实际依赖闭包、全部种子仍检查环、同来源优先；稳定后缀；重命名联动反应；空选择不全量导入；源变化后重新预览；多来源独立 ID。 |
| 编辑 | 重名、组成/相态/范围/离子尺寸、反应守恒及引用草稿检查先于修改；被引用物种不可删除；原生模型限制热力学身份修改。 |
| 数值 | EMK 正确使用 G298，AD 气相参考同步；Gibbs 有限差分计算真实 VT0；拒绝 NaN/Inf 与非法温压。 |
| 物种身份 | 原生物种按唯一 ID，避免同名详情/计算串用；来源索引、版本、参数 fingerprint 核对；不保存 Python repr/内存地址。 |
| 导出 | 移除缺模型补零；级联排除依赖；正式 reload；用户插值网格、容量限制和独立中点误差检查。 |
| 桥接/设置 | 持续读取 stderr 防堵塞；ID 核对、请求超时和子进程错误；切环境 dirty guard；不同 venv 不因同源 Python 符号链接合并；设置写入串行化。 |
| 界面 | 最近文件直接打开；精简重复首页入口；对话框忙碌/失败反馈与取消确认；迟到详情/计算不串用；服务端分页过滤；拖动分栏和独立滚动；统一表单尺寸、Unicode 公式和原生参数结构化显示。 |

注意：G298 修复会改变此前受到该错误影响的 EMK/AD 计算值，应重新计算这些旧结果；没有修改用户保存的参数或数据库。

## 自动测试

### 前端

```bash
npm ci
npm test -- --run
```

2 个文件，30 项通过：真实 DOM 点击、最近文件路径、dirty 导航/关闭、保存失败、默认文件检查、迟到详情、非法温压、创建/导入错误、导出网格、全部 118 元素切换、安全公式排版及原生参数列表渲染。新增用例包括 false-save、连续保存、退出互斥、迟到刷新、设置异常启动、活动参数保留、取消筛选、元素搜索/章节导航、快捷键、导入 dirty 同步和参数单位。此覆盖不等于所有按钮与所有组合都已穷举。

### Bridge 与科学计算

```bash
/Applications/Reaktoro/envs/reaktoro/bin/python -B -m unittest discover -s tests -v
```

45 项通过。当前目录 19 个真实可加载数据库；数量基线：phreeqc.dat=381、llnl.dat=2612、supcrtbl=1108、nasa-cea=1658，仅写入测试，不写死 UI。

覆盖分页/搜索/元素过滤、CRUD/保存/重开/迁移、缺失/循环依赖、冲突与来源变化、安全导入、原生 reload、插值 reload/误差、MRB 多温压拟合及 MRB/EMK/AD 数值回归。EMK 的 G/H/Cp/V 另与正式 StandardThermoModelMaierKelley 在三个温压点交叉核对。

```bash
/usr/bin/python3 -B -m unittest discover -s tests -p test_quality.py -v
```

26 项：22 通过，4 项需要 Reaktoro 的检查跳过。检查无 Reaktoro 时本地编辑保存和纯 EMK 计算；并不代表没有 Python 也能运行 Bridge。

### Rust 与构建

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
CARGO_PROFILE_RELEASE_STRIP=none npx tauri build --bundles app
```

Rust 3 项通过：venv 去重、stderr/响应协议、死进程不挂起。TypeScript、Vite production 与 arm64 bundle 构建通过。实际使用独立临时 CARGO_TARGET_DIR；STRIP=none 规避当前工具链的 proc-macro strip 问题。vendored rfd 有 43 条弃用/冗余 unsafe 警告，非构建错误。

## 对抗式回归

以失败输入、重复操作、乱序返回和危险输出路径主动攻击现有流程。先复现的 7 项失败用例：false-save 仍关闭、取消筛选已生效、修改备注影响其他活度模型、旧刷新重开工作区、1,200 层引用栈溢出、歧义依赖被任意绑定，以及 YAML 导出覆盖临时 `.rtdb`。修复后全部通过；追加符号链接、重复插值名称及模型参数定义测试。

本轮共新增 18 项回归（前端 12、Python 6）。所有写入均为临时合成数据。真实 SQLite 检查确认：仅编辑备注后，4.5 Å 离子尺寸、适用模型与活动参数附注完整保留。

## macOS 实际检查

- 候选与正式 app 实际启动，tauri://localhost 显示正常，无白屏。
- 选择 Python、选择环境文件夹、保存位置面板实际打开/取消；实际创建 .rtdb，无 Finder Tags。
- 重新检测显示进度，完成后列出本机 1 个经验证环境；连接诊断正常。多环境去重另有 Rust 测试，未在第二台电脑实测。
- 本地数据库重开、编辑、Command-Q 取消/放弃/保存并关闭；保存关闭后 SQLite 中确实有新名称。
- 检查首页、设置、目录、搜索/详情/温压结果、物种表单、浅色/深色。跟随系统使用本机系统状态检查，未自动改变系统主题。
- Dock/系统 terminate 委托已接入保护；UI 自动化无法取得 Dock，Dock 菜单和系统注销尚未独立现场验证。强制退出不能拦截。
- 使用临时构建配置实际启动 1040×680 窗口，检查首页、本地库分栏和新建物种表单；修正周期表导致外层横向溢出。最终构建恢复 1380×900 默认尺寸。
- 本轮实际检查明/暗主题、中文路径原生打开面板、章节跳转、固定保存区、备注修改、自动定位和 Command-S；周期表取消及所有 118 按钮由组件测试覆盖。
- 全部长名称、所有辅助功能路径、第二台电脑和全量物种科学正确性尚未穷举验收。

## 交付

release/EasyReaktoro.app：0.2.0、arm64、约 13.6 MiB，低于 50 MB。CFBundleIconFile=icon.icns；保留确认的暖亮图标和透明外角。

包内只有应用二进制、图标、plist/签名和 7 个轻量 Bridge Python 源文件；无 Python 解释器、Reaktoro、官方或个人数据库。资源与源码一致；ad-hoc 深度签名验证通过。

正式 `release/EasyReaktoro.app` 已从本地交付位置启动，真实目录显示 PHREEQC 14 / SUPCRT 4 / NASA 1，正常窗口尺寸和 custom-protocol 页面均正常。写入检查使用隔离的临时数据；用户数据库不作为测试样本或源码附件。

公开仓库仅提供源码和版本标签，不包含应用、数据库或临时验证输出；未发布 GitHub Release、DMG 或更新服务。准确能力边界见 README：PHREEQC 原生参数缺失、插值只进行有限采样检查、自动恢复未实现、模型适用范围需用户验证。
