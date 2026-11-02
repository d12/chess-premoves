// WebAssembly entry points for the browser game (built with `make wasm`, see README).
// Same API as `pmcore refute`; strings in, JSON strings out.
#include <emscripten/emscripten.h>

#include <string>

#include "../src/refute_api.hpp"

static std::string g_out;

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* pm_version() { return "premove-engine 1"; }

EMSCRIPTEN_KEEPALIVE const char* pm_analyze(const char* fen, const char* premoves, double nodeLimit) {
    g_out = pm::analyzePlan(fen, premoves, (long long)nodeLimit);
    return g_out.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* pm_reply(const char* fen, const char* premoves, const char* history,
                                          double nodeLimit) {
    g_out = pm::chooseReply(fen, premoves, history, (long long)nodeLimit);
    return g_out.c_str();
}

}  // extern "C"
