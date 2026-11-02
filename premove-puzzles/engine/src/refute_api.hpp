// JSON-in/JSON-out API around the refuter, shared by the native CLI (`pmcore refute`)
// and the WebAssembly build (wasm/premove_wasm.cpp) so both behave identically.
//
//   analyzePlan(startFen, "e1c1 d2b2 c1a1")
//     -> {"ok":true,"verdict":"sound"|"refuted"|"unknown","end":"checkmate",
//         "plies":5,"line":[{"uci":"e1c1","san":"Rc1+","player":true},...],"nodes":12}
//
//   chooseReply(startFen, "e1c1 d2b2 c1a1", "e1c1")   (history = moves played so far)
//     -> {"ok":true,"move":"c6b7","refutes":false,"plies":4,"end":"checkmate","nodes":9}
#pragma once

#include <sstream>
#include <string>
#include <vector>

#include "refute.hpp"

namespace pm {

inline std::vector<std::string> splitWords(const std::string& s) {
    std::vector<std::string> out;
    std::istringstream in(s);
    std::string w;
    while (in >> w) out.push_back(w);
    return out;
}

inline std::string jsonStr(const std::string& s) {
    std::string o = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\') o += '\\';
        o += c;
    }
    return o + "\"";
}

inline std::string apiError(const std::string& msg) { return "{\"ok\":false,\"error\":" + jsonStr(msg) + "}"; }

inline bool loadPlan(const std::string& planText, std::vector<PlanStep>& plan, std::string& err) {
    for (const std::string& u : splitWords(planText)) {
        PlanStep s;
        if (!parseUci(u, s)) {
            err = "bad premove '" + u + "'";
            return false;
        }
        plan.push_back(s);
    }
    if (plan.empty()) {
        err = "empty premove list";
        return false;
    }
    return true;
}

inline std::string analyzePlan(const std::string& fen, const std::string& planText, long long nodeLimit) {
    Board start;
    if (!start.setFen(fen)) return apiError("bad FEN");
    std::vector<PlanStep> plan;
    std::string err;
    if (!loadPlan(planText, plan, err)) return apiError(err);
    Refuter R;
    R.nodeLimit = nodeLimit;
    R.setPlan(start, plan);
    Board b = start;
    LineValue v = R.evalWhite(b, 0);
    int64_t prior = 0;  // nodes spent on an exact attempt that ran out of budget
    if (R.aborted) {    // too big to find the fastest refutation: settle for any refutation
        prior = R.nodes;
        R.degrade();
        v = R.evalWhite(b, 0);
    }
    std::ostringstream o;
    if (R.aborted) {
        o << "{\"ok\":true,\"verdict\":\"unknown\",\"nodes\":" << prior + R.nodes << "}";
        return o.str();
    }
    std::vector<Refuter::LineMove> line;
    EndReason e = R.principalLine(start, line);
    o << "{\"ok\":true,\"verdict\":\"" << (v.refuted ? "refuted" : "sound") << "\",\"end\":\"" << endName(e)
      << "\",\"plies\":" << v.plies << ",\"exact\":" << (R.firstRefutation ? "false" : "true") << ",\"line\":[";
    for (size_t i = 0; i < line.size(); ++i)
        o << (i ? "," : "") << "{\"uci\":" << jsonStr(line[i].uci) << ",\"san\":" << jsonStr(line[i].san)
          << ",\"player\":" << (line[i].player ? "true" : "false") << "}";
    o << "],\"nodes\":" << prior + R.nodes << "}";
    return o.str();
}

inline std::string chooseReply(const std::string& fen, const std::string& planText, const std::string& historyText,
                               long long nodeLimit) {
    Board start;
    if (!start.setFen(fen)) return apiError("bad FEN");
    std::vector<PlanStep> plan;
    std::string err;
    if (!loadPlan(planText, plan, err)) return apiError(err);
    std::vector<std::string> history = splitWords(historyText);
    if (history.size() % 2 != 1) return apiError("history must end with a player move");
    Refuter R;
    R.nodeLimit = nodeLimit;
    R.setPlan(start, plan);
    Board b = start;
    if (!R.replay(b, history)) return apiError("history contains an illegal move");
    size_t next = (history.size() + 1) / 2;  // premoves already played
    LineValue v;
    Move r = R.bestReply(b, next, &v);
    int64_t used = R.nodes;
    if (R.aborted) {
        R.degrade();
        r = R.bestReply(b, next, &v);
        used += R.nodes;
    }
    std::ostringstream o;
    if (R.aborted) {
        o << "{\"ok\":true,\"move\":null,\"verdict\":\"unknown\",\"nodes\":" << used << "}";
        return o.str();
    }
    if (r == Move::NO_MOVE) return apiError("no legal reply");
    o << "{\"ok\":true,\"move\":" << jsonStr(uciOf(r)) << ",\"san\":" << jsonStr(uci::moveToSan(b, r))
      << ",\"refutes\":" << (v.refuted ? "true" : "false") << ",\"end\":\"" << endName(v.end)
      << "\",\"plies\":" << v.plies << ",\"exact\":" << (R.firstRefutation ? "false" : "true")
      << ",\"nodes\":" << used << "}";
    return o.str();
}

}  // namespace pm
