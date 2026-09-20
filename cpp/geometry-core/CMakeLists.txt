cmake_minimum_required(VERSION 3.16)
project(geometry_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Ubuntu 22.04: apt install libocct-data-exchange-dev libocct-modeling-algorithms-dev libocct-foundation-dev
find_package(OpenCASCADE REQUIRED)

add_executable(geometry_worker src/main.cpp)
target_link_libraries(geometry_worker PRIVATE
  OpenCASCADE::TKernel
  OpenCASCADE::TKMath
  OpenCASCADE::TKTopAlgo
  OpenCASCADE::TKBO
  OpenCASCADE::TKBRep
  OpenCASCADE::TKIGES
  OpenCASCADE::TKSTEP
  OpenCASCADE::TKXSBase
)
