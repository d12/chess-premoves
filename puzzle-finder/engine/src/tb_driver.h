// Host-side tablebase driver shared by the CPU (tbgen.cpp) and CUDA (tbgen_cuda.cu) builds.
#pragma once
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "tb_core.h"

namespace tb {

inline int typeOf(char c) {
    switch (c) {
        case 'Q': return QUEEN;
        case 'R': return ROOK;
        case 'B': return BISHOP;
        case 'N': return KNIGHT;
    }
    return NONE;
}
inline char charOf(int t) { return " NBRQK"[t]; }

// Accepts "KQR-K", "KQRvK" or "QR".
inline bool parseMaterial(std::string s, Material& m) {
    auto d = s.find_first_of("-v");
    if (d != std::string::npos) {
        std::string b = s.substr(d + 1);
        if (b != "K" && b != "k") return false;  // tables are for a lone black king only
        s = s.substr(0, d);
    }
    if (!s.empty() && (s[0] == 'K' || s[0] == 'k')) s = s.substr(1);
    m = Material{};
    for (char c : s) {
        int t = typeOf((char)toupper(c));
        if (t == NONE || m.m >= MAXP) return false;
        m.type[m.m++] = t;
    }
    for (int i = 0; i < m.m; ++i)  // sort Q > R > B > N
        for (int j = i + 1; j < m.m; ++j)
            if (m.type[j] > m.type[i]) std::swap(m.type[i], m.type[j]);
    return m.m > 0;
}
inline std::string name(const Material& m) {
    std::string s = "K";
    for (int i = 0; i < m.m; ++i) s += charOf(m.type[i]);
    return s + "-K";
}
inline Material without(const Material& m, int i) {
    Material r;
    for (int j = 0; j < m.m; ++j)
        if (j != i) r.type[r.m++] = m.type[j];
    return r;
}
inline bool canPossiblyMate(const Material& m) {
    if (m.m == 0) return false;
    if (m.m == 1 && (m.type[0] == KNIGHT || m.type[0] == BISHOP)) return false;
    return true;
}

struct Header {
    char magic[8] = {'P', 'P', 'Z', 'T', 'B', '1', 0, 0};
    uint8_t m = 0, cap = 0, type[MAXP] = {0}, pad[3] = {0};
};
static_assert(sizeof(Header) == 16, "header layout");

inline std::string tablePath(const std::string& dir, const Material& m) { return dir + "/" + name(m) + ".tb"; }

inline bool readTable(const std::string& path, const Material& m, int needCap, std::vector<uint8_t>& W) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    Header h;
    f.read((char*)&h, sizeof h);
    if (!f || std::memcmp(h.magic, "PPZTB1", 6) || h.m != m.m || h.cap < needCap) return false;
    W.resize(tableSize(m.m));
    f.read((char*)W.data(), (std::streamsize)W.size());
    return bool(f);
}

inline void writeTable(const std::string& path, const Material& m, int cap, const std::vector<uint8_t>& W) {
    Header h;
    h.m = (uint8_t)m.m;
    h.cap = (uint8_t)cap;
    for (int i = 0; i < m.m; ++i) h.type[i] = (uint8_t)m.type[i];
    std::string tmp = path + ".tmp";
    {
        std::ofstream f(tmp, std::ios::binary);
        f.write((const char*)&h, sizeof h);
        f.write((const char*)W.data(), (std::streamsize)W.size());
    }
    std::rename(tmp.c_str(), path.c_str());
}

struct Stats {
    int passes = 0;
    double seconds = 0;
};

template <class Backend>
class Builder {
   public:
    Builder(Backend& be, std::string dir, int cap, bool force) : be(be), dir(std::move(dir)), cap(cap), force(force) {}

    // Returns the white-to-move table, loading it from disk or building it (and its sub-tables).
    const std::vector<uint8_t>& ensure(const Material& m, bool top = true) {
        std::string key = name(m);
        auto it = cache.find(key);
        if (it != cache.end()) return it->second;
        std::vector<uint8_t>& W = cache[key];
        if (!(force && top) && readTable(tablePath(dir, m), m, cap, W)) {
            report(m, W, nullptr);
            return W;
        }
        const uint8_t* subs[MAXP] = {nullptr};
        for (int i = 0; i < m.m; ++i) {
            Material s = without(m, i);
            if (canPossiblyMate(s)) subs[i] = ensure(s, false).data();
        }
        Stats st;
        auto t0 = std::chrono::steady_clock::now();
        be.run(m, subs, cap, W, st);
        st.seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        writeTable(tablePath(dir, m), m, cap, W);
        report(m, W, &st);
        return W;
    }

   private:
    Backend& be;
    std::string dir;
    int cap;
    bool force;
    std::map<std::string, std::vector<uint8_t>> cache;

    void report(const Material& m, const std::vector<uint8_t>& W, const Stats* st) {
        uint64_t legal = 0, mates = 0;
        int maxd = 0;
        uint64_t hist[256] = {0};
        for (uint8_t v : W) {
            if (v == W_ILLEGAL) continue;
            legal++;
            if (v) {
                mates++;
                hist[v]++;
                if (v > maxd) maxd = v;
            }
        }
        std::ostringstream o;
        o << "{\"material\":\"" << name(m) << "\",\"status\":\"" << (st ? "built" : "cached") << "\",\"backend\":\""
          << be.label() << "\",\"cap\":" << cap << ",\"legal\":" << legal << ",\"mates\":" << mates
          << ",\"max_dtm\":" << maxd << ",\"bytes\":" << W.size();
        if (st) o << ",\"passes\":" << st->passes << ",\"seconds\":" << st->seconds;
        o << ",\"by_dtm\":[";
        for (int k = 1; k <= maxd; ++k) o << (k > 1 ? "," : "") << hist[k];
        o << "]}";
        std::cout << o.str() << std::endl;
    }
};

inline std::vector<std::string> splitList(const std::string& s) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (c == ',') {
            if (!cur.empty()) out.push_back(cur);
            cur.clear();
        } else
            cur += c;
    }
    if (!cur.empty()) out.push_back(cur);
    return out;
}

template <class Backend>
int runMain(int argc, char** argv, Backend& be) {
    std::string mats = "KQ-K,KR-K", dir = "tables";
    int cap = 15;
    bool force = false;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto val = [&]() { return i + 1 < argc ? std::string(argv[++i]) : std::string(); };
        if (a == "--material") mats = val();
        else if (a == "--dir") dir = val();
        else if (a == "--cap") cap = std::stoi(val());
        else if (a == "--force") force = true;
        else if (!be.option(a, val)) {
            std::cerr << "unknown option " << a << "\n";
            return 2;
        }
    }
    if (cap < 1 || cap > 200) {
        std::cerr << "cap must be 1..200\n";
        return 2;
    }
    if (!be.init()) return 1;
    Builder<Backend> b(be, dir, cap, force);
    for (auto& s : splitList(mats)) {
        Material m;
        if (!parseMaterial(s, m)) {
            std::cerr << "unsupported material '" << s << "' (lone black king, up to 3 white Q/R/B/N)\n";
            return 2;
        }
        b.ensure(m);
    }
    return 0;
}

}  // namespace tb
