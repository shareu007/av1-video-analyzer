cmake_minimum_required(VERSION 3.20)
project(av1scope_native_adapters VERSION 0.1.0 LANGUAGES C)

set(
  AV1SCOPE_INSPECTION_ADAPTER_LIBRARY ""
  CACHE FILEPATH "Fixed-build libaom inspection adapter library"
)
set(
  AV1SCOPE_LIBAOM_PATCH_LIBRARY ""
  CACHE FILEPATH "Pinned instrumented libaom patch library implementing av1scope_libaom_patch v1"
)
set(
  AV1SCOPE_LIBAOM_BUILD_ID ""
  CACHE STRING "Stable <=40-byte ID for the pinned instrumented libaom build manifest"
)
set(
  AV1SCOPE_LIBAOM_SOURCE_DIR ""
  CACHE PATH "Pinned libaom source tree used by the built-in inspection producer"
)
set(
  AV1SCOPE_LIBAOM_BUILD_DIR ""
  CACHE PATH "Pinned libaom build tree containing config/aom_config.h"
)
set(
  AV1SCOPE_LIBAOM_LIBRARY ""
  CACHE FILEPATH "Pinned CONFIG_INSPECTION=1 libaom library"
)

include(GNUInstallDirs)
find_package(PkgConfig REQUIRED)
pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET libavformat libavcodec libavutil)

