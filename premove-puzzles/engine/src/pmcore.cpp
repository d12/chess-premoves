// pmcore: premove puzzle engine.
//
//   pmcore solve --fen FEN [--max N] [--require QR] [--forbid N] [--deep] [--nodes L]
//   pmcore serve                (one request per stdin line, one JSON reply per line)
//       request: FEN<TAB>max<TAB>require<TAB>forbid<TAB>deep(0/1)<TAB>nodes
//   pmcore gen  [options]       (streams candidate puzzles as JSON lines)
//
// See README for the generator options.
#include <fcntl.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <iostream>
#include <map>
#include <random>
#include <set>
#include <sstream>
#include <unordered_set>

#include "refute_api.hpp"
#include "solver.hpp"

using namespace pm;
using Clock = std::chrono::steady_clock;

static const char* PT_CH = "PNBRQK";

static double msSince(Clock::time_point t) {
    return std::chrono::duration<double, std::milli>(Clock::now() - t).count();
}

static std::string jstr(const std::string& s) {
    std::string o = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\') o += '\\';
        o += c;
    }
    return o + "\"";
}

static uint8_t parseTypes(const std::string& s) {
    uint8_t m = 0;
    for (char c : s) {
        switch (toupper(c)) {
            case 'P': m |= 1 << 0; break;
            case 'N': m |= 1 << 1; break;
            case 'B': m |= 1 << 2; break;
            case 'R': m |= 1 << 3; break;
            case 'Q': m |= 1 << 4; break;
            case 'K': m |= 1 << 5; break;
        }
    }
    return m;
}

static std::string typesStr(int mask) {
    std::string s;
    for (int i = 5; i >= 0; --i)
        if (mask & (1 << i)) s += PT_CH[i];
    return s;
}

// --------------------------------------------------------------------------- position helpers
static bool validPuzzlePos(const Board& b, std::string* why = nullptr) {
    auto fail = [&](const char* w) {
        if (why) *why = w;
        return false;
    };
    if (b.pieces(PieceType::KING, Color::WHITE).count() != 1 || b.pieces(PieceType::KING, Color::BLACK).count() != 1)
        return fail("need exactly one king per side");
    if (b.sideToMove() != Color::WHITE) return fail("white must be to move");
    if (attacks::king(b.kingSq(Color::WHITE)) & b.pieces(PieceType::KING, Color::BLACK)) return fail("kings adjacent");
    Bitboard back = Rank(Rank::RANK_1).bb() | Rank(Rank::RANK_8).bb();
    if (b.pieces(PieceType::PAWN) & back) return fail("pawn on back rank");
    if (b.isAttacked(b.kingSq(Color::BLACK), Color::WHITE)) return fail("black is in check with white to move");
    if (b.pieces(PieceType::PAWN, Color::WHITE).count() > 8 || b.pieces(PieceType::PAWN, Color::BLACK).count() > 8)
        return fail("too many pawns");
    return true;
}

static std::string materialSig(const Board& b) {
    std::string w = "K", k = "K";
    const PieceType order[] = {PieceType::QUEEN, PieceType::ROOK, PieceType::BISHOP, PieceType::KNIGHT, PieceType::PAWN};
    const char* ch = "QRBNP";
    for (int i = 0; i < 5; ++i) {
        w += std::string(b.pieces(order[i], Color::WHITE).count(), ch[i]);
        k += std::string(b.pieces(order[i], Color::BLACK).count(), ch[i]);
    }
    return w + "-" + k;
}

// --------------------------------------------------------------------------- analysis
struct Request {
    std::string fen;
    int maxN = 8;
    uint8_t require = 0, forbid = 0;
    bool deep = false;  // necessity + dud-piece analysis
    int64_t nodes = 20'000'000;
};

struct Result {
    bool valid = true, aborted = false;
    std::string error;
    int n = 0, closed = 0;
    std::vector<Move> plan;
    std::string json;
};

static std::string placementOf(const std::string& fen) { return fen.substr(0, fen.find(' ')); }

// Solve only (fast path used by the generator before full analysis).
static int quickSolve(Solver& S, const Board& root, int maxN, int* closedOut, bool* aborted) {
    S.resetCounters();
    S.clearOpenLoop();
    int d0 = S.closedDistance(root, maxN);
    *closedOut = d0;
    if (d0 <= 0) {
        *aborted = (d0 < 0);
        return 0;
    }
    int n = S.solve(root, maxN, d0);
    *aborted = (n < 0);
    return n < 0 ? 0 : n;
}

