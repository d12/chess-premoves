// tbgen_cuda: build distance-to-mate tables on an NVIDIA GPU.
//   tbgen_cuda --material KRBN-K --dir tables [--cap 15] [--device 0] [--force]
//
// Same per-position code as the CPU builder (tb_core.h); only the loop over positions
// differs: one GPU thread per position, grid-stride.
#include <cuda_runtime.h>

#include "tb_driver.h"

#define CUDA_OK(x)                                                                                   \
    do {                                                                                             \
        cudaError_t e_ = (x);                                                                        \
        if (e_ != cudaSuccess) {                                                                     \
            fprintf(stderr, "CUDA error %s at %s:%d\n", cudaGetErrorString(e_), __FILE__, __LINE__); \
            exit(1);                                                                                 \
        }                                                                                            \
    } while (0)

__global__ void kInit(tb::Ctx c, uint64_t n) {
    for (uint64_t i = blockIdx.x * (uint64_t)blockDim.x + threadIdx.x; i < n; i += (uint64_t)gridDim.x * blockDim.x)
        tb::initPos(c, i);
}

__global__ void kStepW(tb::Ctx c, uint64_t n, int k, unsigned long long* changed) {
    unsigned long long local = 0;
    for (uint64_t i = blockIdx.x * (uint64_t)blockDim.x + threadIdx.x; i < n; i += (uint64_t)gridDim.x * blockDim.x)
        local += tb::stepW(c, i, k);
    if (local) atomicAdd(changed, local);
}

__global__ void kStepB(tb::Ctx c, uint64_t n, int k, unsigned long long* changed) {
    unsigned long long local = 0;
    for (uint64_t i = blockIdx.x * (uint64_t)blockDim.x + threadIdx.x; i < n; i += (uint64_t)gridDim.x * blockDim.x)
        local += tb::stepB(c, i, k);
    if (local) atomicAdd(changed, local);
}

struct CudaBackend {
    int device = 0;
    std::string devName;
    int blocks = 0, threads = 256;

    std::string label() const { return "cuda:" + std::to_string(device) + " " + devName; }
    template <class F>
    bool option(const std::string& a, F val) {
        if (a == "--device") {
            device = std::stoi(val());
            return true;
        }
        if (a == "--threads") {  // CPU option; ignored here
            val();
            return true;
        }
        return false;
    }
    bool init() {
        int count = 0;
        if (cudaGetDeviceCount(&count) != cudaSuccess || count == 0) {
            fprintf(stderr, "no CUDA device found\n");
            return false;
        }
        if (device >= count) {
            fprintf(stderr, "CUDA device %d not found (%d available)\n", device, count);
            return false;
        }
        CUDA_OK(cudaSetDevice(device));
        cudaDeviceProp p;
        CUDA_OK(cudaGetDeviceProperties(&p, device));
        devName = p.name;
        blocks = p.multiProcessorCount * 32;
        return true;
    }

    unsigned long long launch(int which, const tb::Ctx& c, uint64_t n, int k, unsigned long long* dCount) {
        CUDA_OK(cudaMemset(dCount, 0, sizeof(unsigned long long)));
        if (which == 0)
            kStepW<<<blocks, threads>>>(c, n, k, dCount);
        else
            kStepB<<<blocks, threads>>>(c, n, k, dCount);
        CUDA_OK(cudaGetLastError());
        unsigned long long h = 0;
        CUDA_OK(cudaMemcpy(&h, dCount, sizeof h, cudaMemcpyDeviceToHost));
        return h;
    }

    void run(const tb::Material& m, const uint8_t* const subs[tb::MAXP], int cap, std::vector<uint8_t>& W,
             tb::Stats& st) {
        uint64_t n = tb::tableSize(m.m);
        size_t freeB = 0, totalB = 0;
        CUDA_OK(cudaMemGetInfo(&freeB, &totalB));
        size_t need = 2 * n;
        for (int i = 0; i < m.m; ++i)
            if (subs[i]) need += tb::tableSize(m.m - 1);
        if (need > freeB) {
            fprintf(stderr, "%s needs %.1f GB of GPU memory, %.1f GB free\n", tb::name(m).c_str(), need / 1e9,
                    freeB / 1e9);
            exit(1);
        }
        tb::Ctx c;
        c.mat = m;
        c.cap = cap;
        CUDA_OK(cudaMalloc(&c.W, n));
        CUDA_OK(cudaMalloc(&c.B, n));
        uint8_t* dSub[tb::MAXP] = {nullptr};
        for (int i = 0; i < m.m; ++i) {
            if (!subs[i]) continue;
            size_t sn = tb::tableSize(m.m - 1);
            CUDA_OK(cudaMalloc(&dSub[i], sn));
            CUDA_OK(cudaMemcpy(dSub[i], subs[i], sn, cudaMemcpyHostToDevice));
            c.sub[i] = dSub[i];
        }
        unsigned long long* dCount;
        CUDA_OK(cudaMalloc(&dCount, sizeof(unsigned long long)));
        kInit<<<blocks, threads>>>(c, n);
        CUDA_OK(cudaGetLastError());
        for (int k = 1; k <= cap; ++k) {
            unsigned long long w = launch(0, c, n, k, dCount);
            unsigned long long b = launch(1, c, n, k, dCount);
            st.passes = k;
            if (w == 0 && b == 0) break;
        }
        W.resize(n);
        CUDA_OK(cudaMemcpy(W.data(), c.W, n, cudaMemcpyDeviceToHost));
        for (int i = 0; i < m.m; ++i)
            if (dSub[i]) cudaFree(dSub[i]);
        cudaFree(c.W);
        cudaFree(c.B);
        cudaFree(dCount);
    }
};

int main(int argc, char** argv) {
    CudaBackend be;
    return tb::runMain(argc, argv, be);
}
