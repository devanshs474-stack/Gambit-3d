/**
 * ai.test.js — sanity tests for the AI layer. Run: node tests/ai.test.js
 */
var CE = require('../js/engine.js');
var AI = require('../js/ai.js');
var Engine = CE.Engine;

var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name); }
}
function sqi(n) { return (8 - parseInt(n[1], 10)) * 8 + 'abcdefgh'.indexOf(n[0]); }
function cloneAt(fen) { var e = new Engine(); e.loadFen(fen); e.verbose = false; return e; }

// ---------------------------------------------------------------------------
console.log('\n== evaluation ==');

(function () {
  var e = cloneAt(CE.START_FEN);
  ok(AI.evaluate(e) === 0, 'start position evaluates to exactly 0');
  var w = cloneAt(CE.START_FEN);
  w.makeMove(w.findMoves(sqi('e2'), sqi('e4'))[0]);
  // evaluate() is from the side-to-move: black to move sees a negative score.
  ok(AI.evaluate(w) < 0, 'black to move sees negative score after 1.e4');
})();

// ---------------------------------------------------------------------------
console.log('\n== tactics ==');

(function () {
  // Scholar's mate position: Qxf7# must be found at every level >= depth 2.
  var e = cloneAt('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 1');
  var r = AI.bestMove(e, 'medium');
  ok(r && r.move.from === sqi('f3') && r.move.to === sqi('f7'), 'medium finds Qxf7# (mate in 1)');
  r = AI.bestMove(e, 'hard');
  ok(r && r.move.to === sqi('f7'), 'hard finds Qxf7#');
})();

(function () {
  // Mate in 2 (classic): 1.Qh6+ then... simple back-rank mate in 1 instead:
  // K on h8 trapped by R on d8.
  var e = cloneAt('6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1');
  var r = AI.bestMove(e, 'easy');
  // Easy is random among near-best and may miss mate-in-1; hard must find it.
  r = AI.bestMove(e, 'hard');
  ok(r && r.move.to === sqi('e8') && r.score > 90000, 'hard finds back-rank mate Re8#');
})();

(function () {
  // Undefended black queen on d5, takeable by the c4 pawn: must grab it.
  var e = cloneAt('rnb1kbnr/pppp1ppp/8/3q4/2P5/5N2/PP1PPPPP/RNBQKB1R w KQkq - 0 1');
  var r = AI.bestMove(e, 'hard');
  ok(r && r.move.from === sqi('c4') && r.move.to === sqi('d5') && r.score > 800,
    'hard wins the hanging queen cxd5 (got ' + (r ? CE.algebraic(r.move.from) + CE.algebraic(r.move.to) + ' ' + r.score : 'null') + ')');
})();

// ---------------------------------------------------------------------------
console.log('\n== self-play ==');

function selfPlay(level, maxPlies) {
  var e = new Engine(); e.verbose = true;
  var plies = 0;
  while (plies < maxPlies) {
    var s = e.getGameStatus();
    if (s.over) return { plies: plies, reason: s.reason, result: s.result };
    var searchEngine = cloneAt(e.fen());
    var r = AI.bestMove(searchEngine, level);
    if (!r) return { plies: plies, reason: 'no-move', result: '?' };
    // The returned move must be legal in the real game engine.
    var legal = e.legalMoves().some(function (m) {
      return m.from === r.move.from && m.to === r.move.to &&
             (m.promotion || null) === (r.move.promotion || null);
    });
    if (!legal) return { plies: plies, reason: 'ILLEGAL MOVE PROPOSED', result: '!' };
    e.makeMove(r.move);
    plies++;
  }
  return { plies: plies, reason: 'cap reached', result: '*' };
}

(function () {
  var r = selfPlay('easy', 240);
  ok(r.reason !== 'ILLEGAL MOVE PROPOSED', 'easy self-play: all moves legal (' + r.plies + ' plies, ' + r.reason + ')');
})();
(function () {
  var r = selfPlay('medium', 200);
  ok(r.reason !== 'ILLEGAL MOVE PROPOSED', 'medium self-play: all moves legal (' + r.plies + ' plies, ' + r.reason + ')');
})();
(function () {
  var r = selfPlay('hard', 120);
  ok(r.reason !== 'ILLEGAL MOVE PROPOSED', 'hard self-play: all moves legal (' + r.plies + ' plies, ' + r.reason + ')');
})();

// ---------------------------------------------------------------------------
console.log('\n== chunked search ==');

(function () {
  var e = cloneAt(CE.START_FEN);
  var s = AI.createSearch(e, 'medium');
  var steps = 0;
  while (!s.done) { s.step(); steps++; }
  ok(steps === 20 && s.progress === 1, 'chunked search completes in 20 steps at start (got ' + steps + ')');
  ok(!!s.result().move, 'chunked search returns a move');
})();

// ---------------------------------------------------------------------------
console.log('\n== timing ==');

(function () {
  var e = cloneAt('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
  var t0 = Date.now();
  AI.bestMove(cloneAt(e.fen()), 'hard');
  var ms = Date.now() - t0;
  console.log('    hard (depth 4) midgame move: ' + ms + 'ms');
  ok(ms < 5000, 'hard depth-4 move under 5s');
  t0 = Date.now();
  AI.bestMove(cloneAt(e.fen()), 'easy');
  console.log('    easy move: ' + (Date.now() - t0) + 'ms');
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