static std::string analyze(Solver& S, const Request& rq, Result& R) {
    auto t0 = Clock::now();
    std::ostringstream o;
    Board root;
    if (!root.setFen(rq.fen)) {
        R.valid = false;
        R.error = "bad FEN";
    }
    std::string why;
    if (R.valid && !validPuzzlePos(root, &why)) {
        R.valid = false;
        R.error = why;
    }
    o << "{\"fen\":" << jstr(rq.fen);
    if (!R.valid) {
        o << ",\"ok\":false,\"error\":" << jstr(R.error) << "}";
        return o.str();
    }
    o << ",\"material\":" << jstr(materialSig(root));
    S.nodeLimit = rq.nodes;
    S.requireMask = rq.require;
    S.forbidMask = rq.forbid;
    S.resetCounters();
    S.clearOpenLoop();
    int d0 = S.closedDistance(root, rq.maxN);
    R.closed = d0;
    int n = 0;
    if (d0 > 0) n = S.solve(root, rq.maxN, d0);
    if (d0 < 0 || n < 0) {
        R.aborted = true;
        o << ",\"ok\":false,\"aborted\":true,\"nodes\":" << S.nodes << ",\"ms\":" << (int)msSince(t0) << "}";
        return o.str();
    }
    R.n = n;
    o << ",\"closed\":" << d0;
    if (n == 0) {
        o << ",\"ok\":false,\"n\":null,\"nodes\":" << S.nodes << ",\"ms\":" << (int)msSince(t0) << "}";
        return o.str();
    }
    R.plan.assign(S.plan, S.plan + n);
    std::vector<StepInfo> steps;
    int width = 0;
    S.analyzePlan(root, R.plan, steps, width);
    int firstMoves = 0;
    S.resetCounters();
    uint64_t sols = S.countPlans(root, n, &firstMoves, 5000);
    bool countCapped = S.aborted || sols >= 5000;

    o << ",\"ok\":true,\"n\":" << n << ",\"premove_tax\":" << (n - d0);
    o << ",\"solutions\":" << sols << ",\"solutions_capped\":" << (countCapped ? "true" : "false");
    o << ",\"first_moves\":" << firstMoves << ",\"max_width\":" << width;
    o << ",\"plan_uci\":[";
    for (int i = 0; i < n; ++i) o << (i ? "," : "") << jstr(steps[i].uci);
    o << "],\"plan_san\":[";
    for (int i = 0; i < n; ++i) o << (i ? "," : "") << jstr(steps[i].san);
    o << "],\"steps\":[";
    int moved = 0, matePieces = 0, quiet = 0, offers = 0, earlyMates = 0;
    // distinct pieces moved: follow squares
    std::vector<int> movers;  // origin squares of distinct pieces
    std::map<int, int> at;    // current square -> piece id
    for (int i = 0; i < n; ++i) {
        const StepInfo& s = steps[i];
        moved |= 1 << s.piece;
        matePieces |= s.mate_pieces;
        if (s.checks == 0) quiet++;
        if (s.offered) offers++;
        if (i + 1 < n) earlyMates += s.mates;
        int from = R.plan[i].from().index(), to = R.plan[i].to().index();
        int id;
        if (at.count(from)) {
            id = at[from];
            at.erase(from);
        } else {
            id = (int)movers.size();
            movers.push_back(from);
        }
        at[to] = id;
        o << (i ? "," : "") << "{\"san\":" << jstr(s.san) << ",\"piece\":\"" << PT_CH[s.piece] << "\",\"belief\":" << s.belief
          << ",\"checks\":" << s.checks << ",\"captures\":" << s.captures << ",\"mates\":" << s.mates
          << ",\"offered\":" << s.offered << ",\"branches\":" << s.branches << ",\"mate_pieces\":" << jstr(typesStr(s.mate_pieces))
          << "}";
    }
    o << "],\"moved_types\":" << jstr(typesStr(moved)) << ",\"distinct_movers\":" << movers.size()
      << ",\"mate_pieces\":" << jstr(typesStr(matePieces)) << ",\"quiet_moves\":" << quiet << ",\"offers\":" << offers
      << ",\"early_mates\":" << earlyMates;

    if (rq.deep) {
        // Necessity: can a shortest plan avoid moving this piece type?
        int necessary = 0;
        for (int pt = 0; pt < 6; ++pt) {
            if (!(moved & (1 << pt))) continue;
            uint8_t savedF = S.forbidMask, savedR = S.requireMask;
            S.forbidMask = savedF | (1 << pt);
            S.requireMask = savedR & ~(1 << pt);
            S.resetCounters();
            S.clearOpenLoop();
            int alt = S.solve(root, n, d0);
            if (alt == 0) necessary |= 1 << pt;
            S.forbidMask = savedF;
            S.requireMask = savedR;
        }
        o << ",\"necessary_types\":" << jstr(typesStr(necessary));
        // Dud analysis: remove each non-king piece, re-solve.
        o << ",\"removals\":[";
        bool first = true;
        Bitboard occ = root.occ() & ~root.pieces(PieceType::KING);
        while (occ) {
            Square sq(occ.pop());
            Piece pc = root.at(sq);
            Board b2 = root;
            // build FEN without this piece
            std::string pl = placementOf(root.getFen());
            char grid[64];
            {
                int idx = 56;
                for (char c : pl) {
                    if (c == '/') {
                        idx -= 16;
                        continue;
                    }
                    if (isdigit(c)) {
                        for (int k = 0; k < c - '0'; ++k) grid[idx++] = '.';
                    } else
                        grid[idx++] = c;
                }
            }
            grid[sq.index()] = '.';
            std::string f2;
            for (int r = 7; r >= 0; --r) {
                int e = 0;
                for (int f = 0; f < 8; ++f) {
                    char c = grid[r * 8 + f];
                    if (c == '.')
                        e++;
                    else {
                        if (e) f2 += char('0' + e);
                        e = 0;
                        f2 += c;
                    }
                }
                if (e) f2 += char('0' + e);
                if (r) f2 += '/';
            }
            f2 += " w - - 0 1";
            std::string res;
            int n2 = -2;
            if (!b2.setFen(f2) || !validPuzzlePos(b2))
                res = "illegal";
            else {
                S.forbidMask = rq.forbid;
                S.requireMask = 0;
                int c2 = 0;
                bool ab = false;
                n2 = quickSolve(S, b2, n, &c2, &ab);
                // essential: without it, no premove mate within n moves
                // redundant: still solvable in exactly n; obstacle: removal makes it shorter
                if (ab)
                    res = "unknown";
                else if (n2 == 0)
                    res = "essential";
                else if (n2 == n)
                    res = "redundant";
                else
                    res = "obstacle";
                S.requireMask = rq.require;
            }
            const char* color = (pc.color() == Color::WHITE) ? "w" : "b";
            o << (first ? "" : ",") << "{\"square\":\"" << std::string(sq) << "\",\"piece\":\""
              << PT_CH[pti(pc.type())] << "\",\"color\":\"" << color << "\",\"result\":\"" << res << "\"";
            if (n2 > 0) o << ",\"n\":" << n2;
            o << "}";
            first = false;
        }
        o << "]";
    }
    o << ",\"nodes\":" << S.nodes << ",\"ms\":" << (int)msSince(t0) << "}";
    return o.str();
}

