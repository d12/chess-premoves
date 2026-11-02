// Premove rules for the planning board, matching how chess.com / lichess treat premoves.
//
// A premove is only checked against the moving piece's geometry: the opponent will move in
// between, so its pieces may leave a square, block nothing, or be gone by the time the
// premove executes. Real legality is checked when the premove is played (session.play).
//
// The planning preview is a plain piece placement (not a chess.js position): it can contain
// situations chess.js would reject, e.g. a premove landing on the square the opponent king
// currently occupies (the king will have moved by then).

const FILES = "abcdefgh";
const PIECE_LETTERS = { n: "N", b: "B", r: "R", q: "Q", k: "K", p: "" };

export const squareName = (file, rank) => `${FILES[file]}${rank + 1}`;
const fileOf = (square) => FILES.indexOf(square[0]);
const rankOf = (square) => Number(square[1]) - 1;

/** Map of square -> { type, color } from a FEN (or just its placement field). */
export function parsePlacement(fen) {
  const board = new Map();
  const rows = fen.split(" ")[0].split("/");
  rows.forEach((row, index) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += Number(ch);
      } else {
        board.set(squareName(file, 7 - index), {
          type: ch.toLowerCase(),
          color: ch === ch.toUpperCase() ? "w" : "b",
        });
        file += 1;
      }
    }
  });
  return board;
}

export function placementToFen(board) {
  const rows = [];
  for (let rank = 7; rank >= 0; rank -= 1) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file += 1) {
      const piece = board.get(squareName(file, rank));
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty) row += empty;
      empty = 0;
      row += piece.color === "w" ? piece.type.toUpperCase() : piece.type;
    }
    rows.push(row + (empty || ""));
  }
  return rows.join("/");
}

/** 8x8 rows (rank 8 first) of { type, color } | null, like chess.js board(). */
export function boardRows(fen) {
  const board = parsePlacement(fen);
  return Array.from({ length: 8 }, (_, row) => Array.from({ length: 8 },
    (_, file) => board.get(squareName(file, 7 - row)) ?? null));
}

function geometry(type, color, df, dr) {
  const adf = Math.abs(df);
  const adr = Math.abs(dr);
  switch (type) {
    case "n": return (adf === 1 && adr === 2) || (adf === 2 && adr === 1);
    case "b": return adf === adr && adf > 0;
    case "r": return (df === 0) !== (dr === 0);
    case "q": return (adf === adr && adf > 0) || ((df === 0) !== (dr === 0));
    case "k": return Math.max(adf, adr) === 1;
    default: return false;
  }
}

/**
 * Castling rights still usable in the plan: from the puzzle FEN, dropped once the king or
 * that rook has moved (or been captured) in the premove line.
 */
export function initialCastling(fen) {
  const field = fen.split(" ")[2] ?? "-";
  return new Set(field === "-" ? [] : field.split(""));
}

function castleTargets(board, from, color, castling) {
  const homeRank = color === "w" ? 0 : 7;
  if (from !== squareName(4, homeRank)) return [];
  const out = [];
  const sides = [
    { right: color === "w" ? "K" : "k", rook: squareName(7, homeRank), to: squareName(6, homeRank) },
    { right: color === "w" ? "Q" : "q", rook: squareName(0, homeRank), to: squareName(2, homeRank) },
  ];
  for (const side of sides) {
    const rook = board.get(side.rook);
    if (castling.has(side.right) && rook?.type === "r" && rook.color === color) {
      out.push(side.to);
    }
  }
  return out;
}

