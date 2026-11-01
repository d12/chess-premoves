// Premove puzzle solver core.
//
// Problem: find the shortest sequence of WHITE moves m1..mn, committed in advance,
// such that whatever black replies, every premove is legal when its turn comes and
// black is checkmated at some point (possibly before mn).
//
// Approach: search over BELIEF STATES. A belief is the set of positions (white to move)
// that black could have steered the game into, given the premoves made so far.
//   * A white move is playable only if it is legal in EVERY position of the belief
//     (moves are identified by from/to/promotion, exactly like a premove in a UI).
//   * After the move, positions where black is mated drop out; any stalemate kills
//     the plan; the rest expand by every black reply into the next belief.
//   * The plan succeeds when the belief becomes empty.
//
// Key prune: an open-loop (premove) plan is also a closed-loop strategy, so every
// position in a belief with r moves left must have an ordinary forced mate in <= r.
// That is checked with a cached AND/OR mate prover and removes almost all branches.
#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

#include "../vendor/chess.hpp"
#include "tb_probe.h"

namespace pm {

using namespace chess;

constexpr int MAXD = 24;  // max plan length supported

inline uint64_t mix64(uint64_t x) {
    x += 0x9e3779b97f4a7c15ULL;
    x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ULL;
    x = (x ^ (x >> 27)) * 0x94d049bb133111ebULL;
    return x ^ (x >> 31);
}

// Board without move history (we never unmake belief positions), cheap to copy.
struct Pos final : Board {
    Pos() : Board() {}
    explicit Pos(std::string_view fen) : Board(fen) {}
    explicit Pos(const Board& b) : Board(b) { prev_states_.clear(); }
    void play(Move m) {
        makeMove<true>(m);
        prev_states_.clear();
    }
};

inline int pti(PieceType pt) { return static_cast<int>(pt); }  // PAWN=0..KING=5

// Premove identity: from, to, promotion piece (ignores en-passant / flags).
inline uint16_t mkey(Move m) {
    int promo = (m.typeOf() == Move::PROMOTION) ? pti(m.promotionType()) : 0;  // N=1..Q=4
    return (uint16_t)(m.from().index() | (m.to().index() << 6) | (promo << 12));
}
constexpr int KEYSPACE = 1 << 15;

inline bool whiteCanNeverMate(const Board& b) {
    // Conservative: white with a bare king can never mate. With a single minor piece and
    // a bare black king, mate is impossible. Everything else is left to the search.
    Bitboard w = b.us(Color::WHITE);
    int wc = w.count();
    if (wc == 1) return true;
    if (wc == 2 && b.us(Color::BLACK).count() == 1) {
        Bitboard minors = b.pieces(PieceType::KNIGHT, Color::WHITE) | b.pieces(PieceType::BISHOP, Color::WHITE);
        if (minors.count() == 1) return true;
    }
    return false;
}

// ---------------------------------------------------------------- closed-loop mate prover
struct CLEntry {
    uint64_t key = 0;
    int8_t win = 0;    // smallest k with "mate within k" proven (0 = unknown)
    int8_t fail = -1;  // largest k with "no mate within k" proven
    uint16_t move = 0; // best white move / refuting black move (raw)
};

class CLTable {
   public:
    explicit CLTable(size_t log2size = 22) { resize(log2size); }
    void resize(size_t log2size) {
        t.assign(size_t(1) << log2size, CLEntry{});
        mask = (uint64_t(1) << log2size) - 1;
    }
    void clear() { std::fill(t.begin(), t.end(), CLEntry{}); }
    CLEntry* get(uint64_t key) {
        CLEntry& e = t[key & mask];
        return e.key == key ? &e : nullptr;
    }
    CLEntry& slot(uint64_t key) {
        CLEntry& e = t[key & mask];
        if (e.key != key) e = CLEntry{key, 0, -1, 0};
        return e;
    }

   private:
    std::vector<CLEntry> t;
    uint64_t mask = 0;
};

// ---------------------------------------------------------------- open-loop belief table
struct OLEntry {
    uint64_t key = 0;
    int8_t fail = -1;  // largest r proven unsolvable
};

struct StepInfo {
    std::string uci, san;
    int piece = 0;          // piece type moved (0..5)
    int belief = 0;         // positions in belief before the move
    int checks = 0;         // positions where the move gives check
    int captures = 0;       // positions where the move captures
    int mates = 0;          // positions mated by this move
    int offered = 0;        // positions where black can then capture the moved piece
    int mate_pieces = 0;    // bitmask of piece types giving the mating checks
    int branches = 0;       // black replies expanded after this move
};

class Solver {
   public:
    // ---- configuration
    int64_t nodeLimit = 4'000'000;
    int maxBelief = 50'000;
    uint8_t forbidMask = 0;   // white piece types (bit = 1<<pt) that may not move
    uint8_t requireMask = 0;  // white piece types that must move at least once

