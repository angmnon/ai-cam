#!/bin/bash
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq --no-install-recommends libocct-modeling-algorithms-dev binutils >/dev/null 2>&1
for f in /usr/lib/x86_64-linux-gnu/libTK*.so; do
  hits=$(nm -D "$f" 2>/dev/null | grep -i 'BRepMesh_IncrementalMeshC' | head -5)
  if [ -n "$hits" ]; then
    echo "== $f"
    echo "$hits"
  fi
done
