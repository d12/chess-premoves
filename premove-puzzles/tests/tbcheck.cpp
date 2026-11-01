// Cross-check distance-to-mate tables against the search-based mate prover, and full
// premove solutions with tables on vs off.
//   g++ -O2 -std=c++17 -o tbcheck tests/tbcheck.cpp && ./tbcheck TABLE_DIR [positions] [RBN,QR,...]
#include <iostream>
#include <random>

#include "../engine/src/solver.hpp"

using namespace pm;

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: tbcheck TABLE_DIR [positions]\n";
        return 2;
    }
    tb::TableSet tables(argv[1]);
    int count = argc > 2 ? atoi(argv[2]) : 300;
    std::vector<std::string> mats = {"QR", "RB", "RN", "QN", "QB", "RR", "QQ"};
    if (argc > 3) mats = tb::splitList(argv[3]);  // e.g. "RBN"
    std::mt19937_64 rng(42);
    Solver plain(20, 18), withTb(20, 18);
    withTb.tables = &tables;
    int checkedD = 0, badD = 0, checkedN = 0, badN = 0, badCount = 0;
    while (checkedD < count) {
        std::string w = mats[rng() % mats.size()];
        char grid[64];
        std::fill(grid, grid + 64, '.');
        auto put = [&](char c) {
            int s;
            do s = int(rng() % 64);
            while (grid[s] != '.');
            grid[s] = c;
            return s;
        };
        // bias the black king toward the edge so plenty of positions have short mates
        int bk;
        do bk = int(rng() % 64);
        while (grid[bk] != '.' || (rng() % 3 && (bk & 7) && (bk & 7) != 7 && (bk >> 3) && (bk >> 3) != 7));
        grid[bk] = 'k';
        put('K');
        for (char c : w) put(c);
        std::string fen;
        for (int r = 7; r >= 0; --r) {
            int e = 0;
            for (int f = 0; f < 8; ++f) {
                char c = grid[r * 8 + f];
                if (c == '.') e++;
                else {
                    if (e) fen += char('0' + e);
                    e = 0;
                    fen += c;
                }
            }
            if (e) fen += char('0' + e);
            if (r) fen += '/';
        }
        fen += " w - - 0 1";
        Board b(fen);
        if (attacks::king(b.kingSq(Color::WHITE)) & b.pieces(PieceType::KING, Color::BLACK)) continue;
        if (b.isAttacked(b.kingSq(Color::BLACK), Color::WHITE)) continue;
        const int K = 5;
        plain.resetCounters();
        plain.nodeLimit = 50'000'000;
        int d1 = plain.closedDistance(b, K);
        int cap = 0;
        int v = tables.probe(b, &cap);
        if (v < 0) {
            std::cerr << "no table for " << fen << "\n";
            return 1;
        }
        int d2 = (v > 0 && v <= K) ? v : 0;
        checkedD++;
        if (d1 != d2) {
            badD++;
            std::cout << "DTM MISMATCH " << fen << " search=" << d1 << " table=" << v << "\n";
        }
        if (d1 > 0 && checkedN < count / 3) {
            plain.resetCounters();
            plain.clearOpenLoop();
            withTb.resetCounters();
            withTb.clearOpenLoop();
            withTb.nodeLimit = plain.nodeLimit;
            int n1 = plain.solve(b, 5, d1), n2 = withTb.solve(b, 5, d2);
            checkedN++;
            if (n1 != n2) {
                badN++;
                std::cout << "PREMOVE MISMATCH " << fen << " plain=" << n1 << " tables=" << n2 << "\n";
            } else if (n1 > 0) {
                int f1 = 0, f2 = 0;
                plain.resetCounters();
                withTb.resetCounters();
                uint64_t c1 = plain.countPlans(b, n1, &f1), c2 = withTb.countPlans(b, n2, &f2);
                if (c1 != c2 || f1 != f2) {
                    badCount++;
                    std::cout << "COUNT MISMATCH " << fen << " " << c1 << " vs " << c2 << "\n";
                }
            }
        }
    }
    std::cout << "distance-to-mate checks: " << checkedD << " mismatches: " << badD << "\n";
    std::cout << "premove solves: " << checkedN << " mismatches: " << badN << " count mismatches: " << badCount << "\n";
    return (badD || badN || badCount) ? 1 : 0;
}
