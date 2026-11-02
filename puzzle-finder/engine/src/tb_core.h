// Distance-to-mate tablebases for "white pieces vs lone black king" (no pawns).
//
// Everything in this file is plain per-position logic marked HD, so the exact same code
// runs inside CUDA kernels (tbgen_cuda.cu) and in CPU threads (tbgen.cpp).
//
// Index layout: wk | bk<<6 | p0<<12 | p1<<18 | p2<<24   (up to 3 white non-king pieces)
//
// Tables per material:
//   W[idx]  white to move: 0 = no mate found (within cap), k = mate in k, 255 = illegal
//   B[idx]  black to move: 0 = checkmated, k = mated within k white moves,
//           254 = never (stalemate / illegal), 255 = unknown
//
// Retrograde-by-passes: pass k sets W=k where some white move reaches B<k, then sets B=k
// where every black reply reaches a W in [1,k]. A black king capture continues in the
// sub-table for the remaining material.
#pragma once
#include <cstdint>

#ifdef __CUDACC__
#define HD __host__ __device__ __forceinline__
#else
#define HD inline
#endif

namespace tb {

enum : uint8_t { W_ILLEGAL = 255, B_UNKNOWN = 255, B_NEVER = 254 };
enum : int { NONE = 0, KNIGHT = 1, BISHOP = 2, ROOK = 3, QUEEN = 4, KING = 5 };
constexpr int MAXP = 3;

struct Material {
    int m = 0;              // number of white non-king pieces
    int type[MAXP] = {0};   // sorted Q > R > B > N
};

struct Ctx {
    Material mat;
    uint8_t* W = nullptr;
    uint8_t* B = nullptr;
    const uint8_t* sub[MAXP] = {nullptr};  // W table of material minus piece i (nullptr: cannot mate)
    int cap = 15;
};

HD uint64_t bit(int s) { return 1ULL << s; }
HD int ctz(uint64_t x) {
#ifdef __CUDA_ARCH__
    return __ffsll((long long)x) - 1;
#else
    return __builtin_ctzll(x);
#endif
}
HD int cheb(int a, int b) {
    int df = (a & 7) - (b & 7), dr = (a >> 3) - (b >> 3);
    df = df < 0 ? -df : df;
    dr = dr < 0 ? -dr : dr;
    return df > dr ? df : dr;
}

HD uint64_t stepAtt(int s, const int* df, const int* dr, int n) {
    uint64_t a = 0;
    int f = s & 7, r = s >> 3;
    for (int i = 0; i < n; ++i) {
        int nf = f + df[i], nr = r + dr[i];
        if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) a |= bit(nr * 8 + nf);
    }
    return a;
}
HD uint64_t kingAtt(int s) {
    const int df[8] = {-1, 0, 1, -1, 1, -1, 0, 1}, dr[8] = {-1, -1, -1, 0, 0, 1, 1, 1};
    return stepAtt(s, df, dr, 8);
}
HD uint64_t knightAtt(int s) {
    const int df[8] = {1, 2, 2, 1, -1, -2, -2, -1}, dr[8] = {2, 1, -1, -2, -2, -1, 1, 2};
    return stepAtt(s, df, dr, 8);
}
HD uint64_t slideAtt(int s, uint64_t occ, bool orth, bool diag) {
    uint64_t a = 0;
    const int df[8] = {1, -1, 0, 0, 1, 1, -1, -1}, dr[8] = {0, 0, 1, -1, 1, -1, 1, -1};
    int f0 = s & 7, r0 = s >> 3;
    for (int d = orth ? 0 : 4; d < (diag ? 8 : 4); ++d) {
        int f = f0 + df[d], r = r0 + dr[d];
        while (f >= 0 && f < 8 && r >= 0 && r < 8) {
            int t = r * 8 + f;
            a |= bit(t);
            if (occ & bit(t)) break;
            f += df[d];
            r += dr[d];
        }
    }
    return a;
}
HD uint64_t pieceAtt(int type, int s, uint64_t occ) {
    switch (type) {
        case KNIGHT: return knightAtt(s);
        case BISHOP: return slideAtt(s, occ, false, true);
        case ROOK: return slideAtt(s, occ, true, false);
        case QUEEN: return slideAtt(s, occ, true, true);
        case KING: return kingAtt(s);
    }
    return 0;
}

HD uint64_t tableSize(int m) { return 1ULL << (6 * (m + 2)); }

struct Pos {
    int wk, bk, p[MAXP];
};
HD Pos decode(uint64_t idx, int m) {
    Pos q;
    q.wk = int(idx & 63);
    q.bk = int((idx >> 6) & 63);
    for (int i = 0; i < m; ++i) q.p[i] = int((idx >> (12 + 6 * i)) & 63);
    return q;
}
HD uint64_t encode(int wk, int bk, const int* p, int m) {
    uint64_t idx = uint64_t(wk) | (uint64_t(bk) << 6);
    for (int i = 0; i < m; ++i) idx |= uint64_t(p[i]) << (12 + 6 * i);
    return idx;
}

