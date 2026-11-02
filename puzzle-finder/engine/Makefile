# Builds:
#   pmcore      puzzle solver / generator (CPU)
#   tbgen       distance-to-mate table builder, CPU (all cores)
#   tbgen_cuda  the same table builder for NVIDIA GPUs   (make cuda; needs nvcc)
#   wasm        the browser opponent (refuter) as one ES module  (make wasm; needs emsdk)
#
# Works with g++ or clang++ on Linux and macOS (Intel or Apple Silicon).

CXX ?= c++
NVCC ?= nvcc
# RTX 3090 = 86, RTX 40xx = 89, A100 = 80. Embeds PTX too, so newer GPUs still run it.
CUDA_ARCH ?= 86

# -march=native where supported (x86, newer clang), else -mcpu=native (Apple clang on arm64)
ARCHFLAG := $(shell $(CXX) -march=native -x c++ -fsyntax-only /dev/null >/dev/null 2>&1 && echo -march=native || \
                    ($(CXX) -mcpu=native -x c++ -fsyntax-only /dev/null >/dev/null 2>&1 && echo -mcpu=native))
CXXFLAGS ?= -O3 $(ARCHFLAG) -std=c++17 -DNDEBUG -Wall -Wno-unused-function -pthread

HEADERS := src/solver.hpp src/tb_core.h src/tb_driver.h src/tb_probe.h src/refute.hpp src/refute_api.hpp vendor/chess.hpp

all: pmcore tbgen

pmcore: src/pmcore.cpp $(HEADERS)
	$(CXX) $(CXXFLAGS) -o $@ src/pmcore.cpp

tbgen: src/tbgen.cpp src/tb_core.h src/tb_driver.h
	$(CXX) $(CXXFLAGS) -o $@ src/tbgen.cpp

cuda: tbgen_cuda

tbgen_cuda: src/tbgen_cuda.cu src/tb_core.h src/tb_driver.h
	$(NVCC) -O3 -std=c++17 -gencode arch=compute_$(CUDA_ARCH),code=sm_$(CUDA_ARCH) \
	        -gencode arch=compute_$(CUDA_ARCH),code=compute_$(CUDA_ARCH) -o $@ src/tbgen_cuda.cu

# ---- WebAssembly (browser opponent). Needs Emscripten: https://emscripten.org/docs/getting_started
EMXX ?= em++
WASM_OUT ?= ../../src/engine/generated/premove-engine.js
WASM_FLAGS := -O3 -std=c++17 -DNDEBUG \
	-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPremoveEngineModule \
	-sSINGLE_FILE=1 -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 \
	-sEXPORTED_FUNCTIONS=_pm_version,_pm_analyze,_pm_reply -sEXPORTED_RUNTIME_METHODS=cwrap

wasm: $(WASM_OUT)

$(WASM_OUT): wasm/premove_wasm.cpp src/refute.hpp src/refute_api.hpp vendor/chess.hpp
	@mkdir -p $(dir $@)
	$(EMXX) $(WASM_FLAGS) -o $@ wasm/premove_wasm.cpp

clean:
	rm -f pmcore tbgen tbgen_cuda

.PHONY: all cuda wasm clean