// --------------------------------------------------------------------------- Stockfish client
class Stockfish {
   public:
    bool start(const std::string& path, int threads = 1) {
        int in[2], out[2];
        if (pipe(in) || pipe(out)) return false;
        pid = fork();
        if (pid == 0) {
            dup2(in[0], 0);
            dup2(out[1], 1);
            int devnull = open("/dev/null", O_WRONLY);
            dup2(devnull, 2);
            close(in[1]);
            close(out[0]);
            execl(path.c_str(), path.c_str(), (char*)nullptr);
            _exit(127);
        }
        close(in[0]);
        close(out[1]);
        wr = fdopen(in[1], "w");
        rd = fdopen(out[0], "r");
        send("uci");
        if (!waitFor("uciok")) return false;
        send("setoption name Threads value " + std::to_string(threads));
        send("setoption name Hash value 16");
        send("isready");
        return waitFor("readyok");
    }
    ~Stockfish() {
        if (wr) {
            send("quit");
            fclose(wr);
        }
        if (rd) fclose(rd);
        if (pid > 0) waitpid(pid, nullptr, 0);
    }
    // Returns mate distance for side to move (>0), 0 if no mate found within budget.
    int mateScore(const std::string& fen, int nodes) {
        send("ucinewgame");
        send("position fen " + fen);
        send("go nodes " + std::to_string(nodes));
        char buf[4096];
        int mate = 0;
        while (fgets(buf, sizeof buf, rd)) {
            std::string l(buf);
            if (l.rfind("bestmove", 0) == 0) break;
            auto p = l.find(" score ");
            if (p != std::string::npos) {
                if (l.compare(p + 7, 5, "mate ") == 0)
                    mate = atoi(l.c_str() + p + 12);
                else
                    mate = 0;
            }
        }
        return mate > 0 ? mate : 0;
    }

   private:
    pid_t pid = -1;
    FILE *wr = nullptr, *rd = nullptr;
    void send(const std::string& s) {
        fputs((s + "\n").c_str(), wr);
        fflush(wr);
    }
    bool waitFor(const std::string& tok) {
        char buf[4096];
        while (fgets(buf, sizeof buf, rd))
            if (std::string(buf).rfind(tok, 0) == 0) return true;
        return false;
    }
};