    // ---- results / stats
    int64_t nodes = 0;
    int64_t tableHits = 0;
    bool aborted = false;
    tb::TableSet* tables = nullptr;  // optional distance-to-mate tables (exact, O(1))

    // Table lookup: 1 = mate within k, 0 = no mate within k, -1 = not covered.
    int probeMate(const Board& b, int k) {
        if (!tables) return -1;
        int cap = 0;
        int v = tables->probe(b, &cap);
        if (v < 0) return -1;
        if (v > 0) {
            tableHits++;
            return v <= k ? 1 : 0;
        }
        if (k <= cap) {
            tableHits++;
            return 0;
        }
        return -1;  // beyond the table's horizon: fall back to search
    }
    Move plan[MAXD];
    int planLen = 0;

    Solver(size_t clLog2 = 22, size_t olLog2 = 20) : cl(clLog2) {
        ol.assign(size_t(1) << olLog2, OLEntry{});
        olMask = (uint64_t(1) << olLog2) - 1;
        for (auto& p : pool) p.reserve(64);
        for (auto& l : lists) l.reserve(64);
        std::memset(history, 0, sizeof(history));
    }

    void resetCounters() {
        nodes = 0;
        aborted = false;
    }
    void clearOpenLoop() { std::fill(ol.begin(), ol.end(), OLEntry{}); }
    void clearAll() {
        cl.clear();
        clearOpenLoop();
        std::memset(history, 0, sizeof(history));
    }

    // Ordinary (closed-loop) forced mate within k white moves, white to move.
    bool mateW(Board& b, int k) {
        if (k <= 0 || aborted) return false;
        if (tables) {
            int t = probeMate(b, k);
            if (t >= 0) return t == 1;
        }
        uint64_t key = b.hash();
        if (CLEntry* e = cl.get(key)) {
            if (e->win && e->win <= k) return true;
            if (e->fail >= k) return false;
        }
        if (++nodes > nodeLimit) {
            aborted = true;
            return false;
        }
        Movelist ml;
        movegen::legalmoves(ml, b);
        if (k == 1) {
            for (const Move& m : ml) {
                if (b.givesCheck(m) == CheckType::NO_CHECK) continue;
                b.makeMove<true>(m);
                bool mated = !movegen::anylegalmoves(b);
                b.unmakeMove(m);
                if (mated) {
                    CLEntry& s = cl.slot(key);
                    s.win = 1;
                    s.move = m.move();
                    return true;
                }
            }
            CLEntry& s = cl.slot(key);
            if (s.fail < 1) s.fail = 1;
            return false;
        }
        uint16_t hint = 0;
        if (CLEntry* e = cl.get(key)) hint = e->move;
        for (Move& m : ml) {
            int sc = history[mkey(m)];
            if (m.move() == hint) sc += 1 << 20;
            if (b.givesCheck(m) != CheckType::NO_CHECK) sc += 1 << 16;
            if (b.at(m.to()) != Piece::NONE) sc += 1 << 15;
            m.setScore((int16_t)std::min(sc >> 8, 32000));
        }
        std::stable_sort(ml.begin(), ml.end(), [](const Move& a, const Move& c) { return a.score() > c.score(); });
        for (const Move& m : ml) {
            b.makeMove<true>(m);
            bool r = mateB(b, k - 1);
            b.unmakeMove(m);
            if (aborted) return false;
            if (r) {
                CLEntry& s = cl.slot(key);
                if (!s.win || s.win > k) s.win = (int8_t)k;
                s.move = m.move();
                history[mkey(m)] += k * k;
                return true;
            }
        }
        CLEntry& s = cl.slot(key);
        if (s.fail < k) s.fail = (int8_t)k;
        return false;
    }

