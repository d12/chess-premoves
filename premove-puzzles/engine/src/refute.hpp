// Refuter: the opponent's best defence against a KNOWN list of white premoves.
//
// In the game the player submits every premove before play starts, so the opponent knows
// the whole plan. Black then only has to choose replies; there is no search over white
// moves. Every reachable (position, premove index) is evaluated once (memoised), so the work
// is the size of the "belief" the plan has to cover: tens to hundreds of positions.
//
// Outcome rules mirror src/game/session.js + chess.js exactly:
//   white premove illegal                -> player loses
//   after a white move: checkmate        -> player wins
//                       stalemate / insufficient material / 50-move / threefold -> draw
//                       premoves exhausted -> player loses
//   after a black move: white checkmated -> player loses; draws as above
// Black's preference: any outcome that is not a player win, reached in as few plies as
// possible; if the plan is sound, the line that survives the longest.
//
// Depends only on the move generator (no tables, no filesystem), so it compiles to
// WebAssembly unchanged.
#pragma once

#include <cctype>
#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

#include "../vendor/chess.hpp"

namespace pm {

using namespace chess;

enum class EndReason : uint8_t {
    None,
    Checkmate,        // player mates: player wins
    PremoveIllegal,   // the rest: player does not win
    OutOfPremoves,
    OpponentMates,
    Stalemate,
    Insufficient,
    FiftyMoves,
    Repetition,
};

inline const char* endName(EndReason r) {
    switch (r) {
        case EndReason::None: return "none";
        case EndReason::Checkmate: return "checkmate";
        case EndReason::PremoveIllegal: return "premove_illegal";
        case EndReason::OutOfPremoves: return "out_of_premoves";
        case EndReason::OpponentMates: return "opponent_mates";
        case EndReason::Stalemate: return "stalemate";
        case EndReason::Insufficient: return "insufficient_material";
        case EndReason::FiftyMoves: return "fifty_moves";
        case EndReason::Repetition: return "threefold_repetition";
    }
    return "?";
}

struct PlanStep {
    int from = 0, to = 0, promo = 0;  // promo: 0 none, else piece type N=1 B=2 R=3 Q=4
};

// Black's view of a line: refuted = the player does not win; plies until the game ends.
struct LineValue {
    bool refuted = false;
    int plies = 0;
    EndReason end = EndReason::None;
};

inline bool blackPrefers(const LineValue& a, const LineValue& b) {
    if (a.refuted != b.refuted) return a.refuted;
    return a.refuted ? a.plies < b.plies : a.plies > b.plies;
}

// chess.js isInsufficientMaterial(), reproduced exactly.
inline bool insufficientMaterialJs(const Board& b) {
    Bitboard occ = b.occ();
    int n = occ.count();
    if (n == 2) return true;
    Bitboard minors = b.pieces(PieceType::BISHOP) | b.pieces(PieceType::KNIGHT);
    if (n == 3 && minors.count() == 1) return true;
    Bitboard bishops = b.pieces(PieceType::BISHOP);
    if (n == (int)bishops.count() + 2) {
        int light = 0, total = 0;
        while (bishops) {
            int s = bishops.pop();
            light += ((s & 7) + (s >> 3)) & 1;
            total++;
        }
        if (light == 0 || light == total) return true;
    }
    return false;
}

// Standard UCI-style identity of a move (castling as king e1->g1, like chess.js).
inline PlanStep stepOf(const Move& m) {
    PlanStep s;
    s.from = m.from().index();
    s.to = m.to().index();
    if (m.typeOf() == Move::CASTLING) s.to = (m.to() > m.from()) ? s.from + 2 : s.from - 2;
    if (m.typeOf() == Move::PROMOTION) s.promo = (int)m.promotionType();  // KNIGHT=1..QUEEN=4
    return s;
}

inline bool parseUci(const std::string& u, PlanStep& s) {
    if (u.size() < 4 || u.size() > 5) return false;
    auto sq = [](char f, char r) { return (f >= 'a' && f <= 'h' && r >= '1' && r <= '8') ? (r - '1') * 8 + (f - 'a') : -1; };
    s.from = sq(u[0], u[1]);
    s.to = sq(u[2], u[3]);
    s.promo = 0;
    if (u.size() == 5) {
        const char* p = "nbrq";
        const char* q = strchr(p, tolower(u[4]));
        if (!q || !*q) return false;
        s.promo = 1 + int(q - p);
    }
    return s.from >= 0 && s.to >= 0;
}

inline std::string uciOf(const Move& m) { return uci::moveToUci(m, false); }

class Refuter {
   public:
    int64_t nodeLimit = 2'000'000;
    int64_t nodes = 0;
    bool aborted = false;
    // false: exact (fastest refutation / longest survival).
    // true: accept the first refutation found; used when the exact search is too big.
    bool firstRefutation = false;