// --------------------------------------------------------------------------- generator
struct Spec {
    std::string white, black;  // non-king pieces, e.g. "QR", "PP"
    double weight = 1;
};

static bool parseSpec(const std::string& s, Spec& sp) {
    // "KQR-KPP" or "KQRvKPP" (optional :weight)
    std::string t = s;
    double w = 1;
    auto c = t.find(':');
    if (c != std::string::npos) {
        w = atof(t.c_str() + c + 1);
        t = t.substr(0, c);
    }
    auto d = t.find_first_of("-v");
    if (d == std::string::npos) return false;
    std::string a = t.substr(0, d), b = t.substr(d + 1);
    if (a.empty() || b.empty() || toupper(a[0]) != 'K' || toupper(b[0]) != 'K') return false;
    sp.white.clear();
    sp.black.clear();
    for (size_t i = 1; i < a.size(); ++i) sp.white += (char)toupper(a[i]);
    for (size_t i = 1; i < b.size(); ++i) sp.black += (char)toupper(b[i]);
    for (char ch : sp.white + sp.black)
        if (!strchr("QRBNP", ch)) return false;
    sp.weight = w;
    return true;
}

static std::string specKey(const std::string& white, const std::string& black) {
    auto norm = [](std::string s) {
        std::string o;
        for (char c : std::string("QRBNP"))
            for (char x : s)
                if (x == c) o += c;
        return o;
    };
    return "K" + norm(white) + "-K" + norm(black);
}

struct Grid {
    char c[64];
    std::string fen() const {
        std::string f;
        for (int r = 7; r >= 0; --r) {
            int e = 0;
            for (int x = 0; x < 8; ++x) {
                char ch = c[r * 8 + x];
                if (ch == '.')
                    e++;
                else {
                    if (e) f += char('0' + e);
                    e = 0;
                    f += ch;
                }
            }
            if (e) f += char('0' + e);
            if (r) f += '/';
        }
        return f + " w - - 0 1";
    }
    std::string sig() const {
        std::string w, b;
        for (char ch : c) {
            if (ch == '.' || ch == 'K' || ch == 'k') continue;
            if (isupper(ch))
                w += ch;
            else
                b += (char)toupper(ch);
        }
        return specKey(w, b);
    }
    bool hasPawns() const {
        for (char ch : c)
            if (ch == 'P' || ch == 'p') return true;
        return false;
    }
    // canonical form under board symmetries (D4 without pawns, file-mirror with pawns)
    std::string canonical() const {
        std::string best;
        int nsym = hasPawns() ? 2 : 8;
        for (int s = 0; s < nsym; ++s) {
            std::string t(64, '.');
            for (int sq = 0; sq < 64; ++sq) {
                int f = sq & 7, r = sq >> 3;
                if (s & 1) f = 7 - f;
                if (s & 2) r = 7 - r;
                if (s & 4) std::swap(f, r);
                t[r * 8 + f] = c[sq];
            }
            if (best.empty() || t < best) best = t;
        }
        return best;
    }
};

struct GenOpts {
    int minN = 3, maxN = 6;
    std::vector<Spec> specs;
    uint8_t require = 0, strict = 0;
    double seconds = 60;
    int64_t count = 0;  // stop after this many candidates (0 = unlimited)
    uint64_t seed = 1;
    std::string sfPath;
    int sfNodes = 4000;
    double mutate = 0.6;
    int64_t nodes = 3'000'000;   // full budget (analysis, retries)
    int64_t budget = 100'000;    // first-pass budget without Stockfish
    int64_t missBudget = 20'000; // budget when Stockfish saw no mate
    bool sfPrescreen = false;
    int statsEvery = 10;  // seconds
};

static int chebyshev(int a, int b) { return std::max(std::abs((a & 7) - (b & 7)), std::abs((a >> 3) - (b >> 3))); }

class Generator {
   public:
    Generator(const GenOpts& o, tb::TableSet* tables) : O(o), rng(o.seed), S(21, 19) {
        S.tables = tables;
        for (auto& s : O.specs) allowed.insert(specKey(s.white, s.black));
    }

    void run() {
        if (!O.sfPath.empty()) {
            sfOk = sf.start(O.sfPath);
            if (!sfOk) std::cerr << "warning: could not start stockfish, screening disabled\n";
        }
        auto t0 = Clock::now(), lastStats = t0;
        std::vector<double> w;
        for (auto& s : O.specs) w.push_back(s.weight);
        std::discrete_distribution<int> pickSpec(w.begin(), w.end());
        while (msSince(t0) < O.seconds * 1000 && (O.count == 0 || emitted < O.count)) {
            Grid g;
            bool fromMut = false;
            if (!pool.empty() && uni(rng) < O.mutate) {
                if (!mutateFromPool(g)) continue;
                fromMut = true;
            } else {
                if (!sample(O.specs[pickSpec(rng)], g)) continue;
            }
            evaluate(g, fromMut);
            if (msSince(lastStats) > O.statsEvery * 1000) {
                lastStats = Clock::now();
                printStats(msSince(t0));
            }
        }
        printStats(msSince(t0));
    }

