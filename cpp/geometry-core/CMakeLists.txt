cmake_minimum_required(VERSION 3.16)
project(geometry_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Ubuntu 22.04: apt install libocct-foundation-dev libocct-modeling-algorithms-dev libocct-data-exchange-dev
# Ubuntu 的 OCCT dev 包不提供 CMake config（无 opencascade-config.cmake），故手动查找库。
set(OCCT_INCLUDE_DIR /usr/include/opencascade)
set(OCCT_LIB_NAMES
  TKernel TKMath TKG3d TKG2d TKGeomBase TKGeomAlgo TKTopAlgo TKPrim TKBO TKShHealing TKBRep TKMesh TKIGES TKSTEP TKXSBase
)

set(OCCT_LIBS "")
foreach(lib ${OCCT_LIB_NAMES})
  find_library(OCCT_${lib} NAMES ${lib} PATHS /usr/lib/x86_64-linux-gnu /usr/lib)
  if(NOT OCCT_${lib})
    message(FATAL_ERROR "OCCT library ${lib} not found (install libocct-*-dev)")
  endif()
  list(APPEND OCCT_LIBS ${OCCT_${lib}})
endforeach()

add_executable(geometry_worker src/main.cpp)
target_include_directories(geometry_worker PRIVATE ${OCCT_INCLUDE_DIR})
target_link_libraries(geometry_worker PRIVATE ${OCCT_LIBS})

add_executable(step_generator src/step_generator.cpp)
target_include_directories(step_generator PRIVATE ${OCCT_INCLUDE_DIR})
target_link_libraries(step_generator PRIVATE ${OCCT_LIBS})
