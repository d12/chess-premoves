// Read-only access to tables built by tbgen / tbgen_cuda, memory-mapped and loaded lazily.
#pragma once
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <map>
#include <string>

#include "../vendor/chess.hpp"
#include "tb_driver.h"

namespace tb {

class TableSet {
   public:
    explicit TableSet(std::string dir = "") : dir(std::move(dir)) {}
    ~TableSet() {
        for (auto& kv : tables)
            if (kv.second.data) munmap((void*)kv.second.base, kv.second.bytes);
    }
    TableSet(const TableSet&) = delete;
    TableSet& operator=(const TableSet&) = delete;

    bool enabled() const { return !dir.empty(); }

    // Distance to mate for white to move, if a table covers this position:
    //   returns -1 if no table applies, else 0 (no mate within *cap) or k (mate in k).
    int probe(const chess::Board& b, int* capOut) {
        using namespace chess;
        if (dir.empty()) return -1;
        if (b.us(Color::BLACK).count() != 1) return -1;
        if (b.pieces(PieceType::PAWN, Color::WHITE)) return -1;
        if (b.castlingRights().has(Color::WHITE)) return -1;
        Material m;
        int sq[MAXP];
        const PieceType order[] = {PieceType::QUEEN, PieceType::ROOK, PieceType::BISHOP, PieceType::KNIGHT};
        const int code[] = {QUEEN, ROOK, BISHOP, KNIGHT};
        for (int t = 0; t < 4; ++t) {
            Bitboard bb = b.pieces(order[t], Color::WHITE);
            while (bb) {
                if (m.m >= MAXP) return -1;
                sq[m.m] = bb.pop();
                m.type[m.m++] = code[t];
            }
        }
        if (m.m == 0) return -1;
        const Entry* e = get(m);
        if (!e) return -1;
        uint64_t idx = encode(b.kingSq(Color::WHITE).index(), b.kingSq(Color::BLACK).index(), sq, m.m);
        uint8_t v = e->data[idx];
        if (v == W_ILLEGAL) return -1;
        if (capOut) *capOut = e->cap;
        return v;
    }

    int loadedCount() const {
        int n = 0;
        for (auto& kv : tables)
            if (kv.second.data) n++;
        return n;
    }

   private:
    struct Entry {
        const uint8_t* base = nullptr;
        const uint8_t* data = nullptr;
        size_t bytes = 0;
        int cap = 0;
    };
    std::string dir;
    std::map<std::string, Entry> tables;

    const Entry* get(const Material& m) {
        std::string key = name(m);
        auto it = tables.find(key);
        if (it == tables.end()) it = tables.emplace(key, load(m)).first;
        return it->second.data ? &it->second : nullptr;
    }

    Entry load(const Material& m) {
        Entry e;
        std::string path = tablePath(dir, m);
        int fd = open(path.c_str(), O_RDONLY);
        if (fd < 0) return e;
        struct stat st;
        size_t want = sizeof(Header) + tableSize(m.m);
        if (fstat(fd, &st) != 0 || (size_t)st.st_size != want) {
            close(fd);
            return e;
        }
        void* p = mmap(nullptr, want, PROT_READ, MAP_SHARED, fd, 0);
        close(fd);
        if (p == MAP_FAILED) return e;
        const Header* h = (const Header*)p;
        if (std::memcmp(h->magic, "PPZTB1", 6) || h->m != m.m) {
            munmap(p, want);
            return e;
        }
        e.base = (const uint8_t*)p;
        e.data = e.base + sizeof(Header);
        e.bytes = want;
        e.cap = h->cap;
        return e;
    }
};

}  // namespace tb