   private:
    GenOpts O;
    std::mt19937_64 rng;
    std::uniform_real_distribution<double> uni{0, 1};
    Solver S;
    Stockfish sf;
    bool sfOk = false;
    std::set<std::string> allowed;
    std::unordered_set<std::string> seen;  // canonical placements already evaluated
    struct PoolItem {
        Grid g;
        int n;
    };
    std::vector<PoolItem> pool;
    std::map<std::string, std::vector<int>> cells;  // cell key -> pool indices
    int64_t sampled = 0, dupes = 0, invalid = 0, oneMover = 0, sfReject = 0, noMate = 0, tooShort = 0, aborted = 0,
            solved = 0, emitted = 0, strictReject = 0, mutEmitted = 0, sfBlind = 0, tbRoot = 0, tbReject = 0;
    double solveMs = 0, sfMs = 0, noMateMs = 0, analyzeMs = 0;

    int rnd(int n) { return (int)(rng() % (uint64_t)n); }

    int sampleBlackKing() {
        // Edge-biased: mates live near edges and corners.
        static const double wEdge[4] = {6, 3, 1.6, 1};
        double tot = 0, ws[64];
        for (int s = 0; s < 64; ++s) {
            int f = s & 7, r = s >> 3;
            int d = std::min(std::min(f, 7 - f), std::min(r, 7 - r));
            ws[s] = wEdge[d];
            tot += ws[s];
        }
        double x = uni(rng) * tot;
        for (int s = 0; s < 64; ++s) {
            x -= ws[s];
            if (x <= 0) return s;
        }
        return 63;
    }

    int nearSquare(int center, int maxd, const Grid& g) {
        for (int tries = 0; tries < 40; ++tries) {
            int s = rnd(64);
            if (g.c[s] == '.' && chebyshev(s, center) <= maxd && s != center) return s;
        }
        return -1;
    }
    int anySquare(const Grid& g) {
        for (int tries = 0; tries < 200; ++tries) {
            int s = rnd(64);
            if (g.c[s] == '.') return s;
        }
        return -1;
    }

    bool sample(const Spec& sp, Grid& g) {
        std::fill(g.c, g.c + 64, '.');
        int bk = sampleBlackKing();
        g.c[bk] = 'k';
        int wk = (uni(rng) < 0.75) ? nearSquare(bk, 3, g) : anySquare(g);
        if (wk < 0 || chebyshev(wk, bk) < 2) return false;
        g.c[wk] = 'K';
        for (char p : sp.white) {
            int s;
            if (p == 'P') {
                // pawns on ranks 2-7, often advanced (promotion motifs)
                int r = (uni(rng) < 0.55) ? 5 + rnd(2) : 1 + rnd(6);
                s = r * 8 + rnd(8);
                if (g.c[s] != '.') return false;
            } else {
                double nearP = (p == 'N' || p == 'B') ? 0.7 : 0.45;
                s = (uni(rng) < nearP) ? nearSquare(bk, 3, g) : anySquare(g);
            }
            if (s < 0) return false;
            g.c[s] = p;
        }
        for (char p : sp.black) {
            int s;
            if (p == 'P') {
                // black pawns: often next to own king (self-block / shelter), ranks 2-7
                if (uni(rng) < 0.6)
                    s = nearSquare(bk, 1, g);
                else
                    s = (1 + rnd(6)) * 8 + rnd(8);
                if (s < 0) return false;
                int r = s >> 3;
                if (r == 0 || r == 7) return false;
            } else {
                s = (uni(rng) < 0.7) ? nearSquare(bk, 2, g) : anySquare(g);
            }
            if (s < 0 || g.c[s] != '.') return false;
            g.c[s] = (char)tolower(p);
        }
        return true;
    }

    bool sigAllowed(const Grid& g) { return allowed.count(g.sig()) > 0; }

