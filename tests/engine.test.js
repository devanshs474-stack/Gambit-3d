/**
 * engine.test.js — Node test suite for the chess engine.
 * Run:  node tests/engine.test.js
 *
 * 1. Perft: exhaustive leaf-node counts vs published reference values
 *    (https://www.chessprogramming.org/Perft_Results). These positions
 *    collectively exercise castling legality, en-passant pins, promotions,
 *    underpromotions and check evasions.
 * 2. Scenario tests for every special rule and draw condition.
 */
var CE = require('../js/engine.js');
var Engine = CE.Engine;

var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

function quiet(e) { e.verbose = false; return e; }
function moveBySquares(e, from, to, promo) {
  var list = e.findMoves(sq(from), sq(to));
  if (!list.length) throw new Error('No legal move ' + from + '->' + to + ' in ' + e.fen());
  if (list.length === 1) return e.makeMove(list[0]);
  var m = list.filter(function (x) { return x.promotion === (promo || 'Q'); });
  if (!m.length) throw new Error('No promotion ' + promo);
  return e.makeMove(m[0]);
}
function sq(name) {
  var f = 'abcdefgh'.indexOf(name[0]);
  var r = 8 - parseInt(name[1], 10);
  return r * 8 + f;
}

// ---------------------------------------------------------------------------
section('Perft (move generation correctness)');

