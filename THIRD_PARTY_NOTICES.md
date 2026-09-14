# 第三方代码与标识

根目录 [MIT LICENSE](LICENSE) 适用于本项目原创代码，不替代第三方组件自身的许可，也不授予第三方名称、商标或标识的权利。

## 随源码提供的 rfd

- 上游：[PolyMeilex/rfd](https://github.com/PolyMeilex/rfd)
- 版本：0.16.0
- 版权：Copyright (c) 2022 Bartłomiej Maryńczak
- 许可证：MIT，完整原文随源码保留于 [src-tauri/vendor/rfd/LICENSE](src-tauri/vendor/rfd/LICENSE)。
- 本项目修改：macOS 保存面板调用 `setShowsTagField(false)`，隐藏与数据库保存无关的 Finder Tags。通过 Cargo patch 使用这份源码。

## 数学公式排版

KaTeX 0.18.7 由 npm 锁文件固定，采用 MIT 许可，Copyright (c) 2013-2020 Khan Academy and other contributors。完整许可保留于 [third_party/KaTeX-LICENSE.txt](third_party/KaTeX-LICENSE.txt)，并随应用资源打包。公式和字体本地加载。

## Python 参数编辑器

CodeMirror 6、Lezer 及其编辑器辅助包采用 MIT 许可，实际版本由 npm 锁文件固定。完整上游通知保留于 [third_party/CodeMirror-LICENSES.txt](third_party/CodeMirror-LICENSES.txt)，并随应用打包。编辑器与 Python 语法支持均本地加载。

## 构建依赖

React、Tauri、Lucide、SQLite/rusqlite 及其他依赖由 npm/Cargo 按锁文件获取，不作为完整依赖源码复制进本仓库；各组件保留其上游许可证。实际版本见 `package-lock.json` 和 `src-tauri/Cargo.lock`。自行再分发构建产物时，应同时遵守构建时所含依赖的通知和许可要求。

## Reaktoro 与数据库

EasyReaktoro 是非官方、独立开发的 GUI，并非 Reaktoro 官方项目，也不表示获得上游背书。本项目不打包 Reaktoro、Python、PHREEQC/SUPCRT/NASA 数据库或个人数据库；用户自行提供外部运行时与有权使用的数据。相关代码、数据及文献仍受各自权利与许可约束。

## 图标与品牌

应用图标采用工作台展示 Reaktoro 符号的组合设计。工作台视觉与 Reaktoro 符号并不意味着本项目拥有上游符号的权利；Reaktoro 名称和符号的权利仍属于其各自权利人。本项目的 MIT 代码许可证不覆盖第三方标识，也不构成商标使用许可。分发者应自行确认其品牌使用范围，不能宣称官方身份或背书。