    bool mutateFromPool(Grid& g) {
        // Pick a cell uniformly (so rare kinds of puzzle get explored as much as common ones),
        // then a member, then apply 1-2 small mutations.
        // Half the time a plain uniform cell pick (diversity); otherwise a 3-way tournament
        // on puzzle length, which pushes the search toward longer puzzles (quality).
        auto pickCell = [&]() {
            auto it = cells.begin();
            std::advance(it, rnd((int)cells.size()));
            return it;
        };
        auto it = pickCell();
        if (uni(rng) < 0.5)
            for (int k = 0; k < 2; ++k) {
                auto c = pickCell();
                if (pool[c->second[0]].n > pool[it->second[0]].n) it = c;
            }
        const auto& members = it->second;
        g = pool[members[rnd((int)members.size())]].g;
        int nm = 1 + (uni(rng) < 0.35);
        for (int k = 0; k < nm; ++k) {
            std::vector<int> occ;
            for (int s = 0; s < 64; ++s)
                if (g.c[s] != '.') occ.push_back(s);
            int op = rnd(10);
            if (op < 5) {  // step a piece (incl. kings) to a neighbouring square
                int s = occ[rnd((int)occ.size())];
                int t = nearSquare(s, 1, g);
                if (t < 0) return false;
                std::swap(g.c[s], g.c[t]);
            } else if (op < 8) {  // relocate a non-king piece anywhere
                std::vector<int> nk;
                for (int s : occ)
                    if (toupper(g.c[s]) != 'K') nk.push_back(s);
                if (nk.empty()) return false;
                int s = nk[rnd((int)nk.size())];
                int t = anySquare(g);
                if (t < 0) return false;
                std::swap(g.c[s], g.c[t]);
            } else if (op == 8) {  // change a white piece's type
                std::vector<int> wp;
                for (int s : occ)
                    if (strchr("QRBN", g.c[s])) wp.push_back(s);
                if (wp.empty()) return false;
                g.c[wp[rnd((int)wp.size())]] = "QRBN"[rnd(4)];
            } else {  // add or remove a black pawn
                std::vector<int> bp;
                for (int s : occ)
                    if (g.c[s] == 'p') bp.push_back(s);
                if (!bp.empty() && uni(rng) < 0.5)
                    g.c[bp[rnd((int)bp.size())]] = '.';
                else {
                    int t = anySquare(g);
                    if (t < 0) return false;
                    g.c[t] = 'p';
                }
            }
        }
        for (int s = 0; s < 8; ++s)
            if (g.c[s] == 'p' || g.c[s] == 'P' || g.c[56 + s] == 'p' || g.c[56 + s] == 'P') return false;
        return sigAllowed(g);
    }

    void addToPool(const Grid& g, int n, const std::string& firstPiece) {
        std::string cell = g.sig() + "|" + std::to_string(n) + "|" + firstPiece;
        cells[cell].push_back((int)pool.size());
        pool.push_back({g, n});
        // keep each cell bounded so no single kind of puzzle dominates the search
        auto& v = cells[cell];
        if (v.size() > 40) v.erase(v.begin() + rnd((int)v.size()));
    }