var perftCases = [
  ['startpos', CE.START_FEN, [20, 400, 8902, 197281]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['pos3 (ep pins)', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['pos4 (promos)', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['pos5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ['pos6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]]
];

perftCases.forEach(function (tc) {
  var e = quiet(new Engine()); e.loadFen(tc[1]);
  var all = true;
  for (var d = 1; d <= tc[2].length; d++) {
    var got = e.perft(d);
    if (got !== tc[2][d - 1]) {
      all = false;
      console.log('    depth ' + d + ': got ' + got + ', expected ' + tc[2][d - 1]);
    }
  }
  ok(all, 'perft ' + tc[0]);
});

// ---------------------------------------------------------------------------
section('Checkmate: Fool\'s mate & Scholar\'s mate');

(function () {
  var e = new Engine();
  moveBySquares(e, 'f2', 'f3'); moveBySquares(e, 'e7', 'e5');
  moveBySquares(e, 'g2', 'g4'); moveBySquares(e, 'd8', 'h4');
  var s = e.getGameStatus();
  ok(s.over && s.reason === 'checkmate' && s.result === '0-1', "fool's mate detected");
  ok(e.history[e.history.length - 1].san === 'Qh4#', "SAN 'Qh4#'");
})();

(function () {
  var e = new Engine();
  moveBySquares(e, 'e2', 'e4'); moveBySquares(e, 'e7', 'e5');
  moveBySquares(e, 'f1', 'c4'); moveBySquares(e, 'b8', 'c6');
  moveBySquares(e, 'd1', 'h5'); moveBySquares(e, 'g8', 'f6');
  moveBySquares(e, 'h5', 'f7');
  var s = e.getGameStatus();
  ok(s.over && s.reason === 'checkmate' && s.result === '1-0', "scholar's mate detected");
  ok(e.history[e.history.length - 1].san === 'Qxf7#', "SAN 'Qxf7#'");
})();

// ---------------------------------------------------------------------------
section('Stalemate');

(function () {
  var e = new Engine();
  e.loadFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  var s = e.getGameStatus();
  ok(s.over && s.reason === 'stalemate' && s.result === '1/2-1/2', 'stalemate detected');
})();

// ---------------------------------------------------------------------------
section('Castling');

(function () {
  var e = new Engine();
  e.loadFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  var sans = e.legalMoves().map(function (m) { return e.history && m; });
  var hasOO = e.findMoves(sq('e1'), sq('g1')).length === 1;
  var hasOOO = e.findMoves(sq('e1'), sq('c1')).length === 1;
  ok(hasOO && hasOOO, 'both castles available with full rights');
  var und = moveBySquares(e, 'e1', 'g1');
  ok(und.san === 'O-O', "SAN 'O-O'");
  ok(e.board[sq('f1')] === 'R' && e.board[sq('h1')] === null, 'rook relocated to f1');
  e.unmakeMove();
  ok(e.board[sq('e1')] === 'K' && e.board[sq('h1')] === 'R' && e.board[sq('f1')] === null,
    'unmake restores castle');
})();

(function () {
  // Rook on f4 attacks f1: kingside castle must be illegal, queenside legal.
  var e = new Engine();
  e.loadFen('4k3/8/8/8/5r2/8/8/R3K2R w KQ - 0 1');
  ok(e.findMoves(sq('e1'), sq('g1')).length === 0, 'cannot castle through attacked square');
  ok(e.findMoves(sq('e1'), sq('c1')).length === 1, 'queenside castle still legal');
})();

(function () {
  // In check: no castling at all.
  var e = new Engine();
  e.loadFen('4k3/8/8/8/4r3/8/8/R3K2R w KQ - 0 1');
  ok(e.findMoves(sq('e1'), sq('g1')).length === 0 && e.findMoves(sq('e1'), sq('c1')).length === 0,
    'cannot castle while in check');
})();

(function () {
  // Capturing a rook on its home corner removes that castling right.
  var e = new Engine();
  e.loadFen('r3k2r/8/8/8/8/8/6R1/R3K2R b KQkq - 0 1');
  var und = moveBySquares(e, 'a8', 'a1');
  ok(und.san.indexOf('Rxa1') === 0, 'Rxa1 played');
  ok(e.castling.wQ === false, 'capturing a1 rook removes white queenside right');
})();

// ---------------------------------------------------------------------------
section('En passant');

(function () {
  var e = new Engine();
  e.loadFen('k7/8/8/8/3pP3/8/8/4K3 b - e3 0 1');
  var ep = e.findMoves(sq('d4'), sq('e3'));
  ok(ep.length === 1 && ep[0].isEP, 'en passant capture generated');
  e.makeMove(ep[0]);
  ok(e.board[sq('e4')] === null && e.board[sq('e3')] === 'p', 'ep removes victim from e4');
  e.unmakeMove();
  ok(e.board[sq('e4')] === 'P' && e.board[sq('e3')] === null && e.board[sq('d4')] === 'p',
    'unmake restores en passant');
})();

(function () {
  // EP available only on the very next move.
  var e = new Engine();
  e.loadFen('k7/8/8/8/3pP3/8/8/4K3 b - e3 0 1');
  moveBySquares(e, 'a8', 'b8');   // black plays something else
  moveBySquares(e, 'e1', 'd1');   // white replies
  ok(e.findMoves(sq('d4'), sq('e3')).length === 0, 'en passant expires after one move');
})();

(function () {
  // The famous EP-pin: capturing would expose the king along the rank.
  var e = new Engine();
  e.loadFen('8/8/8/8/k2Pp2Q/8/8/4K3 b - d3 0 1');
  var ep = e.findMoves(sq('e4'), sq('d3'));
  ok(ep.length === 0, 'en passant pin correctly rejected');
  // Same position without the queen: legal.
  e.loadFen('8/8/8/8/k2Pp3/8/8/4K3 b - d3 0 1');
  ok(e.findMoves(sq('e4'), sq('d3')).length === 1, 'en passant legal without the pin');
})();

// ---------------------------------------------------------------------------
section('Promotion');

(function () {
  var e = new Engine();
  e.loadFen('8/P6k/8/8/8/8/8/7K w - - 0 1');
  var ms = e.findMoves(sq('a7'), sq('a8'));
  ok(ms.length === 4, 'four promotion choices generated');
  var und = moveBySquares(e, 'a7', 'a8', 'N');
  ok(und.san === 'a8=N' && e.board[sq('a8')] === 'N', 'underpromotion to knight');
})();

(function () {
  var e = new Engine();
  e.loadFen('1n5k/P7/8/8/8/8/8/7K w - - 0 1');
  var und = moveBySquares(e, 'a7', 'b8', 'R');
  ok(und.san === 'axb8=R+' && e.board[sq('b8')] === 'R', 'capture promotion SAN axb8=R+ (got ' + und.san + ')');
})();

// ---------------------------------------------------------------------------
section('SAN disambiguation');

(function () {
  // Rooks on a1/h1, king off the rank so both can reach d1 -> file needed.
  // (Black king on b8: off both rook lines.)
  var e = new Engine();
  e.loadFen('1k6/8/8/8/4K3/8/8/R6R w - - 0 1');
  var und = moveBySquares(e, 'a1', 'd1');
  ok(und.san === 'Rad1', 'file disambiguation Rad1 (got ' + und.san + ')');
  e.loadFen('1k6/8/8/8/4K3/8/8/R6R w - - 0 1');
  und = moveBySquares(e, 'h1', 'd1');
  ok(und.san === 'Rhd1', 'file disambiguation Rhd1 (got ' + und.san + ')');
})();

(function () {
  // Rooks on the SAME file: rank disambiguation.
  var e = new Engine();
  e.loadFen('7k/8/8/R7/8/8/R7/4K3 w - - 0 1');
  var und = moveBySquares(e, 'a2', 'a3');
  ok(und.san === 'R2a3', 'rank disambiguation R2a3 (got ' + und.san + ')');
})();

// ---------------------------------------------------------------------------
section('Fifty-move rule');

(function () {
  var e = new Engine();
  e.loadFen('k7/8/8/8/8/8/8/K6R w - - 99 80');
  moveBySquares(e, 'h1', 'h2');
  var s = e.getGameStatus();
  ok(s.over && s.reason === 'fifty-move rule', 'fifty-move draw at 100 halfmoves');
})();

// ---------------------------------------------------------------------------
section('Threefold repetition');

(function () {
  var e = new Engine();
  // Knights out and back twice: the start position occurs a 3rd time.
  moveBySquares(e, 'g1', 'f3'); moveBySquares(e, 'g8', 'f6');
  moveBySquares(e, 'f3', 'g1'); moveBySquares(e, 'f6', 'g8');
  var s1 = e.getGameStatus();
  ok(!s1.over, 'second occurrence is not yet a draw');
  moveBySquares(e, 'g1', 'f3'); moveBySquares(e, 'g8', 'f6');
  moveBySquares(e, 'f3', 'g1'); moveBySquares(e, 'f6', 'g8');
  var s2 = e.getGameStatus();
  ok(s2.over && s2.reason === 'threefold repetition', 'third occurrence draws');
  // Undo must also undo the repetition count.
  e.unmakeMove();
  ok(!e.getGameStatus().over, 'undo revokes the repetition draw');
})();

// ---------------------------------------------------------------------------
section('Insufficient material');

(function () {
  var e = new Engine(); e.loadFen('8/8/8/8/8/8/8/KkB5 w - - 0 1');
  ok(e.getGameStatus().reason === 'insufficient material', 'K+B vs K is a draw');
  e.loadFen('8/8/8/8/8/8/8/KNkB4 w - - 0 1');
  ok(!e.getGameStatus().over, 'K+N vs K+B is not auto-draw');
})();

// ---------------------------------------------------------------------------
section('FEN round-trip & undo fidelity');

(function () {
  var e = new Engine();
  var fens = [
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    '8/8/8/8/k2Pp2Q/8/8/4K3 b - d3 0 1'
  ];
  var all = true;
  fens.forEach(function (f) { e.loadFen(f); if (e.fen() !== f) { all = false; console.log('    mismatch: ' + e.fen()); } });
  ok(all, 'fen() inverts loadFen()');

  // Deep random playout, then unwind: FEN must return exactly.
  var e2 = new Engine(); e2.loadFen(CE.START_FEN);
  var start = e2.fen(), rngState = 42;
  function rng() { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; }
  for (var plies = 0; plies < 120; plies++) {
    var ms = e2.legalMoves();
    if (!ms.length) break;
    var s = e2.getGameStatus();
    if (s.over) break;
    e2.makeMove(ms[Math.floor(rng() * ms.length)]);
  }
  while (e2.history.length) e2.unmakeMove();
  ok(e2.fen() === start, 'unmake restores exact FEN after random playout');
})();

// ---------------------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