add_library(av1scope_ffmpeg_demux SHARED ffmpeg_demux_adapter.c)
target_compile_features(av1scope_ffmpeg_demux PRIVATE c_std_11)
target_compile_definitions(av1scope_ffmpeg_demux PRIVATE AV1SCOPE_ADAPTER_BUILD=1)
target_include_directories(
  av1scope_ffmpeg_demux
  PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
)
target_link_libraries(av1scope_ffmpeg_demux PRIVATE PkgConfig::FFMPEG)
if(UNIX AND NOT APPLE AND CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_link_options(av1scope_ffmpeg_demux PRIVATE "-Wl,--build-id=none")
endif()
set_target_properties(
  av1scope_ffmpeg_demux
  PROPERTIES
    C_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN YES
)
if(APPLE)
  set_target_properties(av1scope_ffmpeg_demux PROPERTIES INSTALL_RPATH "@loader_path")
elseif(UNIX)
  set_target_properties(av1scope_ffmpeg_demux PROPERTIES INSTALL_RPATH "$ORIGIN")
endif()

if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(
    av1scope_ffmpeg_demux
    PRIVATE -pedantic -Wall -Wextra -Werror
  )
elseif(MSVC)
  target_compile_options(av1scope_ffmpeg_demux PRIVATE /W4 /WX)
endif()

add_executable(av1scope_ffmpeg_demux_smoke test/ffmpeg-demux-smoke.c)
target_compile_features(av1scope_ffmpeg_demux_smoke PRIVATE c_std_11)
target_include_directories(av1scope_ffmpeg_demux_smoke PRIVATE include)
target_link_libraries(av1scope_ffmpeg_demux_smoke PRIVATE av1scope_ffmpeg_demux)

add_executable(
  av1scope_ffmpeg_demux_worker
  ffmpeg_demux_worker.c
  worker_limits.c
  worker_sandbox.c
)
target_compile_features(av1scope_ffmpeg_demux_worker PRIVATE c_std_11)
target_include_directories(av1scope_ffmpeg_demux_worker PRIVATE include)
target_link_libraries(av1scope_ffmpeg_demux_worker PRIVATE av1scope_ffmpeg_demux)
if(UNIX AND NOT APPLE AND CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_link_options(av1scope_ffmpeg_demux_worker PRIVATE "-Wl,--build-id=none")
endif()
if(APPLE)
  set_target_properties(
    av1scope_ffmpeg_demux_worker
    PROPERTIES INSTALL_RPATH "@loader_path/../${CMAKE_INSTALL_LIBDIR}"
  )
elseif(UNIX)
  set_target_properties(
    av1scope_ffmpeg_demux_worker
    PROPERTIES INSTALL_RPATH "$ORIGIN/../${CMAKE_INSTALL_LIBDIR}"
  )
endif()

if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(
    av1scope_ffmpeg_demux_worker
    PRIVATE -pedantic -Wall -Wextra -Werror
  )
elseif(MSVC)
  target_compile_options(av1scope_ffmpeg_demux_worker PRIVATE /W4 /WX)
endif()

set(AV1SCOPE_LIBAOM_BUILTIN_VALUES
  "${AV1SCOPE_LIBAOM_SOURCE_DIR}"
  "${AV1SCOPE_LIBAOM_BUILD_DIR}"
  "${AV1SCOPE_LIBAOM_LIBRARY}"
)
set(AV1SCOPE_LIBAOM_BUILTIN_VALUE_COUNT 0)
foreach(AV1SCOPE_LIBAOM_BUILTIN_VALUE IN LISTS AV1SCOPE_LIBAOM_BUILTIN_VALUES)
  if(AV1SCOPE_LIBAOM_BUILTIN_VALUE)
    math(EXPR AV1SCOPE_LIBAOM_BUILTIN_VALUE_COUNT "${AV1SCOPE_LIBAOM_BUILTIN_VALUE_COUNT} + 1")
  endif()
endforeach()
if(AV1SCOPE_LIBAOM_BUILTIN_VALUE_COUNT GREATER 0
    AND NOT AV1SCOPE_LIBAOM_BUILTIN_VALUE_COUNT EQUAL 3)
  message(FATAL_ERROR
    "AV1SCOPE_LIBAOM_SOURCE_DIR, AV1SCOPE_LIBAOM_BUILD_DIR and AV1SCOPE_LIBAOM_LIBRARY are an atomic configuration"
  )
endif()
if(AV1SCOPE_INSPECTION_ADAPTER_LIBRARY
    AND (AV1SCOPE_LIBAOM_PATCH_LIBRARY OR AV1SCOPE_LIBAOM_BUILTIN_VALUE_COUNT EQUAL 3))
  message(FATAL_ERROR "Select either a prebuilt inspection adapter or one libaom producer")
endif()
if(AV1SCOPE_LIBAOM_PATCH_LIBRARY AND AV1SCOPE_LIBAOM_BUILTIN_VALUE_COUNT EQUAL 3)
  message(FATAL_ERROR "Select either a prebuilt patch library or the built-in libaom producer")
endif()

set(AV1SCOPE_EFFECTIVE_LIBAOM_PATCH "${AV1SCOPE_LIBAOM_PATCH_LIBRARY}")
if(AV1SCOPE_LIBAOM_BUILTIN_VALUE_COUNT EQUAL 3)
  foreach(AV1SCOPE_REQUIRED_LIBAOM_PATH
      "${AV1SCOPE_LIBAOM_SOURCE_DIR}/aom/aom_decoder.h"
      "${AV1SCOPE_LIBAOM_SOURCE_DIR}/av1/decoder/inspection.h"
      "${AV1SCOPE_LIBAOM_BUILD_DIR}/config/aom_config.h"
      "${AV1SCOPE_LIBAOM_LIBRARY}")
    if(NOT EXISTS "${AV1SCOPE_REQUIRED_LIBAOM_PATH}")
      message(FATAL_ERROR "Missing pinned libaom build input: ${AV1SCOPE_REQUIRED_LIBAOM_PATH}")
    endif()
  endforeach()
  add_library(av1scope_libaom_builtin_patch STATIC libaom_builtin_inspection_patch.c)
  target_compile_features(av1scope_libaom_builtin_patch PRIVATE c_std_11)
  target_include_directories(
    av1scope_libaom_builtin_patch
    PRIVATE
      include
      "${AV1SCOPE_LIBAOM_SOURCE_DIR}"
      "${AV1SCOPE_LIBAOM_BUILD_DIR}"
  )
  target_link_libraries(av1scope_libaom_builtin_patch PRIVATE "${AV1SCOPE_LIBAOM_LIBRARY}")
  set_target_properties(av1scope_libaom_builtin_patch PROPERTIES POSITION_INDEPENDENT_CODE ON)
  if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(
      av1scope_libaom_builtin_patch PRIVATE -pedantic -Wall -Wextra -Werror
    )
  elseif(MSVC)
    target_compile_options(av1scope_libaom_builtin_patch PRIVATE /W4 /WX)
  endif()
  set(AV1SCOPE_EFFECTIVE_LIBAOM_PATCH av1scope_libaom_builtin_patch)
endif()

set(AV1SCOPE_EFFECTIVE_INSPECTION_ADAPTER "${AV1SCOPE_INSPECTION_ADAPTER_LIBRARY}")
if(AV1SCOPE_EFFECTIVE_LIBAOM_PATCH)
  if(NOT AV1SCOPE_LIBAOM_BUILD_ID)
    message(FATAL_ERROR "AV1SCOPE_LIBAOM_BUILD_ID is required with a libaom producer")
  endif()
  add_library(av1scope_libaom_inspection SHARED libaom_inspection_adapter.c)
  target_compile_features(av1scope_libaom_inspection PRIVATE c_std_11)
  target_compile_definitions(
    av1scope_libaom_inspection
    PRIVATE
      AV1SCOPE_ADAPTER_BUILD=1
      AV1SCOPE_LIBAOM_BUILD_ID="${AV1SCOPE_LIBAOM_BUILD_ID}"
  )
  target_include_directories(
    av1scope_libaom_inspection
    PUBLIC
      $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
      $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
  )
  target_link_libraries(av1scope_libaom_inspection PRIVATE ${AV1SCOPE_EFFECTIVE_LIBAOM_PATCH})
  set_target_properties(
    av1scope_libaom_inspection
    PROPERTIES C_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES
  )
  if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(av1scope_libaom_inspection PRIVATE -pedantic -Wall -Wextra -Werror)
  elseif(MSVC)
    target_compile_options(av1scope_libaom_inspection PRIVATE /W4 /WX)
  endif()
  set(AV1SCOPE_EFFECTIVE_INSPECTION_ADAPTER av1scope_libaom_inspection)
  install(
    TARGETS av1scope_libaom_inspection
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
  )
endif()

add_executable(
  av1scope_libaom_builtin_inspection_smoke
  libaom_builtin_inspection_patch.c
  test/libaom-fixture/libaom-fixture.c
  test/libaom-builtin-inspection-smoke.c
)
target_compile_features(av1scope_libaom_builtin_inspection_smoke PRIVATE c_std_11)
target_include_directories(
  av1scope_libaom_builtin_inspection_smoke
  PRIVATE test/libaom-fixture include
)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(
    av1scope_libaom_builtin_inspection_smoke
    PRIVATE -UNDEBUG -pedantic -Wall -Wextra -Werror
  )
elseif(MSVC)
  target_compile_options(av1scope_libaom_builtin_inspection_smoke PRIVATE /UNDEBUG /W4 /WX)
endif()

if(AV1SCOPE_EFFECTIVE_INSPECTION_ADAPTER)
  add_executable(
    av1scope_inspection_worker
    inspection_worker.c
    worker_limits.c
    worker_sandbox.c
  )
  target_compile_features(av1scope_inspection_worker PRIVATE c_std_11)
  target_include_directories(av1scope_inspection_worker PRIVATE include)
  target_link_libraries(
    av1scope_inspection_worker
    PRIVATE ${AV1SCOPE_EFFECTIVE_INSPECTION_ADAPTER}
  )
  if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(
      av1scope_inspection_worker
      PRIVATE -pedantic -Wall -Wextra -Werror
    )
  elseif(MSVC)
    target_compile_options(av1scope_inspection_worker PRIVATE /W4 /WX)
  endif()
  install(TARGETS av1scope_inspection_worker RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()

add_executable(
  av1scope_libaom_adapter_contract_smoke
  libaom_inspection_adapter.c
  test/libaom-patch-stub.c
  test/libaom-inspection-adapter-smoke.c
)
target_compile_features(av1scope_libaom_adapter_contract_smoke PRIVATE c_std_11)
target_compile_definitions(
  av1scope_libaom_adapter_contract_smoke
  PRIVATE AV1SCOPE_LIBAOM_BUILD_ID="test-patched-fork-build-0000000000000001"
)
target_include_directories(av1scope_libaom_adapter_contract_smoke PRIVATE include)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(
    av1scope_libaom_adapter_contract_smoke
    PRIVATE -UNDEBUG -pedantic -Wall -Wextra -Werror
  )
elseif(MSVC)
  target_compile_options(av1scope_libaom_adapter_contract_smoke PRIVATE /UNDEBUG /W4 /WX)
endif()

add_executable(av1scope_worker_limits_smoke test/worker-limits-smoke.c worker_limits.c)
target_compile_features(av1scope_worker_limits_smoke PRIVATE c_std_11)
target_include_directories(av1scope_worker_limits_smoke PRIVATE include)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(
    av1scope_worker_limits_smoke
    PRIVATE -pedantic -Wall -Wextra -Werror
  )
elseif(MSVC)
  target_compile_options(av1scope_worker_limits_smoke PRIVATE /W4 /WX)
endif()

add_executable(av1scope_crash_after_stdin test/crash-after-stdin.c)
target_compile_features(av1scope_crash_after_stdin PRIVATE c_std_11)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(av1scope_crash_after_stdin PRIVATE -pedantic -Wall -Wextra -Werror)
elseif(MSVC)
  target_compile_options(av1scope_crash_after_stdin PRIVATE /W4 /WX)
endif()

add_executable(av1scope_worker_sandbox_smoke test/worker-sandbox-smoke.c worker_sandbox.c)
target_compile_features(av1scope_worker_sandbox_smoke PRIVATE c_std_11)
target_include_directories(av1scope_worker_sandbox_smoke PRIVATE include)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(
    av1scope_worker_sandbox_smoke
    PRIVATE -pedantic -Wall -Wextra -Werror
  )
elseif(MSVC)
  target_compile_options(av1scope_worker_sandbox_smoke PRIVATE /W4 /WX)
endif()

add_executable(
  av1scope_worker_parent_death_smoke
  test/worker-parent-death-smoke.c
  worker_sandbox.c
)
target_compile_features(av1scope_worker_parent_death_smoke PRIVATE c_std_11)
target_include_directories(av1scope_worker_parent_death_smoke PRIVATE include)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(
    av1scope_worker_parent_death_smoke
    PRIVATE -pedantic -Wall -Wextra -Werror
  )
elseif(MSVC)
  target_compile_options(av1scope_worker_parent_death_smoke PRIVATE /W4 /WX)
endif()

install(
  TARGETS av1scope_ffmpeg_demux av1scope_ffmpeg_demux_worker
  LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
  RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)
install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