    // Black to move; true iff every black reply leaves white a mate within k
    // (or black is already checkmated).
    bool mateB(Board& b, int k) {
        Movelist ml;
        movegen::legalmoves(ml, b);
        if (ml.empty()) return b.inCheck();
        if (k <= 0 || aborted) return false;
        if (whiteCanNeverMate(b)) return false;
        uint64_t key = b.hash();
        uint16_t refute = 0;
        if (CLEntry* e = cl.get(key)) {
            if (e->win && e->win <= k) return true;
            if (e->fail >= k) return false;
            refute = e->move;
        }
        if (refute) {
            for (int i = 0; i < ml.size(); ++i)
                if (ml[i].move() == refute) {
                    std::swap(ml[0], ml[i]);
                    break;
                }
        }
        for (const Move& m : ml) {
            b.makeMove<true>(m);
            bool r = mateW(b, k);
            b.unmakeMove(m);
            if (aborted) return false;
            if (!r) {
                CLEntry& s = cl.slot(key);
                if (s.fail < k) s.fail = (int8_t)k;
                s.move = m.move();
                return false;
            }
        }
        CLEntry& s = cl.slot(key);
        if (!s.win || s.win > k) s.win = (int8_t)k;
        return true;
    }

    // Shortest closed-loop mate (1..maxK); 0 = none within maxK; -1 = aborted.
    int closedDistance(const Board& root, int maxK) {
        if (tables) {
            int cap = 0;
            int v = tables->probe(root, &cap);
            if (v > 0) return v <= maxK ? v : 0;
            if (v == 0 && maxK <= cap) return 0;
        }
        Board b = root;
        for (int k = 1; k <= maxK; ++k) {
            if (mateW(b, k)) return k;
            if (aborted) return -1;
        }
        return 0;
    }

    // Shortest premove plan of length in [minN, maxN]. Returns n, 0 if none, -1 if aborted.
    // `startAt` lets callers skip lengths already known to be impossible (e.g. closed distance).
    int solve(const Board& root, int maxN, int startAt = 1) {
        if (maxN >= MAXD) maxN = MAXD - 1;
        setRoot(root);
        for (int n = std::max(1, startAt); n <= maxN; ++n) {
            if (olSearch(0, n, 0)) {
                planLen = n;  // plans always use exactly n at the minimum
                return n;
            }
            if (aborted) return -1;
        }
        return 0;
    }

    // Number of distinct premove plans of exactly length n (n must be the minimum).
    // Also returns number of distinct first moves via *firstMoves. Capped at `cap`.
    uint64_t countPlans(const Board& root, int n, int* firstMoves, uint64_t cap = 1'000'000) {
        setRoot(root);
        memo.clear();
        countCap = cap;
        return countRec(0, n, 0, firstMoves);
    }

    // Replays a plan over beliefs and records per-step statistics. Returns false if the
    // plan does not actually work (should never happen for solver output).
    bool analyzePlan(const Board& root, const std::vector<Move>& moves, std::vector<StepInfo>& out, int& maxWidth) {
        out.clear();
        maxWidth = 1;
        setRoot(root);
        int level = 0;  // always reuse levels 0/1
        for (size_t s = 0; s < moves.size(); ++s) {
            uint16_t key = mkey(moves[s]);
            int B = psz[level];
            if (B == 0) return false;
            maxWidth = std::max(maxWidth, B);
            StepInfo si;
            si.belief = B;
            Pos& rep = pool[level][0];
            {
                Movelist ml;
                movegen::legalmoves(ml, rep);
                Move m = findKey(ml, key);
                if (m == Move::NO_MOVE) return false;
                si.uci = uci::moveToUci(m);
                std::string san = uci::moveToSan(rep, m);
                while (!san.empty() && (san.back() == '+' || san.back() == '#')) san.pop_back();
                si.san = san;
                si.piece = pti(rep.at<PieceType>(m.from()));
            }
            auto& dst = pool[level ^ 1];
            int n = 0;
            stampGen++;
            for (int i = 0; i < B; ++i) {
                Pos& p = pool[level][i];
                Movelist ml;
                movegen::legalmoves(ml, p);
                Move m = findKey(ml, key);
                if (m == Move::NO_MOVE) return false;
                if (p.givesCheck(m) != CheckType::NO_CHECK) si.checks++;
                if (p.at(m.to()) != Piece::NONE && m.typeOf() != Move::CASTLING) si.captures++;
                Square dest = m.to();
                if (m.typeOf() == Move::CASTLING) dest = Square(m.to() > m.from() ? m.from().index() + 2 : m.from().index() - 2);
                tmp = p;
                tmp.play(m);
                Movelist bl;
                movegen::legalmoves(bl, tmp);
                if (bl.empty()) {
                    if (!tmp.inCheck()) return false;
                    si.mates++;
                    Bitboard ch = tmp.checkers();
                    while (ch) si.mate_pieces |= 1 << pti(tmp.at<PieceType>(Square(ch.pop())));
                    continue;
                }
                if (s + 1 == moves.size()) return false;
                bool off = false;
                for (const Move& bm : bl)
                    if (bm.to() == dest) off = true;
                if (off) si.offered++;
                si.branches += (int)bl.size();
                for (const Move& bm : bl) {
                    if (n >= (int)dst.size()) dst.emplace_back();
                    dst[n] = tmp;
                    dst[n].play(bm);
                    if (insertHash(dst[n].hash())) n++;
                }
            }
            psz[level ^ 1] = n;
            level ^= 1;
            out.push_back(si);
        }
        return psz[level] == 0;
    }