    void evaluate(const Grid& g, bool fromMut) {
        sampled++;
        std::string canon = g.canonical();
        if (!seen.insert(canon).second) {
            dupes++;
            return;
        }
        Board b;
        std::string fen = g.fen();
        if (!b.setFen(fen) || !validPuzzlePos(b)) {
            invalid++;
            return;
        }
        // Cheap screen 1: if white has a mate in 1 the premove answer is 1 move.
        S.resetCounters();
        S.nodeLimit = O.nodes;
        S.requireMask = 0;
        S.forbidMask = 0;
        if (O.minN > 1) {
            Board tmp = b;
            if (S.mateW(tmp, 1)) {
                oneMover++;
                return;
            }
        }
        // Optional hard pre-screen by Stockfish (fast but drops many genuine puzzles; off by default).
        if (sfOk && O.sfPrescreen) {
            auto t = Clock::now();
            int m = sf.mateScore(fen, O.sfNodes);
            sfMs += msSince(t);
            if (m == 0 || m > O.maxN + 2) {
                sfReject++;
                return;
            }
        }
        // Hybrid screen. Stockfish is very fast at spotting short mates but misses many real
        // premove puzzles at low node counts (measured ~40-60% recall). The exact solver is
        // cheap on real puzzles (p90 ~60k nodes) and expensive only on "no mate" proofs.
        //   Stockfish sees a short mate  -> exact solve with the full budget.
        //   Stockfish sees nothing       -> exact solve with a small budget, which still
        //                                   catches the cheap puzzles Stockfish is blind to.
        //
        // Tablebase shortcut: when exact distance-to-mate tables cover the position, the
        // ordinary mate length is a lookup, so non-candidates are rejected instantly and
        // Stockfish is not needed at all.
        auto t = Clock::now();
        int closed = 0;
        bool ab = false;
        bool sfSaw = false;
        S.requireMask = 0;
        S.nodeLimit = O.budget;
        int tbCap = 0;
        int tbv = S.tables ? S.tables->probe(b, &tbCap) : -1;
        if (tbv >= 0) {
            tbRoot++;
            if ((tbv == 0 && O.maxN <= tbCap) || tbv > O.maxN) {
                noMate++;
                tbReject++;
                return;
            }
            if (tbv > 0) S.nodeLimit = O.nodes;
        }
        if (sfOk && tbv <= 0) {
            auto ts = Clock::now();
            int m = sf.mateScore(fen, O.sfNodes);
            sfMs += msSince(ts);
            sfSaw = (m > 0 && m <= O.maxN + 2);
            S.nodeLimit = sfSaw ? O.nodes : O.missBudget;
        }
        int n = quickSolve(S, b, O.maxN, &closed, &ab);
        if (n >= O.minN && sfOk && !sfSaw) sfBlind++;
        solveMs += msSince(t);
        if (ab) {
            aborted++;
            return;
        }
        if (n == 0) {
            noMate++;
            noMateMs += msSince(t);
            return;
        }
        solved++;
        Move first = S.plan[0];
        std::string firstPiece(1, PT_CH[pti(b.at<PieceType>(first.from()))]);
        if (n >= std::max(2, O.minN - 2)) addToPool(g, n, firstPiece);
        if (n < O.minN) {
            tooShort++;
            return;
        }
        // Piece requirements: some shortest plan must move every required type.
        Request rq;
        rq.fen = fen;
        rq.maxN = n;
        rq.require = O.require;
        rq.deep = true;
        rq.nodes = O.nodes * 4;
        if (O.require) {
            S.requireMask = O.require;
            S.resetCounters();
            S.clearOpenLoop();
            int nr = S.solve(b, n, n);
            S.requireMask = 0;
            if (nr != n) {
                strictReject++;
                return;
            }
        }
        Result R;
        auto ta = Clock::now();
        std::string js = analyze(S, rq, R);
        analyzeMs += msSince(ta);
        if (!R.valid || R.aborted || R.n != n) {
            aborted++;
            return;
        }
        if (O.strict) {
            // every required type must be necessary
            auto p = js.find("\"necessary_types\":\"");
            std::string nec = js.substr(p + 19, js.find('"', p + 19) - p - 19);
            for (int pt = 0; pt < 6; ++pt)
                if ((O.strict & (1 << pt)) && nec.find(PT_CH[pt]) == std::string::npos) {
                    strictReject++;
                    return;
                }
        }
        emitted++;
        if (fromMut) mutEmitted++;
        js.insert(js.size() - 1, std::string(",\"origin\":\"") + (fromMut ? "mutation" : "sample") + "\"");
        std::cout << "{\"type\":\"puzzle\",\"data\":" << js << "}\n" << std::flush;
    }

    void printStats(double ms) {
        std::cout << "{\"type\":\"stats\",\"seconds\":" << (ms / 1000) << ",\"sampled\":" << sampled << ",\"dupes\":" << dupes
                  << ",\"invalid\":" << invalid << ",\"mate_in_1\":" << oneMover << ",\"found_despite_sf_miss\":" << sfBlind << ",\"table_covered\":" << tbRoot << ",\"table_reject\":" << tbReject << ",\"sf_reject\":" << sfReject
                  << ",\"no_mate\":" << noMate << ",\"aborted\":" << aborted << ",\"solved\":" << solved
                  << ",\"too_short\":" << tooShort << ",\"piece_reject\":" << strictReject << ",\"emitted\":" << emitted
                  << ",\"emitted_from_mutation\":" << mutEmitted << ",\"pool\":" << pool.size() << ",\"cells\":" << cells.size()
                  << ",\"solve_ms\":" << (int)solveMs << ",\"sf_ms\":" << (int)sfMs << ",\"no_mate_ms\":" << (int)noMateMs << ",\"analyze_ms\":" << (int)analyzeMs << "}\n"
                  << std::flush;
    }
};

// --------------------------------------------------------------------------- main
static std::string arg(int argc, char** argv, const std::string& name, const std::string& def = "") {
    for (int i = 1; i + 1 < argc; ++i)
        if (name == argv[i]) return argv[i + 1];
    return def;
}
static bool flag(int argc, char** argv, const std::string& name) {
    for (int i = 1; i < argc; ++i)
        if (name == argv[i]) return true;
    return false;
}

static std::vector<std::string> split(const std::string& s, char d) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (c == d) {
            out.push_back(cur);
            cur.clear();
        } else
            cur += c;
    }
    out.push_back(cur);
    return out;
}