    // `start` is the puzzle position with the player (premover) to move.
    bool setPlan(const Board& start, const std::vector<PlanStep>& plan) {
        plan_ = plan;
        memo_.clear();
        start_ = start;
        nodes = 0;
        aborted = false;
        // Threefold repetition needs the same white placement at two different plies. With a
        // fixed plan, white's placement after premove i is plan-determined (a captured piece
        // can never move again, or the next premove of it would be illegal), so if the
        // placements never repeat, repetition is impossible and history can be ignored.
        historyMode_ = placementsRepeat(start);
        fiftyRelevant_ = (int)start.halfMoveClock() + 2 * (int)plan_.size() + 2 >= 100;
        line_.clear();
        line_.push_back(start.hash());
        return true;
    }

    // Replays moves already played from `start` (player first, alternating), so later
    // calls see the right position and repetition history. Returns false on an illegal move.
    bool replay(Board& b, const std::vector<std::string>& history) {
        line_.assign(1, b.hash());
        for (const std::string& u : history) {
            PlanStep s;
            if (!parseUci(u, s)) return false;
            Move m = findPremove(b, s);
            if (m == Move::NO_MOVE) return false;
            b.makeMove<true>(m);
            line_.push_back(b.hash());
        }
        return true;
    }

    LineValue evalWhite(Board& b, size_t i) {
        LineValue v;
        if (aborted) return v;
        if (i >= plan_.size()) return {true, 0, EndReason::OutOfPremoves};
        uint64_t key = memoKey(b, i);
        auto it = memo_.find(key);
        if (it != memo_.end()) return it->second;
        if (++nodes > nodeLimit) {
            aborted = true;
            return v;
        }
        Move m = findPremove(b, plan_[i]);
        if (m == Move::NO_MOVE) {
            v = {true, 0, EndReason::PremoveIllegal};
        } else {
            b.makeMove<true>(m);
            line_.push_back(b.hash());
            v = afterWhiteMove(b, i);
            line_.pop_back();
            b.unmakeMove(m);
        }
        if (!aborted) memo_[key] = v;
        return v;
    }

    // Opponent to move; `next` = index of the premove the player plays after this reply.
    // Returns NO_MOVE if the opponent has no legal move or the search was aborted.
    Move bestReply(Board& b, size_t next, LineValue* out) {
        if (next > plan_.size()) return Move::NO_MOVE;
        Movelist ml;
        movegen::legalmoves(ml, b);
        Move best = Move::NO_MOVE;
        LineValue bv;
        for (const Move& r : ml) {
            LineValue v = afterBlackMove(b, r, next);
            if (aborted) return Move::NO_MOVE;
            if (best == Move::NO_MOVE || blackPrefers(v, bv)) {
                best = r;
                bv = v;
            }
            if (firstRefutation && bv.refuted) break;
        }
        if (out) *out = bv;
        return best;
    }

    Move findPremove(const Board& b, const PlanStep& s) const {
        Movelist ml;
        movegen::legalmoves(ml, b);
        for (const Move& m : ml) {
            PlanStep t = stepOf(m);
            if (t.from == s.from && t.to == s.to && t.promo == s.promo) return m;
        }
        return Move::NO_MOVE;
    }

    // Classify the position right after a move by `mover`: game over and why, else None.
    static EndReason terminal(const Board& b, bool playerJustMoved, bool fiftyOn, bool repetition) {
        bool anyMove = movegen::anylegalmoves(b);
        if (!anyMove) {
            if (b.inCheck()) return playerJustMoved ? EndReason::Checkmate : EndReason::OpponentMates;
            return EndReason::Stalemate;
        }
        if (fiftyOn && b.halfMoveClock() >= 100) return EndReason::FiftyMoves;
        if (insufficientMaterialJs(b)) return EndReason::Insufficient;
        if (repetition) return EndReason::Repetition;
        return EndReason::None;
    }

    size_t planSize() const { return plan_.size(); }

    // Switch to first-refutation mode after an exact search ran out of nodes.
    void degrade() {
        firstRefutation = true;
        aborted = false;
        nodes = 0;
        memo_.clear();
    }

    struct LineMove {
        std::string uci, san;
        bool player;
    };

