/**
 * ai.js — Chess AI: negamax with alpha-beta pruning, MVV-LVA move ordering,
 * quiescence search and piece-square-table evaluation.
 *
 * Runs against an exclusive ChessEngine instance (the app clones the game
 * FEN into a private engine so search never touches live game state).
 *
 * The root search is CHUNKED: `createSearch()` returns a stepper that
 * completes one root move per `step()` call, so the UI thread stays
 * responsive (the caller drives it with setTimeout) instead of freezing on
 * one long synchronous search.
 *
 * Difficulty levels:
 *   easy   — depth 1, picks randomly among moves within ~120cp of the best
 *   medium — depth 2 + quiescence, tiny randomness for variety
 *   hard   — depth 4 + quiescence, full piece-square tables
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChessAI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MATE = 100000;

  var VAL = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };

  // Piece-square tables (white's point of view; row 0 = rank 8, matching the
  // engine's board indexing). Black indexes with the rank flipped (i ^ 56).
  // From the "simplified evaluation function" (chessprogramming.org).
  var PST = {
    P: [ // pawns: rewarded for advancing, centralpassed pawns
       0,  0,  0,  0,  0,  0,  0,  0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
       5,  5, 10, 25, 25, 10,  5,  5,
       0,  0,  0, 20, 20,  0,  0,  0,
       5, -5,-10,  0,  0,-10, -5,  5,
       5, 10, 10,-20,-20, 10, 10,  5,
       0,  0,  0,  0,  0,  0,  0,  0],
    N: [
     -50,-40,-30,-30,-30,-30,-40,-50,
     -40,-20,  0,  0,  0,  0,-20,-40,
     -30,  0, 10, 15, 15, 10,  0,-30,
     -30,  5, 15, 20, 20, 15,  5,-30,
     -30,  0, 15, 20, 20, 15,  0,-30,
     -30,  5, 10, 15, 15, 10,  5,-30,
     -40,-20,  0,  5,  5,  0,-20,-40,
     -50,-40,-30,-30,-30,-30,-40,-50],
    B: [
     -20,-10,-10,-10,-10,-10,-10,-20,
     -10,  0,  0,  0,  0,  0,  0,-10,
     -10,  0,  5, 10, 10,  5,  0,-10,
     -10,  5,  5, 10, 10,  5,  5,-10,
     -10,  0, 10, 10, 10, 10,  0,-10,
     -10, 10, 10, 10, 10, 10, 10,-10,
     -10,  5,  0,  0,  0,  0,  5,-10,
     -20,-10,-10,-10,-10,-10,-10,-20],
    R: [
       0,  0,  0,  0,  0,  0,  0,  0,
       5, 10, 10, 10, 10, 10, 10,  5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
       0,  0,  0,  5,  5,  0,  0,  0],
    Q: [
     -20,-10,-10, -5, -5,-10,-10,-20,
     -10,  0,  0,  0,  0,  0,  0,-10,
     -10,  0,  5,  5,  5,  5,  0,-10,
      -5,  0,  5,  5,  5,  5,  0, -5,
       0,  0,  5,  5,  5,  5,  0, -5,
     -10,  5,  5,  5,  5,  5,  0,-10,
     -10,  0,  5,  0,  0,  0,  0,-10,
     -20,-10,-10, -5, -5,-10,-10,-20],
    K: [ // middlegame king: stay castled and safe
     -30,-40,-40,-50,-50,-40,-40,-30,
     -30,-40,-40,-50,-50,-40,-40,-30,
     -30,-40,-40,-50,-50,-40,-40,-30,
     -30,-40,-40,-50,-50,-40,-40,-30,
     -20,-30,-30,-40,-40,-30,-30,-20,
     -10,-20,-20,-20,-20,-20,-20,-10,
      20, 20,  0,  0,  0,  0, 20, 20,
      20, 30, 10,  0,  0, 10, 30, 20],
    KE: [ // endgame king: march to the center
     -50,-40,-30,-20,-20,-30,-40,-50,
     -30,-20,-10,  0,  0,-10,-20,-30,
     -30,-10, 20, 30, 30, 20,-10,-30,
     -30,-10, 30, 40, 40, 30,-10,-30,
     -30,-10, 30, 40, 40, 30,-10,-30,
     -30,-10, 20, 30, 30, 20,-10,-30,
     -30,-30,  0,  0,  0,  0,-30,-30,
     -50,-30,-30,-30,-30,-30,-30,-50]
  };

  var LEVELS = {
    easy:   { depth: 1, quiesce: false, jitter: 120 },
    medium: { depth: 2, quiesce: true,  jitter: 0 },
    hard:   { depth: 4, quiesce: true,  jitter: 0 }
  };

  /** Static evaluation from the side-to-move's perspective (negamax sign). */
  function evaluate(engine) {
    var score = 0, nonPawn = 0, b = engine.board;
    for (var i = 0; i < 64; i++) {
      var p = b[i];
      if (!p) continue;
      var t0 = p.toUpperCase();
      if (t0 !== 'K' && t0 !== 'P') nonPawn += VAL[t0]; // N/B/R/Q of both sides
    }
    var endgame = nonPawn <= 2 * (VAL.R + VAL.B); // heavy pieces mostly gone
    for (var j = 0; j < 64; j++) {
      var q = b[j];
      if (!q) continue;
      var type = q.toUpperCase();
      var white = q === type;
      var table = type === 'K' ? (endgame ? PST.KE : PST.K) : PST[type];
      var v = VAL[type] + table[white ? j : (j ^ 56)];
      score += white ? v : -v;
    }
    return engine.turn === 'w' ? score : -score;
  }

  /** MVV-LVA: most valuable victim first, cheapest attacker first. */
  function moveOrderScore(m) {
    if (m.captured) return 10 * VAL[m.captured.toUpperCase()] - VAL[m.piece.toUpperCase()] + 1000;
    if (m.promotion === 'Q') return 900;
    return 0;
  }

  /**
   * Quiescence search: resolve captures only, so the evaluator never sits on
   * a position where the next capture changes everything (horizon effect).
   */
  function quiescence(engine, alpha, beta, depth) {
    var stand = evaluate(engine);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (depth <= 0) return alpha;

    var moves = engine.generateMoves(true).sort(function (a, b2) { return moveOrderScore(b2) - moveOrderScore(a); });
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var mover = m.piece === m.piece.toUpperCase() ? 'w' : 'b';
      engine.makeMove(m);
      if (engine.inCheck(mover)) { engine.unmakeMove(); continue; }
      var score = -quiescence(engine, -beta, -alpha, depth - 1);
      engine.unmakeMove();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  /** Quiescence on/off, set per-search by createSearch (medium/hard only). */
  var USE_Q = true;

  /** Negamax with alpha-beta. Returns score from side-to-move's perspective. */
  function negamax(engine, depth, alpha, beta, ply) {
    if (depth === 0) return USE_Q ? quiescence(engine, alpha, beta, 6) : evaluate(engine);

    var moves = engine.generateMoves().sort(function (a, b2) { return moveOrderScore(b2) - moveOrderScore(a); });
    var legalCount = 0;
    var checked = engine.inCheck(engine.turn);

    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var mover = engine.turn;
      engine.makeMove(m);
      if (engine.inCheck(mover)) { engine.unmakeMove(); continue; }
      legalCount++;
      var score = -negamax(engine, depth - 1, -beta, -alpha, ply + 1);
      engine.unmakeMove();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }

    if (legalCount === 0) return checked ? -MATE + ply : 0; // mate / stalemate
    return alpha;
  }

  /**
   * Chunked root search. Usage:
   *   var s = ChessAI.createSearch(engine, 'hard');
   *   while (!s.done) s.step();     // one root move per call
   *   best = s.result().move;
   * `engine` should be a dedicated instance loaded with the game FEN and
   * verbose mode OFF (the app resets it before handing it over).
   */
  function createSearch(engine, levelName) {
    var level = LEVELS[levelName] || LEVELS.medium;
    engine.verbose = false;
    USE_Q = level.quiesce;

    var rootMoves = engine.legalMoves().slice();
    rootMoves.sort(function (a, b) { return moveOrderScore(b) - moveOrderScore(a); });
    var scored = [];
    var index = 0;
    var alpha = -Infinity, beta = Infinity;

    return {
      get done() { return index >= rootMoves.length; },
      get progress() { return rootMoves.length ? index / rootMoves.length : 1; },
      /** Evaluate the next root move (takes ~10-200ms depending on depth). */
      step: function () {
        if (index >= rootMoves.length) return;
        var m = rootMoves[index++];
        var mover = engine.turn;
        engine.makeMove(m);
        var score;
        if (engine.inCheck(mover)) {
          score = -Infinity; // illegal at root (already filtered, defensive)
        } else {
          // RAW score only: alpha-beta siblings that fail high return bound
          // values (== current alpha), never exact scores — jitter must not
          // be mixed in here or a pruned sibling could outrank the best move.
          score = -negamax(engine, level.depth - 1, -beta, -alpha, 1);
        }
        engine.unmakeMove();
        if (score !== -Infinity) {
          scored.push({ move: m, score: score });
          if (score > alpha) alpha = score; // narrows the window for siblings
        }
      },
      /**
       * Pick the best move. With `jitter` > 0 (easy level), choose randomly
       * among near-best moves — safe there because depth-1 root scores are
       * exact (no alpha pruning below depth 2).
       */
      result: function () {
        if (!scored.length) return null;
        scored.sort(function (a, b) { return b.score - a.score; });
        if (level.jitter > 0) {
          var pool = scored.filter(function (s) { return s.score >= scored[0].score - level.jitter; });
          var pick = pool[Math.floor(Math.random() * pool.length)];
          return { move: pick.move, score: pick.score, candidates: scored.length };
        }
        return { move: scored[0].move, score: scored[0].score, candidates: scored.length };
      }
    };
  }

  /** Convenience synchronous search (used by tests / Node). */
  function bestMove(engine, levelName) {
    var s = createSearch(engine, levelName);
    while (!s.done) s.step();
    return s.result();
  }

  return { createSearch: createSearch, bestMove: bestMove, evaluate: evaluate, LEVELS: LEVELS };
});