int main(int argc, char** argv) {
    std::ios::sync_with_stdio(false);
    signal(SIGPIPE, SIG_DFL);
    if (argc < 2) {
        std::cerr << "usage: pmcore solve|serve|gen ...\n";
        return 2;
    }
    std::string mode = argv[1];
    // Optional distance-to-mate tables (built by tbgen / tbgen_cuda).
    std::string tdir = arg(argc, argv, "--tables");
    if (tdir.empty() && getenv("PPZ_TABLES")) tdir = getenv("PPZ_TABLES");
    tb::TableSet tables(tdir);
    if (mode == "solve") {
        Solver S;
        if (tables.enabled()) S.tables = &tables;
        Request rq;
        rq.fen = arg(argc, argv, "--fen");
        rq.maxN = std::stoi(arg(argc, argv, "--max", "8"));
        rq.require = parseTypes(arg(argc, argv, "--require"));
        rq.forbid = parseTypes(arg(argc, argv, "--forbid"));
        rq.deep = flag(argc, argv, "--deep");
        rq.nodes = std::stoll(arg(argc, argv, "--nodes", "20000000"));
        Result R;
        std::cout << analyze(S, rq, R) << "\n";
        return 0;
    }
    if (mode == "serve") {
        Solver S;
        if (tables.enabled()) S.tables = &tables;
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.empty()) continue;
            auto f = split(line, '\t');
            Request rq;
            rq.fen = f[0];
            if (f.size() > 1 && !f[1].empty()) rq.maxN = std::stoi(f[1]);
            if (f.size() > 2) rq.require = parseTypes(f[2]);
            if (f.size() > 3) rq.forbid = parseTypes(f[3]);
            if (f.size() > 4) rq.deep = f[4] == "1";
            if (f.size() > 5 && !f[5].empty()) rq.nodes = std::stoll(f[5]);
            Result R;
            std::cout << analyze(S, rq, R) << "\n" << std::flush;
        }
        return 0;
    }
    if (mode == "refute") {
        // One request per line, same API as the WebAssembly build:
        //   analyze<TAB>FEN<TAB>premoves[<TAB>nodes]
        //   reply<TAB>FEN<TAB>premoves<TAB>history[<TAB>nodes]
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.empty()) continue;
            auto f = split(line, '\t');
            if (f[0] == "analyze" && f.size() >= 3)
                std::cout << pm::analyzePlan(f[1], f[2], f.size() > 3 ? std::stoll(f[3]) : 2000000) << "\n";
            else if (f[0] == "reply" && f.size() >= 4)
                std::cout << pm::chooseReply(f[1], f[2], f[3], f.size() > 4 ? std::stoll(f[4]) : 2000000) << "\n";
            else
                std::cout << pm::apiError("bad request") << "\n";
            std::cout << std::flush;
        }
        return 0;
    }
    if (mode == "gen") {
        GenOpts o;
        o.minN = std::stoi(arg(argc, argv, "--min", "3"));
        o.maxN = std::stoi(arg(argc, argv, "--max", "6"));
        o.seconds = std::stod(arg(argc, argv, "--seconds", "60"));
        o.count = std::stoll(arg(argc, argv, "--count", "0"));
        o.seed = std::stoull(arg(argc, argv, "--seed", "1"));
        o.require = parseTypes(arg(argc, argv, "--require"));
        o.strict = parseTypes(arg(argc, argv, "--strict"));
        o.require |= o.strict;
        o.sfPath = arg(argc, argv, "--stockfish");
        o.sfNodes = std::stoi(arg(argc, argv, "--sf-nodes", "3000"));
        o.mutate = std::stod(arg(argc, argv, "--mutate", "0.6"));
        o.nodes = std::stoll(arg(argc, argv, "--nodes", "3000000"));
        o.budget = std::stoll(arg(argc, argv, "--budget", "100000"));
        o.sfPrescreen = flag(argc, argv, "--sf-prescreen");
        o.missBudget = std::stoll(arg(argc, argv, "--miss-budget", "20000"));
        o.statsEvery = std::stoi(arg(argc, argv, "--stats-every", "10"));
        std::string specs = arg(argc, argv, "--specs", "KQR-K,KRR-K,KQ-KP,KRB-K,KRN-K,KQB-K,KQN-K,KR-KP,KQ-KPP,KRBN-K");
        for (auto& s : split(specs, ',')) {
            if (s.empty()) continue;
            Spec sp;
            if (!parseSpec(s, sp)) {
                std::cerr << "bad material spec: " << s << "\n";
                return 2;
            }
            // a spec without a required piece type can never satisfy the requirement
            bool ok = true;
            for (int pt = 0; pt < 5; ++pt)
                if ((o.require & (1 << pt)) && sp.white.find(PT_CH[pt]) == std::string::npos) ok = false;
            if (ok) o.specs.push_back(sp);
        }
        if (o.specs.empty()) {
            std::cerr << "no material spec contains all required piece types\n";
            return 2;
        }
        Generator g(o, tables.enabled() ? &tables : nullptr);
        g.run();
        return 0;
    }
    std::cerr << "unknown mode\n";
    return 2;
}
