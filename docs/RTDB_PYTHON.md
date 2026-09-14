# 在 Python / notebook 中使用 RTDB

`.rtdb` 是 EasyReaktoro 的 SQLite 数据容器。它保存物种及计算所需的结构化数据，不保存或执行 Python 脚本。读取器将参数交给已安装的通用方程和外部 Reaktoro，返回普通 `reaktoro.Database`。

## 环境与加载

使用装有 Reaktoro 的 Python/kernel。本版审核基线是 Python 3.12 + Reaktoro 2.13.0；数据库声明了审核版本时，版本不匹配会明确拒绝计算，不静默替换。源码目录中的 `bridge`，或者本地 app 内 `Contents/Resources/bridge`，均可作为模块路径。

```python
import sys
from pathlib import Path

reader = Path("/path/to/EasyReaktoro/bridge")
# 也可使用 Path("/path/to/EasyReaktoro.app/Contents/Resources/bridge")
sys.path.insert(0, str(reader))

from easyreaktoro_runtime import load_database, ion_size_parameters

rtdb_path = Path("/path/to/database.rtdb")
db = load_database(rtdb_path)
print(len(db.species()), len(db.elements()))

species = db.species()[0]  # 实际使用时按确切名称选择
props = species.standardThermoProps(298.15, 100000.0)  # K、Pa
print(float(props.G0))  # J/mol
```

不要使用 `Reaktoro.Database.fromFile("database.rtdb")`。Reaktoro 本身不识别此 SQLite 格式。完整转换记录不需要原始源文件夹；缺少可重建的原生参数、模型版本未知、依赖不完整或有循环时，读取器拒绝构建，而不是返回残缺的“成功”数据库。disabled drafts 不进入计算数据库。

修改并保存 `.rtdb` 后，已有的 `db`/`ChemicalSystem` 不自动变化。重新 `load_database()`，并重建依赖它的 phase/system/solver。不要同时在多个程序中写同一文件。

## 活度与离子尺寸

```python
from easyreaktoro_runtime import activity_parameters, resolve_ion_size_parameter

sizes = ion_size_parameters(rtdb_path)  # 单次读取；以确切物种名为键
for species_name, parameter in sizes.items():
    print(species_name, parameter["ion_size_angstrom"], parameter.get("source", ""))

# 指定名字时：
# parameter = activity_parameters(rtdb_path, species_name)
# resolved = resolve_ion_size_parameter(rtdb_path, species_name)
# resolved["a_angstrom"] 是 Å；没有记录该参数时返回 None。
```

这些 API 返回**当前记录中的有效赋值**，包括 GUI 修改后的值，不使用归档的旧表覆盖新值，不为新物种猜测离子尺寸。`is_default` 和 `reason` 说明某个保存值是否来自源库明确的默认规则，不代表普适化学结论。

读取数据库不会自动启用 Extended Debye–Hückel、HKF、PRSV 等活度/逸度模型。继续由具体建模脚本明确选择模型，并将相应的逐物种参数传给该模型。离子尺寸是经验模型参数，不是物理半径；标准态热力学与活度模型必须分开。

## 求解器生命周期

数据库可用于普通 `ChemicalSystem`。在 Reaktoro 2.13.0 中，对包含 Python 标准态回调的数据库，使用显式条件规格创建求解器：

```python
import reaktoro as r

# phase 和 system 按自己的化学体系与活度模型建立：
# system = r.ChemicalSystem(db, phase)

specs = r.EquilibriumSpecs(system)
specs.temperature()
specs.pressure()
solver = r.EquilibriumSolver(specs)
# result = solver.solve(state)
```

本机复现到 `EquilibriumSolver(system)` 的线程本地规格缓存可能在 Python 结束后才释放回调，导致退出异常；显式 `EquilibriumSpecs` 路径的独立进程重复计算/退出回归已通过。不要用强制 `os._exit()` 掩盖异常；已有更复杂的规格可继续原样使用。

## 可计算不等于扩大适用范围

- 转换方程沿用数据声明的参考态、热容分段与导数约定，不把缺失导数重新解释成新的科学验证。
- 保存有效温压范围不会扩展模型的物理适用范围；源文件未声明的范围不猜测。
- 完整模型可由 RTDB 读取器计算，不意味着都能直接表达成原生 YAML。Native 导出必须查看排除报告；插值是另一个具有指定网格和误差检查的产物，不可代替原数据存档。
- 当前界面保护来源模型的复杂系数和反应，避免在不完整的参数表单中破坏原模型；备注、参考文献、活度参数等仍可维护。若需修改复杂来源方程，须通过对应完整数据适配器并重新做数值审核。
- 仓库和 app 不包含任何个人数据库。分享一个 `.rtdb` 前应自行审核其中的私人记录、路径、参考资料与源档案。