   private:
    CLTable cl;
    std::vector<OLEntry> ol;
    uint64_t olMask;
    int history[KEYSPACE];

    std::vector<Pos> pool[MAXD + 1];
    std::vector<Movelist> lists[MAXD + 1];
    int psz[MAXD + 1] = {0};
    Pos tmp;

    // dedupe set for building child beliefs
    static constexpr int HSET = 1 << 17;
    std::vector<uint64_t> hkeys = std::vector<uint64_t>(HSET);
    std::vector<uint32_t> hstamp = std::vector<uint32_t>(HSET, 0);
    uint32_t stampGen = 0;

    // intersection counters
    std::vector<uint32_t> kstamp = std::vector<uint32_t>(KEYSPACE, 0);
    std::vector<uint16_t> kcount = std::vector<uint16_t>(KEYSPACE, 0);
    uint32_t kgen = 0;

    std::unordered_map<uint64_t, uint64_t> memo;
    uint64_t countCap = 1'000'000;

    void setRoot(const Board& root) {
        if (pool[0].empty()) pool[0].emplace_back();
        pool[0][0] = Pos(root);
        psz[0] = 1;
    }

    bool insertHash(uint64_t h) {
        uint64_t i = h & (HSET - 1);
        while (hstamp[i] == stampGen) {
            if (hkeys[i] == h) return false;
            i = (i + 1) & (HSET - 1);
        }
        hstamp[i] = stampGen;
        hkeys[i] = h;
        return true;
    }

    static Move findKey(const Movelist& ml, uint16_t key) {
        for (const Move& m : ml)
            if (mkey(m) == key) return m;
        return Move::NO_MOVE;
    }

    uint64_t beliefHash(int level) const {
        uint64_t h = 0x51ed2701 + (uint64_t)psz[level];
        for (int i = 0; i < psz[level]; ++i) h += mix64(pool[level][i].hash());
        return h;
    }

    OLEntry& olSlot(uint64_t key) {
        OLEntry& e = ol[key & olMask];
        if (e.key != key) e = OLEntry{key, -1};
        return e;
    }

    // Candidate premoves: legal in every belief position, not forbidden.
    int candidates(int level, uint16_t* out, int* scores) {
        int B = psz[level];
        auto& L = lists[level];
        if ((int)L.size() < B) L.resize(B);
        kgen++;
        for (int i = 0; i < B; ++i) {
            L[i].clear();
            movegen::legalmoves(L[i], pool[level][i]);
            for (const Move& m : L[i]) {
                uint16_t k = mkey(m);
                if (kstamp[k] != kgen) {
                    kstamp[k] = kgen;
                    kcount[k] = 0;
                }
                kcount[k]++;
            }
        }
        int n = 0;
        Pos& p0 = pool[level][0];
        for (const Move& m : L[0]) {
            uint16_t k = mkey(m);
            if (kcount[k] != B) continue;
            int pt = pti(p0.at<PieceType>(m.from()));
            if (forbidMask & (1 << pt)) continue;
            int sc = history[k];
            if (p0.givesCheck(m) != CheckType::NO_CHECK) sc += 1 << 22;
            out[n] = k;
            scores[n] = sc;
            n++;
        }
        // insertion sort by score desc (lists are short)
        for (int i = 1; i < n; ++i) {
            uint16_t k = out[i];
            int s = scores[i], j = i - 1;
            while (j >= 0 && scores[j] < s) {
                out[j + 1] = out[j];
                scores[j + 1] = scores[j];
                --j;
            }
            out[j + 1] = k;
            scores[j + 1] = s;
        }
        return n;
    }

