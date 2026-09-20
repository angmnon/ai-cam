# geometry_worker（OCCT 解析 POC）

Phase 0 目标：验证 `STEP → Solid/BBox/体积` 链路。输入输出均为 JSON，供 geometry-service 调用。

## 本地构建（Ubuntu 22.04 + OCCT 系统包）

```bash
sudo apt-get update && sudo apt-get install -y build-essential cmake \
  libocct-foundation-dev libocct-modeling-algorithms-dev libocct-data-exchange-dev
cmake -S cpp/geometry-core -B build/geometry-core
cmake --build build/geometry-core -j
./build/geometry-core/geometry_worker path/to/part.step
```

## Docker 构建（推荐，环境隔离）

```bash
docker build -f infra/docker/geometry-worker/Dockerfile -t ai-cam/geometry-worker .
# 挂载样例目录运行
docker run --rm -v "C:\path\to\steps:/data" ai-cam/geometry-worker /data/part.step
```

## 输出示例

```json
{"status":"ok","file":"/data/part.step","occt_version":"7.6.3","solid_count":1,
 "bbox_mm":{"min":[0,0,0],"max":[80,16,50]},"volume_mm3":64000.0}
```

## M0 验收

- 10+ 个不同样例 STEP 解析成功（status=ok，solid_count ≥ 1）
- BBox 与主流 CAD 系统对比误差 < 0.01mm
- 非法/损坏 STEP 返回 `{"status":"error","message":...}`（不崩溃、不静默成功）

## 备注

- 临时文件写 `/tmp`；容器内单文件读入采用“文件路径参数”模式，服务化后由 geometry-service 管理输入对象（R2 key）。
- 后续阶段在 geometry-core 上继续实现：healing、拓扑校验、tessellation（GLB/VIEW_MESH）。
