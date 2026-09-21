# tools/ — 跨平台辅助脚本

| 脚本 | 平台 | 用途 |
|---|---|---|
| `find_sym.sh` | Linux（WSL/容器） | 在 OCCT 共享库 `libTK*.so` 中用 `nm -D` 查找符号（如 `BRepMesh_IncrementalMeshC`） |
| `find_sym.ps1` | Windows PowerShell | `find_sym.sh` 的 Windows 等价物：在 OCCT `TK*.dll` 中用 `dumpbin /exports` 查找同一符号 |

两脚本查找同一组 OCCT 符号，按宿主系统二选一运行：

```bash
# Linux
bash tools/find_sym.sh
```

```powershell
# Windows（需在 Developer PowerShell 中，或 dumpbin 在 PATH）
powershell -File tools/find_sym.ps1
# 指定 OCCT 目录：powershell -File tools/find_sym.ps1 -SearchRoot C:\OCCT\bin
```