    // Apply premove `key` to belief `level`; writes child to level+1.
    // Returns child size (0 = everyone mated), or -1 if the move fails somewhere.
    int buildChild(int level, uint16_t key, int r) {
        int B = psz[level];
        auto& dst = pool[level + 1];
        int n = 0;
        stampGen++;
        for (int i = 0; i < B; ++i) {
            Move m = findKey(lists[level][i], key);
            tmp = pool[level][i];
            tmp.play(m);
            Movelist bl;
            movegen::legalmoves(bl, tmp);
            if (bl.empty()) {
                if (tmp.inCheck()) continue;  // mated: branch done
                return -1;                    // stalemate
            }
            if (r <= 1) return -1;
            if (whiteCanNeverMate(tmp)) return -1;
            for (const Move& bm : bl) {
                if (n >= (int)dst.size()) dst.emplace_back();
                dst[n] = tmp;
                dst[n].play(bm);
                if (insertHash(dst[n].hash())) {
                    if (++n > maxBelief) {
                        aborted = true;  // too wide to decide exactly
                        return -1;
                    }
                }
            }
        }
        psz[level + 1] = n;
        return n;
    }

    // Necessary condition: every belief position has an ordinary mate within r.
    bool closedPrune(int level, int r) {
        for (int i = 0; i < psz[level]; ++i) {
            if (!mateW(pool[level][i], r)) return false;
        }
        return true;
    }

    bool olSearch(int level, int r, uint8_t used) {
        if (aborted) return false;
        if (++nodes > nodeLimit) {
            aborted = true;
            return false;
        }
        uint64_t bh = beliefHash(level) ^ mix64(0xabcdefULL + used);
        {
            OLEntry& e = ol[bh & olMask];
            if (e.key == bh && e.fail >= r) return false;
        }
        if (!closedPrune(level, r)) {
            if (!aborted) {
                OLEntry& e = olSlot(bh);
                if (e.fail < r) e.fail = (int8_t)r;
            }
            return false;
        }
        uint16_t cand[256];
        int sc[256];
        int nc = candidates(level, cand, sc);
        for (int c = 0; c < nc; ++c) {
            uint16_t key = cand[c];
            int res = buildChild(level, key, r);
            if (aborted) return false;
            if (res < 0) continue;
            Move m0 = findKey(lists[level][0], key);
            int pt = pti(pool[level][0].at<PieceType>(m0.from()));
            uint8_t nu = used | ((1 << pt) & requireMask);
            if (res == 0) {
                if ((nu & requireMask) == requireMask) {
                    plan[level] = m0;
                    history[key] += r * r;
                    return true;
                }
                continue;
            }
            if (olSearch(level + 1, r - 1, nu)) {
                plan[level] = m0;
                history[key] += r * r;
                return true;
            }
            if (aborted) return false;
        }
        OLEntry& e = olSlot(bh);
        if (e.fail < r) e.fail = (int8_t)r;
        return false;
    }

    uint64_t countRec(int level, int r, uint8_t used, int* firstMoves) {
        if (aborted) return 0;
        if (++nodes > nodeLimit) {
            aborted = true;
            return 0;
        }
        uint64_t mk = beliefHash(level) ^ mix64(0x77ULL * r + 1) ^ mix64(0xabcdefULL + used);
        if (level > 0) {
            auto it = memo.find(mk);
            if (it != memo.end()) return it->second;
        }
        if (!closedPrune(level, r)) return 0;
        uint16_t cand[256];
        int sc[256];
        int nc = candidates(level, cand, sc);
        uint64_t total = 0;
        int fm = 0;
        for (int c = 0; c < nc; ++c) {
            uint16_t key = cand[c];
            int res = buildChild(level, key, r);
            if (aborted) return 0;
            if (res < 0) continue;
            Move m0 = findKey(lists[level][0], key);
            int pt = pti(pool[level][0].at<PieceType>(m0.from()));
            uint8_t nu = used | ((1 << pt) & requireMask);
            uint64_t sub = 0;
            if (res == 0)
                sub = ((nu & requireMask) == requireMask) ? 1 : 0;
            else if (r > 1)
                sub = countRec(level + 1, r - 1, nu, nullptr);
            if (sub) fm++;
            total += sub;
            if (total >= countCap) {
                total = countCap;
                break;
            }
        }
        if (firstMoves) *firstMoves = fm;
        if (!aborted) memo[mk] = total;
        return total;
    }
};

}  // namespace pm
