# 对象存储规范（13_文件与对象存储规范）

## Key 规则

```
/{org_id}/{resource_type}/{resource_id}/{version}/{file}
```

示例：

```
org_1/cad_source/part_123/rev_a/part.step
org_1/view_mesh/part_123/rev_a/part.glb
org_1/nc_program/job_456/rel_2/program.nc
```

- `resource_type` 小写（枚举见下）；`version` 为内容版本（rev_a / v0 / rel_2）
- 文件名不包含路径分隔符；上传前由服务端校验

## ResourceType 枚举

| 类型 | 说明 |
|---|---|
| cad_source | 原始 STEP/STP/IGES/STL |
| cad_parsed | 服务端解析后的规范化几何（JSON/OCAF） |
| view_mesh | 前端 Viewer 用网格（GLB/LOD） |
| simulation_mesh | 仿真用体素/网格 |
| toolpath | 确定性刀路 artifact |
| fixture_cad | 夹具/软爪 STEP |
| nc_program | 最终 NC/G-code |
| setup_sheet | 装夹单（PDF） |
| process_report | 工艺报告（PDF/JSON） |
| simulation_report | 仿真报告 |

## 上传流程（预签名直传）

1. `POST /api/v1/files/upload-sessions` → 返回 `{file_id, upload_url, method, headers, expires_at}`
2. 客户端直传（local 适配器 → API 上传端点；R2 适配器 → 预签名 PUT URL）
3. 服务端记录 `sha256` + 元数据入 `files` 表
4. 下载走短期 signed URL 并写审计日志

## 生命周期

- 临时文件（会话未完成）：7 天清理
- 正式文件：按企业保留策略（默认 3 年）
- 下载与删除均写 `audit_logs`

## 安全

- Key 由服务端生成，禁止客户端指定路径穿越（`../` 拒绝）
- 所有对象记录 SHA-256，下载时校验
- 多租户隔离：对象归属 `org_id`，访问必须校验