    // Plays out the line both sides choose (player follows the plan, opponent its best
    // reply) and returns the moves and how the game ends. Call after setPlan().
    EndReason principalLine(const Board& start, std::vector<LineMove>& out) {
        Board b = start;
        line_.assign(1, b.hash());
        out.clear();
        for (size_t i = 0; i < plan_.size(); ++i) {
            Move m = findPremove(b, plan_[i]);
            if (m == Move::NO_MOVE) return EndReason::PremoveIllegal;
            out.push_back({uciOf(m), uci::moveToSan(b, m), true});
            b.makeMove<true>(m);
            line_.push_back(b.hash());
            EndReason e = terminal(b, true, fiftyRelevant_, repeatedThrice(b));
            if (e != EndReason::None) return e;
            if (i + 1 == plan_.size()) return EndReason::OutOfPremoves;
            Move r = bestReply(b, i + 1, nullptr);
            if (r == Move::NO_MOVE) return EndReason::None;  // aborted
            out.push_back({uciOf(r), uci::moveToSan(b, r), false});
            b.makeMove<true>(r);
            line_.push_back(b.hash());
            e = terminal(b, false, fiftyRelevant_, repeatedThrice(b));
            if (e != EndReason::None) return e;
        }
        return EndReason::OutOfPremoves;
    }

   private:
    std::vector<PlanStep> plan_;
    Board start_;
    std::unordered_map<uint64_t, LineValue> memo_;
    std::vector<uint64_t> line_;  // position hashes along the current line (history mode)
    bool historyMode_ = false, fiftyRelevant_ = false;

    static uint64_t mix(uint64_t x) {
        x += 0x9e3779b97f4a7c15ULL;
        x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ULL;
        x = (x ^ (x >> 27)) * 0x94d049bb133111ebULL;
        return x ^ (x >> 31);
    }

    uint64_t memoKey(const Board& b, size_t i) const {
        uint64_t k = b.hash() ^ mix(0x51ed + i);
        if (fiftyRelevant_) k ^= mix(0x77aa00 + b.halfMoveClock());
        if (historyMode_) {
            // positions since the last irreversible move matter for repetition
            uint64_t h = 0;
            size_t back = std::min<size_t>(line_.size(), (size_t)b.halfMoveClock() + 1);
            for (size_t j = line_.size() - back; j < line_.size(); ++j) h += mix(line_[j]);
            k ^= mix(h + 0x3ee7);
        }
        return k;
    }

    bool repeatedThrice(const Board& b) const {
        if (!historyMode_) return false;
        uint64_t h = b.hash();
        int c = 0;
        for (uint64_t x : line_)
            if (x == h) c++;
        return c >= 3;
    }

    LineValue afterWhiteMove(Board& b, size_t i) {
        EndReason e = terminal(b, true, fiftyRelevant_, repeatedThrice(b));
        if (e == EndReason::Checkmate) return {false, 1, e};
        if (e != EndReason::None) return {true, 1, e};
        if (i + 1 == plan_.size()) return {true, 1, EndReason::OutOfPremoves};
        LineValue best;
        bool have = false;
        Movelist ml;
        movegen::legalmoves(ml, b);
        for (const Move& r : ml) {
            LineValue v = afterBlackMove(b, r, i + 1);
            if (aborted) return v;
            if (!have || blackPrefers(v, best)) {
                best = v;
                have = true;
            }
            if (best.refuted && (best.plies == 1 || firstRefutation)) break;  // good enough
        }
        best.plies += 1;
        return best;
    }

    // Value (plies counted from just before black's move) of black playing r.
    LineValue afterBlackMove(Board& b, const Move& r, size_t next) {
        b.makeMove<true>(r);
        line_.push_back(b.hash());
        LineValue v;
        EndReason e = terminal(b, false, fiftyRelevant_, repeatedThrice(b));
        if (e != EndReason::None) {
            v = {true, 1, e};
        } else {
            v = evalWhite(b, next);
            v.plies += 1;
        }
        line_.pop_back();
        b.unmakeMove(r);
        return v;
    }

    bool placementsRepeat(const Board& start) const {
        char sq[64];
        for (int s = 0; s < 64; ++s) {
            Piece p = start.at(Square(s));
            sq[s] = (p != Piece::NONE && p.color() == start.sideToMove()) ? "PNBRQK"[(int)p.type()] : '.';
        }
        std::vector<std::string> seen{std::string(sq, 64)};
        for (const PlanStep& s : plan_) {
            char pc = sq[s.from];
            sq[s.from] = '.';
            if (s.promo) pc = " NBRQ"[s.promo];
            if (pc == 'K' && std::abs((s.to & 7) - (s.from & 7)) == 2) {  // castling moves the rook too
                bool king = s.to > s.from;
                int rf = (s.from & ~7) | (king ? 7 : 0), rt = king ? s.to - 1 : s.to + 1;
                sq[rt] = sq[rf];
                sq[rf] = '.';
            }
            sq[s.to] = pc;
            std::string cur(sq, 64);
            for (const std::string& x : seen)
                if (x == cur) return true;
            seen.push_back(cur);
        }
        return false;
    }
};

}  // namespace pm
