# geometry-worker 镜像
# 使用 Ubuntu 22.04 系统 OCCT 包（7.6.x），避免从源码编译 OCCT（>1h）
FROM ubuntu:22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake \
      libocct-foundation-dev \
      libocct-modeling-algorithms-dev \
      libocct-data-exchange-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY cpp/geometry-core ./cpp/geometry-core
RUN cmake -S cpp/geometry-core -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j"$(nproc)"

WORKDIR /work
ENTRYPOINT ["/src/build/geometry_worker"]
