// tbgen: build distance-to-mate tables on the CPU (all cores).
//   tbgen --material KQR-K,KRB-K --dir tables [--cap 15] [--threads N] [--force]
#include <atomic>
#include <thread>

#include "tb_driver.h"

struct CpuBackend {
    int threads = (int)std::thread::hardware_concurrency();

    std::string label() const { return "cpu x" + std::to_string(threads); }
    template <class F>
    bool option(const std::string& a, F val) {
        if (a == "--threads") {
            threads = std::stoi(val());
            return true;
        }
        if (a == "--device") {  // accepted for CLI symmetry; the CPU build has only one device
            val();
            return true;
        }
        return false;
    }
    bool init() {
        if (threads < 1) threads = 1;
        return true;
    }

    template <class F>
    uint64_t parallel(uint64_t n, F f) {
        std::atomic<uint64_t> total{0};
        std::vector<std::thread> ts;
        const uint64_t chunk = 1 << 16;
        std::atomic<uint64_t> next{0};
        for (int t = 0; t < threads; ++t)
            ts.emplace_back([&]() {
                uint64_t local = 0;
                for (;;) {
                    uint64_t s = next.fetch_add(chunk);
                    if (s >= n) break;
                    uint64_t e = std::min(n, s + chunk);
                    for (uint64_t i = s; i < e; ++i) local += f(i);
                }
                total += local;
            });
        for (auto& t : ts) t.join();
        return total;
    }

    void run(const tb::Material& m, const uint8_t* const subs[tb::MAXP], int cap, std::vector<uint8_t>& W,
             tb::Stats& st) {
        uint64_t n = tb::tableSize(m.m);
        W.assign(n, 0);
        std::vector<uint8_t> B(n, 0);
        tb::Ctx c;
        c.mat = m;
        c.W = W.data();
        c.B = B.data();
        c.cap = cap;
        for (int i = 0; i < m.m; ++i) c.sub[i] = subs[i];
        parallel(n, [&](uint64_t i) {
            tb::initPos(c, i);
            return 0;
        });
        for (int k = 1; k <= cap; ++k) {
            uint64_t w = parallel(n, [&](uint64_t i) { return (uint64_t)tb::stepW(c, i, k); });
            uint64_t b = parallel(n, [&](uint64_t i) { return (uint64_t)tb::stepB(c, i, k); });
            st.passes = k;
            if (w == 0 && b == 0) break;
        }
    }
};

int main(int argc, char** argv) {
    CpuBackend be;
    return tb::runMain(argc, argv, be);
}