/** Every premove the piece on `from` may queue: [{ from, to, promotion? }]. */
export function premoveTargets(board, from, color, castling = new Set()) {
  const piece = board.get(from);
  if (!piece || piece.color !== color) return [];
  const f0 = fileOf(from);
  const r0 = rankOf(from);
  const targets = [];
  for (let file = 0; file < 8; file += 1) {
    for (let rank = 0; rank < 8; rank += 1) {
      const df = file - f0;
      const dr = rank - r0;
      if (df === 0 && dr === 0) continue;
      let ok;
      if (piece.type === "p") {
        const dir = color === "w" ? 1 : -1;
        const startRank = color === "w" ? 1 : 6;
        ok = (df === 0 && (dr === dir || (dr === 2 * dir && r0 === startRank)))
          || (Math.abs(df) === 1 && dr === dir);
      } else {
        ok = geometry(piece.type, color, df, dr);
      }
      if (ok) targets.push(squareName(file, rank));
    }
  }
  if (piece.type === "k") targets.push(...castleTargets(board, from, color, castling));

  const moves = [];
  const lastRank = color === "w" ? 7 : 0;
  for (const to of targets) {
    if (piece.type === "p" && rankOf(to) === lastRank) {
      for (const promotion of ["q", "r", "b", "n"]) moves.push({ from, to, promotion });
    } else {
      moves.push({ from, to });
    }
  }
  return moves;
}

function isCastle(piece, from, to) {
  return piece.type === "k" && Math.abs(fileOf(to) - fileOf(from)) === 2;
}

/** Short algebraic notation for a premove as seen on the planning board (no +/#). */
export function premoveSan(board, move, color, castling) {
  const piece = board.get(move.from);
  if (isCastle(piece, move.from, move.to)) {
    return fileOf(move.to) === 6 ? "O-O" : "O-O-O";
  }
  const target = board.get(move.to);
  if (piece.type === "p") {
    const capture = fileOf(move.from) !== fileOf(move.to);
    return `${capture ? `${move.from[0]}x` : ""}${move.to}${move.promotion ? `=${move.promotion.toUpperCase()}` : ""}`;
  }
  // disambiguate between same-type pieces that could also premove there
  const rivals = [...board.entries()].filter(([square, other]) => square !== move.from
    && other.type === piece.type && other.color === color
    && premoveTargets(board, square, color, castling).some((m) => m.to === move.to));
  let disambiguation = "";
  if (rivals.length) {
    const sameFile = rivals.some(([square]) => square[0] === move.from[0]);
    const sameRank = rivals.some(([square]) => square[1] === move.from[1]);
    disambiguation = !sameFile ? move.from[0] : !sameRank ? move.from[1] : move.from;
  }
  // landing on the opponent king's square is not a capture: the king will have moved
  const capture = target && target.color !== color && target.type !== "k" ? "x" : "";
  return `${PIECE_LETTERS[piece.type]}${disambiguation}${capture}${move.to}`;
}

/**
 * Preview after a premove is queued: { board, castling, hiddenKing }.
 * The opponent king is never removed: a premove onto its square hides it (it will have
 * moved by then), and it reappears as soon as that piece moves on.
 */
export function applyPremove(preview, move, color) {
  const next = new Map(preview.board);
  const castling = new Set(preview.castling);
  let hiddenKing = preview.hiddenKing ?? null;
  const piece = next.get(move.from);
  const target = next.get(move.to);
  next.delete(move.from);
  if (hiddenKing && hiddenKing.square === move.from) {
    next.set(move.from, hiddenKing.piece);
    hiddenKing = null;
  }
  if (target && target.type === "k" && target.color !== color) {
    hiddenKing = { square: move.to, piece: target };
  }
  next.set(move.to, move.promotion ? { type: move.promotion, color } : piece);
  if (isCastle(piece, move.from, move.to)) {
    const rank = rankOf(move.from);
    const kingSide = fileOf(move.to) === 6;
    const rookFrom = squareName(kingSide ? 7 : 0, rank);
    const rookTo = squareName(kingSide ? 5 : 3, rank);
    next.set(rookTo, next.get(rookFrom));
    next.delete(rookFrom);
  }
  const lost = { e1: "KQ", h1: "K", a1: "Q", e8: "kq", h8: "k", a8: "q" };
  for (const square of [move.from, move.to]) {
    for (const right of lost[square] ?? "") castling.delete(right);
  }
  return { board: next, castling, hiddenKing };
}