// Is square t attacked by white, ignoring white piece `skip` (captured) and with the
// given occupancy (black king already lifted off its square).
HD bool whiteAttacks(const Material& mat, const Pos& q, int t, uint64_t occ, int skip) {
    if (cheb(q.wk, t) <= 1) return true;
    for (int i = 0; i < mat.m; ++i) {
        if (i == skip) continue;
        if (pieceAtt(mat.type[i], q.p[i], occ) & bit(t)) return true;
    }
    return false;
}

// Returns false if pieces collide.
HD bool occupancy(const Pos& q, int m, uint64_t& occ, uint64_t& white) {
    white = bit(q.wk);
    occ = white | bit(q.bk);
    if (q.wk == q.bk) return false;
    for (int i = 0; i < m; ++i) {
        uint64_t b = bit(q.p[i]);
        if (occ & b) return false;
        occ |= b;
        white |= b;
    }
    return true;
}

HD void initPos(const Ctx& c, uint64_t idx) {
    const int m = c.mat.m;
    Pos q = decode(idx, m);
    uint64_t occ, white;
    if (!occupancy(q, m, occ, white) || cheb(q.wk, q.bk) <= 1) {
        c.W[idx] = W_ILLEGAL;
        c.B[idx] = B_NEVER;
        return;
    }
    bool inCheck = whiteAttacks(c.mat, q, q.bk, occ, -1);
    c.W[idx] = inCheck ? W_ILLEGAL : 0;  // white to move with black in check is impossible
    uint64_t lifted = occ & ~bit(q.bk);
    uint64_t moves = kingAtt(q.bk);
    bool any = false;
    while (moves && !any) {
        int t = ctz(moves);
        moves &= moves - 1;
        int cap = -1;
        for (int i = 0; i < m; ++i)
            if (q.p[i] == t) cap = i;
        if (t == q.wk) continue;
        if (!whiteAttacks(c.mat, q, t, lifted, cap)) any = true;
    }
    c.B[idx] = any ? B_UNKNOWN : (inCheck ? 0 : B_NEVER);
}

// Pass k, white to move: mate in k if some move reaches a black position lost within k-1.
HD int stepW(const Ctx& c, uint64_t idx, int k) {
    if (c.W[idx] != 0) return 0;
    const int m = c.mat.m;
    Pos q = decode(idx, m);
    uint64_t occ, white;
    occupancy(q, m, occ, white);
    int p[MAXP];
    for (int i = 0; i < m; ++i) p[i] = q.p[i];
    // king moves
    uint64_t mv = kingAtt(q.wk) & ~white;
    while (mv) {
        int t = ctz(mv);
        mv &= mv - 1;
        if (cheb(t, q.bk) <= 1) continue;
        if (c.B[encode(t, q.bk, p, m)] < k) {
            c.W[idx] = (uint8_t)k;
            return 1;
        }
    }
    for (int i = 0; i < m; ++i) {
        uint64_t d = pieceAtt(c.mat.type[i], q.p[i], occ) & ~white & ~bit(q.bk);
        while (d) {
            int t = ctz(d);
            d &= d - 1;
            p[i] = t;
            bool hit = c.B[encode(q.wk, q.bk, p, m)] < k;
            p[i] = q.p[i];
            if (hit) {
                c.W[idx] = (uint8_t)k;
                return 1;
            }
        }
    }
    return 0;
}

// Pass k, black to move: lost within k if every reply reaches a white mate in <= k.
HD int stepB(const Ctx& c, uint64_t idx, int k) {
    if (c.B[idx] != B_UNKNOWN) return 0;
    const int m = c.mat.m;
    Pos q = decode(idx, m);
    uint64_t occ, white;
    occupancy(q, m, occ, white);
    uint64_t lifted = occ & ~bit(q.bk);
    uint64_t moves = kingAtt(q.bk);
    while (moves) {
        int t = ctz(moves);
        moves &= moves - 1;
        if (t == q.wk) continue;
        int cap = -1;
        for (int i = 0; i < m; ++i)
            if (q.p[i] == t) cap = i;
        if (whiteAttacks(c.mat, q, t, lifted, cap)) continue;  // illegal king move
        int v;
        if (cap >= 0) {
            if (!c.sub[cap]) return 0;  // remaining material cannot mate: black escapes
            int p[MAXP], n = 0;
            for (int i = 0; i < m; ++i)
                if (i != cap) p[n++] = q.p[i];
            v = c.sub[cap][encode(q.wk, t, p, n)];
        } else {
            v = c.W[encode(q.wk, t, q.p, m)];
        }
        if (v == 0 || v == W_ILLEGAL || v > k) return 0;
    }
    c.B[idx] = (uint8_t)k;
    return 1;
}

}  // namespace tb
