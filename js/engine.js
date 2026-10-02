/**
 * engine.js — Pure chess rules engine (no DOM / rendering dependencies).
 *
 * Responsibilities:
 *   - Full legal move generation (castling, en passant, promotion)
 *   - Check / checkmate / stalemate detection
 *   - Draw detection: threefold repetition, fifty-move rule, insufficient material
 *   - Move making / unmaking with full state restore (for AI search + undo)
 *   - SAN (Standard Algebraic Notation) generation
 *   - FEN import/export (used for tests, snapshots and AI cloning)
 *
 * Board representation:
 *   Array(64). Index 0 = a8 (top-left from White's view), index 63 = h1.
 *   rank index r = i >> 3  (r = 0 is rank 8, r = 7 is rank 1)
 *   file index f = i & 7   (f = 0 is file a)
 *   Pieces are single chars: uppercase = White ("PNBRQK"), lowercase = Black.
 *
 * Runs in the browser (window.ChessEngine) and in Node (module.exports) so the
 * rules can be tested independently of the 3D rendering layer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChessEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var WHITE = 'w', BLACK = 'b';
  var FILES = 'abcdefgh';
  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // Square helpers -----------------------------------------------------------

  function sq(f, r) { return r * 8 + f; }               // f 0..7 (a..h), r 0..7 (rank8..rank1)
  function fileOf(i) { return i & 7; }
  function rankOf(i) { return i >> 3; }                 // 0 = rank 8
  function algebraic(i) { return FILES[fileOf(i)] + (8 - rankOf(i)); }
  function colorOf(p) { return p === p.toUpperCase() ? WHITE : BLACK; }
  function typeOf(p) { return p ? p.toUpperCase() : ''; }

  // Precomputed jump tables (index -> array of target squares). Built once;
  // using (file, rank) deltas avoids the classic board-wrap bugs.
  var KNIGHT_MOVES = [], KING_MOVES = [];
  (function () {
    var knightDeltas = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
    var kingDeltas = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    for (var i = 0; i < 64; i++) {
      var f = fileOf(i), r = rankOf(i), km = [], kg = [], d, nf, nr;
      for (d of knightDeltas) {
        nf = f + d[0]; nr = r + d[1];
        if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) km.push(sq(nf, nr));
      }
      for (d of kingDeltas) {
        nf = f + d[0]; nr = r + d[1];
        if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) kg.push(sq(nf, nr));
      }
      KNIGHT_MOVES.push(km); KING_MOVES.push(kg);
    }
  })();

  // Ray directions for sliding pieces, as (df, dr) pairs.
  var RAYS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  var PIECE_VALUES = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000 };

  // Engine -------------------------------------------------------------------

  function Engine() {
    this.board = null;
    this.reset();
  }

  Engine.prototype.reset = function () {
    this.loadFen(START_FEN);
  };

  /** Parse a FEN string into engine state. */
  Engine.prototype.loadFen = function (fen) {
    var parts = fen.trim().split(/\s+/);
    var rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error('Invalid FEN: board must have 8 ranks');

    this.board = new Array(64).fill(null);
    for (var r = 0; r < 8; r++) {
      var f = 0;
      for (var c of rows[r]) {
        if (c >= '1' && c <= '8') { f += +c; continue; }
        this.board[sq(f, r)] = c;
        f++;
      }
      if (f !== 8) throw new Error('Invalid FEN: rank ' + (8 - r) + ' has ' + f + ' files');
    }

    this.turn = parts[1] === 'b' ? BLACK : WHITE;
    var cast = parts[2] || '-';
    this.castling = {
      wK: cast.indexOf('K') !== -1, wQ: cast.indexOf('Q') !== -1,
      bK: cast.indexOf('k') !== -1, bQ: cast.indexOf('q') !== -1
    };
    this.epSquare = (parts[3] && parts[3] !== '-') ? this.parseSquare(parts[3]) : -1;
    this.halfmove = parts[4] !== undefined ? parseInt(parts[4], 10) : 0;
    this.fullmove = parts[5] !== undefined ? parseInt(parts[5], 10) : 1;

    this.history = [];                 // undo stack (also stores SAN + repetition keys)
    this._legalCache = null;
    // Repetition bookkeeping. `verbose` = track SAN + repetition (game play);
    // search / perft turn it off for speed.
    this.verbose = this.verbose !== undefined ? this.verbose : true;
    this.positionCounts = {};
    if (this.verbose) this.positionCounts[this.positionKey()] = 1;
    return this;
  };

  Engine.prototype.parseSquare = function (s) {
    var f = FILES.indexOf(s[0]);
    var r = 8 - parseInt(s[1], 10);
    return (f >= 0 && r >= 0 && r < 8) ? sq(f, r) : -1;
  };

  /** Export current state as FEN. */
  Engine.prototype.fen = function () {
    var out = [];
    for (var r = 0; r < 8; r++) {
      var row = '', empty = 0;
      for (var f = 0; f < 8; f++) {
        var p = this.board[sq(f, r)];
        if (!p) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += p;
      }
      if (empty) row += empty;
      out.push(row);
    }
    var cast = (this.castling.wK ? 'K' : '') + (this.castling.wQ ? 'Q' : '') +
               (this.castling.bK ? 'k' : '') + (this.castling.bQ ? 'q' : '');
    return out.join('/') + ' ' + this.turn + ' ' + (cast || '-') + ' ' +
      (this.epSquare >= 0 ? algebraic(this.epSquare) : '-') + ' ' + this.halfmove + ' ' + this.fullmove;
  };

  Engine.prototype.kingSquare = function (color) {
    var k = color === WHITE ? 'K' : 'k';
    for (var i = 0; i < 64; i++) if (this.board[i] === k) return i;
    return -1;
  };

  /**
   * Is `square` attacked by any piece of color `by`?
   * Used for check detection and for verifying castling path safety.
   */
  Engine.prototype.isAttacked = function (square, by) {
    var b = this.board, f = fileOf(square), r = rankOf(square), i;

    // Pawns attack diagonally and only FORWARD (White toward rank 8 =
    // decreasing rank index, Black toward rank 1 = increasing). So `square`
    // is attacked by a White pawn sitting one rank below it (r+1 in our
    // indexing), and by a Black pawn one rank above it (r-1).
    if (by === WHITE) {
      if (r + 1 < 8) {
        if (f - 1 >= 0 && b[sq(f - 1, r + 1)] === 'P') return true;
        if (f + 1 < 8 && b[sq(f + 1, r + 1)] === 'P') return true;
      }
    } else {
      if (r - 1 >= 0) {
        if (f - 1 >= 0 && b[sq(f - 1, r - 1)] === 'p') return true;
        if (f + 1 < 8 && b[sq(f + 1, r - 1)] === 'p') return true;
      }
    }

    var kn = by === WHITE ? 'N' : 'n';
    var targets = KNIGHT_MOVES[square];
    for (i = 0; i < targets.length; i++) if (b[targets[i]] === kn) return true;

    var kg = by === WHITE ? 'K' : 'k';
    targets = KING_MOVES[square];
    for (i = 0; i < targets.length; i++) if (b[targets[i]] === kg) return true;

    // Sliders: walk each ray until the first piece. Orthogonal rays hit R/Q,
    // diagonal rays hit B/Q.
    var rook = by === WHITE ? 'R' : 'r', bishop = by === WHITE ? 'B' : 'b',
        queen = by === WHITE ? 'Q' : 'q';
    for (i = 0; i < 8; i++) {
      var df = RAYS[i][0], dr = RAYS[i][1], nf = f + df, nr = r + dr;
      var orthogonal = df === 0 || dr === 0;
      while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
        var p = b[sq(nf, nr)];
        if (p) {
          if (colorOf(p) === by) {
            var t = typeOf(p);
            if (t === 'Q' || (orthogonal && t === 'R') || (!orthogonal && t === 'B')) return true;
          }
          break; // any piece blocks the ray
        }
        nf += df; nr += dr;
      }
    }
    return false;
  };

  Engine.prototype.inCheck = function (color) {
    var ks = this.kingSquare(color);
    return ks >= 0 && this.isAttacked(ks, color === WHITE ? BLACK : WHITE);
  };

  /**
   * Pseudo-legal move generation (own-king safety is NOT checked here; the
   * caller filters via make/unmake — see legalMoves()). When `capturesOnly`
   * is true only captures and queen promotions are produced (for quiescence
   * search).
   *
   * Move object shape:
   *   { from, to, piece, captured, promotion, isEP, isCastle: 'K'|'Q'|null, isDouble }
   * `promotion` is the target type char ('Q','R','B','N'), `captured` is the
   * enemy piece char (for en passant: the pawn char, though it sits on a
   * different square — see makeMove).
   */
  Engine.prototype.generateMoves = function (capturesOnly) {
    var moves = [], b = this.board, us = this.turn;
    var forward = us === WHITE ? -8 : 8;             // White marches toward rank 8 (index 0)
    var startRank = us === WHITE ? 6 : 1;            // rank 2 for White, rank 7 for Black
    var promoRank = us === WHITE ? 0 : 7;
    var promoPieces = ['Q', 'R', 'B', 'N'];

    function add(from, to, piece, captured, extra) {
      var m = { from: from, to: to, piece: piece, captured: captured || null,
                promotion: null, isEP: false, isCastle: null, isDouble: false };
      if (extra) for (var k in extra) m[k] = extra[k];
      moves.push(m);
    }

    for (var from = 0; from < 64; from++) {
      var piece = b[from];
      if (!piece || colorOf(piece) !== us) continue;
      var type = typeOf(piece), f = fileOf(from), r = rankOf(from), i, j, t;

      if (type === 'P') {
        var one = from + forward;
        if (one >= 0 && one < 64 && !b[one]) {
          if (rankOf(one) === promoRank) {
            // Promotions: generate all four target pieces as separate moves
            // (the UI picker / AI search choose between them).
            for (i = 0; i < 4; i++)
              if (!capturesOnly || promoPieces[i] === 'Q')
                add(from, one, piece, null, { promotion: promoPieces[i] });
          } else if (!capturesOnly) {
            add(from, one, piece, null);
            var two = one + forward;
            // Double push only from the home rank, both squares must be empty.
            if (r === startRank && !b[two]) add(from, two, piece, null, { isDouble: true });
          }
        }
        // Diagonal captures / en passant.
        for (var df = -1; df <= 1; df += 2) {
          var nf = f + df, nr = r + (us === WHITE ? -1 : 1);
          if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
          t = sq(nf, nr);
          var target = b[t];
          if (target && colorOf(target) !== us) {
            if (nr === promoRank) {
              for (i = 0; i < 4; i++)
                if (!capturesOnly || promoPieces[i] === 'Q')
                  add(from, t, piece, target, { promotion: promoPieces[i] });
            } else add(from, t, piece, target);
          } else if (t === this.epSquare && this.epSquare >= 0) {
            // En passant: target square is empty; the captured pawn sits on
            // `from`'s rank (verified in makeMove, which removes it there).
            var victim = us === WHITE ? 'p' : 'P';
            add(from, t, piece, victim, { isEP: true });
          }
        }
      } else if (type === 'N') {
        var km = KNIGHT_MOVES[from];
        for (i = 0; i < km.length; i++) {
          t = km[i]; var tp = b[t];
          if (!tp) { if (!capturesOnly) add(from, t, piece, null); }
          else if (colorOf(tp) !== us) add(from, t, piece, tp);
        }
      } else if (type === 'K') {
        var kg = KING_MOVES[from];
        for (i = 0; i < kg.length; i++) {
          t = kg[i]; var kp = b[t];
          if (!kp) { if (!capturesOnly) add(from, t, piece, null); }
          else if (colorOf(kp) !== us) add(from, t, piece, kp);
        }
        // Castling. Conditions (all must hold):
        //  1. Castling right intact (king/rook not previously moved).
        //  2. All squares between king and rook empty.
        //  3. King is NOT currently in check.
        //  4. The square the king passes through is not attacked.
        //  5. Destination square safety is enforced by the generic legality
        //     filter (make/unmake + inCheck) like any other move.
        if (!capturesOnly) {
          var them = us === WHITE ? BLACK : WHITE;
          if (from === (us === WHITE ? 60 : 4) && !this.isAttacked(from, them)) {
            var kingSide = us === WHITE ? this.castling.wK : this.castling.bK;
            var queenSide = us === WHITE ? this.castling.wQ : this.castling.bQ;
            var rookChar = us === WHITE ? 'R' : 'r';
            if (kingSide && b[from + 1] === null && b[from + 2] === null &&
                b[from + 3] === rookChar && !this.isAttacked(from + 1, them))
              add(from, from + 2, piece, null, { isCastle: 'K' });
            if (queenSide && b[from - 1] === null && b[from - 2] === null &&
                b[from - 3] === null && b[from - 4] === rookChar &&
                !this.isAttacked(from - 1, them))
              add(from, from - 2, piece, null, { isCastle: 'Q' });
          }
        }
      } else {
        // Sliding pieces (B/R/Q): walk rays until blocked.
        var isRook = type === 'R', isBishop = type === 'B', isQueen = type === 'Q';
        for (i = 0; i < 8; i++) {
          var rdf = RAYS[i][0], rdr = RAYS[i][1];
          if (isRook && rdf !== 0 && rdr !== 0) continue;
          if (isBishop && (rdf === 0 || rdr === 0)) continue;
          var cf = f + rdf, cr = r + rdr;
          while (cf >= 0 && cf < 8 && cr >= 0 && cr < 8) {
            t = sq(cf, cr); var sp = b[t];
            if (!sp) { if (!capturesOnly) add(from, t, piece, null); }
            else { if (colorOf(sp) !== us) add(from, t, piece, sp); break; }
            cf += rdf; cr += rdr;
          }
        }
      }
      // (j unused; kept var list tidy)
      void j;
    }
    return moves;
  };

  /**
   * Apply `m` to the board. Everything needed to undo is pushed onto
   * this.history. In verbose mode the SAN string is generated and the
   * repetition table updated.
   */
  Engine.prototype.makeMove = function (m) {
    var und = {
      move: m,
      capturedPiece: null, capturedSquare: -1,
      castling: { wK: this.castling.wK, wQ: this.castling.wQ, bK: this.castling.bK, bQ: this.castling.bQ },
      epSquare: this.epSquare, halfmove: this.halfmove,
      repetitionKey: null, san: null
    };
    var b = this.board, us = this.turn;
    // SAN base must be built while the board still shows the pre-move
    // position (disambiguation looks at alternatives in THIS position).
    var sanBase = this.verbose ? this.sanBase(m) : null;

    // Remember a capture (en passant captures a pawn that is NOT on m.to).
    if (m.captured) {
      if (m.isEP) {
        und.capturedSquare = m.to + (us === WHITE ? 8 : -8); // pawn beside us, behind target
        und.capturedPiece = b[und.capturedSquare];
        b[und.capturedSquare] = null;
      } else {
        und.capturedSquare = m.to;
        und.capturedPiece = b[m.to];
      }
    }

    // Move the piece (promotions swap in the new type).
    b[m.from] = null;
    b[m.to] = m.promotion ? (us === WHITE ? m.promotion : m.promotion.toLowerCase()) : m.piece;

    // Castling also moves the rook (king destination encodes the side).
    if (m.isCastle === 'K') { b[m.to + 1] = null; b[m.to - 1] = us === WHITE ? 'R' : 'r'; }
    if (m.isCastle === 'Q') { b[m.to - 2] = null; b[m.to + 1] = us === WHITE ? 'R' : 'r'; }

    // Castling rights: any king move forfeits both; a rook leaving its origin
    // corner forfeits that side; capturing a rook ON its corner forfeits the
    // opponent's right (the rook no longer stands there).
    if (typeOf(m.piece) === 'K') {
      if (us === WHITE) { this.castling.wK = false; this.castling.wQ = false; }
      else { this.castling.bK = false; this.castling.bQ = false; }
    }
    if (m.from === 63 || m.to === 63) this.castling.wK = false;
    if (m.from === 56 || m.to === 56) this.castling.wQ = false;
    if (m.from === 7 || m.to === 7) this.castling.bK = false;
    if (m.from === 0 || m.to === 0) this.castling.bQ = false;

    // En passant target only exists immediately after a double pawn push.
    this.epSquare = m.isDouble ? (m.from + m.to) / 2 : -1;

    // Fifty-move rule counter: pawn moves and captures reset it.
    this.halfmove = (typeOf(m.piece) === 'P' || m.captured) ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.turn = us === WHITE ? BLACK : WHITE;
    this._legalCache = null;

    if (this.verbose) {
      und.san = sanBase + this.sanSuffix();
      var key = this.positionKey();
      this.positionCounts[key] = (this.positionCounts[key] || 0) + 1;
      und.repetitionKey = key;
    }
    this.history.push(und);
    return und;
  };

  /** Perfect inverse of makeMove (restores rights, EP, clocks, repetition). */
  Engine.prototype.unmakeMove = function () {
    var und = this.history.pop();
    if (!und) return null;
    var m = und.move, b = this.board;

    this.turn = this.turn === WHITE ? BLACK : WHITE;
    var us = this.turn;

    b[m.from] = m.piece;             // original piece (a pawn, even if promoted)
    b[m.to] = null;
    if (und.capturedPiece) b[und.capturedSquare] = und.capturedPiece;

    if (m.isCastle === 'K') { b[m.to - 1] = null; b[m.to + 1] = us === WHITE ? 'R' : 'r'; }
    if (m.isCastle === 'Q') { b[m.to + 1] = null; b[m.to - 2] = us === WHITE ? 'R' : 'r'; }

    this.castling = und.castling;
    this.epSquare = und.epSquare;
    this.halfmove = und.halfmove;
    if (us === BLACK) this.fullmove--;
    this._legalCache = null;

    if (und.repetitionKey !== null) {
      this.positionCounts[und.repetitionKey]--;
      if (this.positionCounts[und.repetitionKey] <= 0) delete this.positionCounts[und.repetitionKey];
    }
    return und;
  };

  /** All fully-legal moves (pseudo-legal moves that leave own king safe). */
  Engine.prototype.legalMoves = function () {
    if (this._legalCache) return this._legalCache;
    // Legality probing uses make/unmake; temporarily disable verbose mode so
    // probes don't generate SAN (which itself needs legalMoves -> recursion)
    // or pollute the repetition table.
    var wasVerbose = this.verbose;
    this.verbose = false;
    var legal = [], moves = this.generateMoves();
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var mover = colorOf(m.piece);
      this.makeMove(m);
      var ok = !this.inCheck(mover);   // own king must not be left in check
      this.unmakeMove();
      if (ok) legal.push(m);
    }
    this.verbose = wasVerbose;
    this._legalCache = legal;
    return legal;
  };

  /** Legal moves originating from `square`. */
  Engine.prototype.movesFrom = function (square) {
    return this.legalMoves().filter(function (m) { return m.from === square; });
  };

  /** All legal moves from->to (1 normally, 4 when a promotion choice exists). */
  Engine.prototype.findMoves = function (from, to) {
    return this.legalMoves().filter(function (m) { return m.from === from && m.to === to; });
  };

  /**
   * Position key for threefold repetition: piece placement, side to move,
   * castling rights and — only when an en passant capture is actually
   * possible — the EP square (FIDE rule: a phantom EP target that nobody can
   * capture does not make a position different).
   */
  Engine.prototype.positionKey = function () {
    var key = this.board.join('') + ' ' + this.turn +
      (this.castling.wK ? 'K' : '') + (this.castling.wQ ? 'Q' : '') +
      (this.castling.bK ? 'k' : '') + (this.castling.bQ ? 'q' : '');
    if (this.epSquare >= 0 && this.epPossible()) key += ' ' + algebraic(this.epSquare);
    return key;
  };

  Engine.prototype.epPossible = function () {
    if (this.epSquare < 0) return false;
    var f = fileOf(this.epSquare), r = rankOf(this.epSquare);
    // The capturing pawn stands beside the target on the mover's rank.
    var pawn = this.turn === WHITE ? 'P' : 'p';
    var pr = this.turn === WHITE ? r + 1 : r - 1;
    if (pr < 0 || pr > 7) return false;
    if (f - 1 >= 0 && this.board[sq(f - 1, pr)] === pawn) return true;
    if (f + 1 < 8 && this.board[sq(f + 1, pr)] === pawn) return true;
    return false;
  };

  /**
   * SAN for `m`, split in two phases:
   *   sanBase  — computed BEFORE the move is applied (disambiguation needs
   *              the pre-move position's legal moves).
   *   sanSuffix — computed AFTER the move is applied (+ / #).
   */
  Engine.prototype.sanBase = function (m) {
    if (m.isCastle) return m.isCastle === 'K' ? 'O-O' : 'O-O-O';
    var type = typeOf(m.piece);
    var isCapture = !!m.captured;
    var out = '';
    if (type === 'P') {
      if (isCapture) out += FILES[fileOf(m.from)] + 'x';   // exd5 (incl. en passant)
    } else {
      out += type;
      // Disambiguation: if another identical piece can also legally reach
      // `to`, add the file (or rank, or both) of departure.
      var others = this.legalMoves().filter(function (x) {
        return x.to === m.to && x.from !== m.from && typeOf(x.piece) === type;
      });
      if (others.length) {
        var sameFile = others.some(function (x) { return fileOf(x.from) === fileOf(m.from); });
        var sameRank = others.some(function (x) { return rankOf(x.from) === rankOf(m.from); });
        if (!sameFile) out += FILES[fileOf(m.from)];
        else if (!sameRank) out += (8 - rankOf(m.from));
        else out += algebraic(m.from);
      }
      if (isCapture) out += 'x';
    }
    out += algebraic(m.to);
    if (m.promotion) out += '=' + m.promotion;
    return out;
  };

  /** Check/mate suffix for the position AFTER the move (side to move = opponent). */
  Engine.prototype.sanSuffix = function () {
    if (this.inCheck(this.turn)) return this.legalMoves().length ? '+' : '#';
    return '';
  };

  /**
   * Dead-position detection: bare kings, king+minor vs king, or bishops-only
   * where nobody can ever mate (both bishops on same colored squares).
   */
  Engine.prototype.insufficientMaterial = function () {
    var minors = [];
    for (var i = 0; i < 64; i++) {
      var p = this.board[i];
      if (!p) continue;
      var t = typeOf(p);
      if (t === 'K') continue;
      if (t === 'P' || t === 'R' || t === 'Q') return false;
      minors.push({ type: t, color: colorOf(p), light: (fileOf(i) + rankOf(i)) % 2 === 1 });
    }
    if (minors.length <= 1) return true;                        // K vs K, K+N vs K, K+B vs K
    if (minors.length === 2 && minors[0].type === 'B' && minors[1].type === 'B' &&
        minors[0].color !== minors[1].color && minors[0].light === minors[1].light)
      return true;                                              // same-colored bishops
    return false;
  };

  /**
   * Game status. Returns:
   *   { over: false, inCheck }
   * or { over: true, result: '1-0'|'0-1'|'1/2-1/2', reason, inCheck }
   */
  Engine.prototype.getGameStatus = function () {
    var check = this.inCheck(this.turn);
    var status = { over: false, inCheck: check, result: null, reason: null };
    if (this.legalMoves().length === 0) {
      if (check) {
        status.over = true;
        status.result = this.turn === WHITE ? '0-1' : '1-0';
        status.reason = 'checkmate';
      } else {
        status.over = true; status.result = '1/2-1/2'; status.reason = 'stalemate';
      }
      return status;
    }
    if (this.halfmove >= 100) {
      status.over = true; status.result = '1/2-1/2'; status.reason = 'fifty-move rule';
      return status;
    }
    if (this.verbose && this.positionCounts[this.positionKey()] >= 3) {
      status.over = true; status.result = '1/2-1/2'; status.reason = 'threefold repetition';
      return status;
    }
    if (this.insufficientMaterial()) {
      status.over = true; status.result = '1/2-1/2'; status.reason = 'insufficient material';
      return status;
    }
    return status;
  };

  /** Perft: count leaf nodes of the legal move tree (movegen correctness). */
  Engine.prototype.perft = function (depth) {
    if (depth === 0) return 1;
    var nodes = 0, moves = this.legalMoves();
    for (var i = 0; i < moves.length; i++) {
      this.makeMove(moves[i]);
      nodes += depth === 1 ? 1 : this.perft(depth - 1);
      this.unmakeMove();
    }
    return nodes;
  };

  // Module exports ------------------------------------------------------------

  return {
    Engine: Engine,
    START_FEN: START_FEN,
    WHITE: WHITE,
    BLACK: BLACK,
    PIECE_VALUES: PIECE_VALUES,
    algebraic: algebraic,
    fileOf: fileOf,
    rankOf: rankOf,
    colorOf: colorOf,
    typeOf: typeOf
  };
});
