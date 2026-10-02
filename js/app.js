/**
 * app.js — UI controller. Wires the pure engine + AI to the 3D scene and the
 * DOM panels. Owns all user-facing state: selection, move history browsing,
 * captured material, modals, settings and the AI think loop (chunked so the
 * page never freezes while the engine searches).
 */
(function () {
  'use strict';

  var CE = window.ChessEngine, AI = window.ChessAI;

  // ------------------------------------------------------------------ state
  var engine = new CE.Engine();          // live game (verbose: SAN + repetition)
  var viewEngine = new CE.Engine();      // scratch engine for history review
  viewEngine.verbose = false;

  var scene = null;

  var settings = {
    mode: 'ai',           // 'local' | 'ai'
    difficulty: 'medium', // 'easy' | 'medium' | 'hard'
    playerColor: 'w',     // human's color in AI mode
    camera: 'white',
    sound: true
  };
  // aiColor is always the opposite of playerColor.
  Object.defineProperty(settings, 'aiColor', { get: function () { return settings.playerColor === 'w' ? 'b' : 'w'; } });

  var selected = null;          // selected square or null
  var selMoves = [];            // legal moves for the selected piece
  var animating = false;
  var thinking = false;
  var abortAI = false;
  var pendingPromotion = null;  // list of promotion moves awaiting UI choice
  var viewingPly = null;        // null = live, else 0..history.length
  var gameOver = null;          // engine.getGameStatus() result once finished
  var fenHistory = [engine.fen()];

  // DOM ---------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  var els = {
    container: $('scene-container'),
    turnChip: $('turn-chip'), turnDot: $('turn-dot'), turnText: $('turn-text'),
    thinkBar: $('think-bar'), thinkFill: $('think-fill'),
    reviewBanner: $('review-banner'), reviewText: $('review-text'),
    panel: $('panel'), panelToggle: $('panel-toggle'), panelGrip: $('panel-grip'),
    moveList: $('move-list'), movesEmpty: $('moves-empty'),
    capWhite: $('captured-by-white'), capBlack: $('captured-by-black'),
    matWhite: $('material-white'), matBlack: $('material-black'),
    btnUndo: $('btn-undo'), btnNew: $('btn-new'),
    promoModal: $('promo-modal'), promoChoices: $('promo-choices'),
    overModal: $('gameover-modal'), overIcon: $('over-icon'),
    overTitle: $('over-title'), overReason: $('over-reason'), overScore: $('over-score'),
    settingsModal: $('settings-modal'),
    toast: $('toast')
  };

  var GLYPH = { P: '♟', N: '♞', B: '♝', R: '♜', Q: '♛', K: '♚' };
  var PIECE_VALUE = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
  var toastTimer = null;

  function toast(msg, ms) {
    els.toast.textContent = msg;
    els.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.add('hidden'); }, ms || 2200);
  }

  // ------------------------------------------------------------------ scene
  var hoverSuppressed = false;

  scene = Scene3D.create(els.container, engine, {
    onSquareClick: onSquareClick,
    onHover: function (sq) {
      if (hoverSuppressed) { scene.setHover(null); return; }
      var ok = sq >= 0 && live() && interactive() && engine.board[sq] &&
               CE.colorOf(engine.board[sq]) === engine.turn;
      scene.setHover(ok ? sq : null);
    }
  });

  function live() { return viewingPly === null && !pendingPromotion && !gameOver; }
  function interactive() {
    if (animating || thinking) return false;
    if (settings.mode === 'ai' && engine.turn === settings.aiColor) return false;
    return true;
  }

  // ------------------------------------------------------------- board clicks
  function onSquareClick(sq) {
    if (!live()) {
      if (viewingPly !== null) { closeReview(); toast('Returned to the live position'); }
      return;
    }
    if (!interactive()) return;

    // Second click on a highlighted destination -> move.
    if (selected !== null) {
      var matches = selMoves.filter(function (m) { return m.to === sq; });
      if (matches.length) {
        if (matches.length > 1 || matches[0].promotion) openPromotion(matches);
        else doMove(matches[0]);
        return;
      }
    }

    // Click on own piece -> (re)select.
    var p = engine.board[sq];
    if (p && CE.colorOf(p) === engine.turn) {
      if (selected === sq) { clearSelection(); return; } // toggle off
      select(sq);
    } else {
      if (selected !== null) { clearSelection(); }
      else if (p) Sound.play('error');
    }
  }

  function select(sq) {
    clearSelection();
    selected = sq;
    selMoves = engine.movesFrom(sq);
    scene.setSelected(sq);
    scene.setLifted(sq, true);
    scene.showLegalMoves(selMoves);
    Sound.play('select');
  }

  function clearSelection() {
    if (selected !== null) scene.setLifted(selected, false);
    selected = null;
    selMoves = [];
    scene.setSelected(null);
    scene.clearLegalMoves();
  }

  // ---------------------------------------------------------------- moves
  function doMove(m) {
    clearSelection();
    if (viewingPly !== null) closeReview();
    animating = true;

    engine.makeMove(m);
    fenHistory.push(engine.fen());

    // Sound + highlight before the animation starts (feels responsive).
    Sound.play(m.isCastle ? 'castle' : (m.captured ? 'capture' : 'move'));
    scene.setLastMove(m.from, m.to);
    scene.setCheckSquare(null);

    renderMoveList();
    updateCaptured();

    scene.animateMove(m).then(function () {
      animating = false;
      if (m.promotion) Sound.play('promote');
      updateStatus();
      var status = engine.getGameStatus();
      if (status.over) endGame(status);
      else scheduleAI();
    });

    updateStatus(); // turn label flips immediately
  }

  function openPromotion(moves) {
    pendingPromotion = moves;
    els.promoChoices.setAttribute('data-color', engine.turn);
    els.promoChoices.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('data-color', engine.turn);
    });
    els.promoModal.classList.remove('hidden');
    Sound.play('select');
  }

  els.promoChoices.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-promo]');
    if (!btn || !pendingPromotion) return;
    var type = btn.getAttribute('data-promo');
    var m = pendingPromotion.find(function (x) { return x.promotion === type; });
    pendingPromotion = null;
    els.promoModal.classList.add('hidden');
    if (m) doMove(m);
  });
  els.promoModal.addEventListener('click', function (e) {
    if (e.target === els.promoModal) { // backdrop cancels
      pendingPromotion = null;
      els.promoModal.classList.add('hidden');
      clearSelection();
    }
  });

  // ------------------------------------------------------------------- undo
  els.btnUndo.addEventListener('click', undo);
  function undo() {
    if (animating || thinking) return;
    if (!engine.history.length) return;
    if (viewingPly !== null) { closeReview(); return; }
    if (gameOver) hideGameOver();

    abortAI = true;
    clearSelection();

    // Undo plies until it is the human's turn again (AI mode), else one ply.
    var records = [];
    records.push(engine.unmakeMove());
    fenHistory.pop();
    if (settings.mode === 'ai') {
      while (records.length < 2 && engine.history.length && engine.turn !== settings.playerColor) {
        records.push(engine.unmakeMove());
        fenHistory.pop();
      }
    }

    animating = true;
    // Retract visually in reverse order: latest move first.
    var chain = Promise.resolve();
    records.forEach(function (rec, i) {
      chain = chain.then(function () {
        if (i === 0) Sound.play('move');
        return scene.animateMove(rec.move, { isUndo: true });
      });
    });
    chain.then(function () {
      animating = false;
      gameOver = null;
      var last = engine.history.length ? engine.history[engine.history.length - 1].move : null;
      scene.setLastMove(last ? last.from : null, last ? last.to : null);
      renderMoveList();
      updateCaptured();
      updateStatus();
      scheduleAI(); // handles the (rare) case where it's now the AI's turn
    });
  }

  // -------------------------------------------------------------- new game
  els.btnNew.addEventListener('click', function () { newGame(true); });

  function newGame(announce) {
    abortAI = true;
    thinking = false;
    animating = false;
    gameOver = null;
    hideGameOver();
    if (viewingPly !== null) closeReview();
    clearSelection();
    pendingPromotion = null;
    els.promoModal.classList.add('hidden');

    engine.reset();
    fenHistory = [engine.fen()];

    scene.setLastMove(null, null);
    scene.setCheckSquare(null);
    scene.setPiecesFromEngine({ intro: true });

    renderMoveList();
    updateCaptured();
    updateStatus();
    if (announce) toast(settings.mode === 'ai'
      ? 'New game — you play ' + (settings.playerColor === 'w' ? 'White' : 'Black')
      : 'New game — White to move');

    if (settings.mode === 'ai' && engine.turn === settings.aiColor) {
      // Player chose black: the AI opens after the intro settles.
      setTimeout(function () { abortAI = false; scheduleAI(); }, 1250);
    }
  }

  // ------------------------------------------------------------------- AI
  function scheduleAI() {
    if (settings.mode !== 'ai' || gameOver || engine.turn !== settings.aiColor) return;
    if (thinking || animating) return;

    thinking = true;
    abortAI = false;
    updateStatus();
    els.thinkBar.classList.add('active');
    els.thinkFill.style.width = '0%';

    var searchEngine = new CE.Engine();
    searchEngine.loadFen(engine.fen());
    var search = AI.createSearch(searchEngine, settings.difficulty);
    var started = performance.now();

    function pump() {
      if (abortAI) { finishThink(null); return; }
      var t0 = performance.now();
      while (!search.done && performance.now() - t0 < 14) search.step();
      els.thinkFill.style.width = Math.round(search.progress * 100) + '%';
      if (!search.done) { setTimeout(pump, 16); return; }

      var result = search.result();
      // Keep a minimum "thinking" beat so easy mode doesn't feel instant.
      var wait = Math.max(0, 450 - (performance.now() - started));
      setTimeout(function () { finishThink(result); }, wait);
    }

    function finishThink(result) {
      els.thinkBar.classList.remove('active');
      thinking = false;
      updateStatus();
      if (!result || abortAI) return;
      // Map the clone-engine move back onto a live-engine move object.
      var m = engine.legalMoves().find(function (x) {
        return x.from === result.move.from && x.to === result.move.to &&
               (x.promotion || null) === (result.move.promotion || null);
      });
      if (m) doMove(m);
    }

    setTimeout(pump, 30);
  }

  // ------------------------------------------------------------- game over
  function endGame(status) {
    gameOver = status;
    var winner = status.result === '1-0' ? 'w' : status.result === '0-1' ? 'b' : null;
    var title, reason;

    if (status.reason === 'checkmate') {
      title = 'Checkmate';
      reason = (winner === 'w' ? 'White' : 'Black') + ' wins';
      els.overIcon.textContent = winner === 'w' ? '♕' : '♛';
      if (settings.mode === 'ai') Sound.play(winner === settings.playerColor ? 'gameWin' : 'gameLoss');
      else Sound.play('gameWin');
    } else if (status.reason === 'stalemate') {
      title = 'Stalemate'; reason = 'No legal moves — draw';
      els.overIcon.textContent = '🤝';
      Sound.play('gameDraw');
    } else {
      title = 'Draw';
      reason = status.reason.charAt(0).toUpperCase() + status.reason.slice(1);
      els.overIcon.textContent = '½';
      Sound.play('gameDraw');
    }

    els.overTitle.textContent = title;
    els.overReason.textContent = reason;
    els.overScore.textContent = status.result === '1-0' ? '1 – 0'
      : status.result === '0-1' ? '0 – 1' : '½ – ½';
    updateStatus();

    setTimeout(function () {
      els.overModal.classList.remove('hidden');
    }, 700);
  }

  function hideGameOver() { els.overModal.classList.add('hidden'); }
  $('btn-over-new').addEventListener('click', function () { newGame(false); });
  $('btn-over-review').addEventListener('click', hideGameOver);

  // ----------------------------------------------------------------- status
  function updateStatus() {
    if (gameOver) {
      els.turnText.textContent = gameOver.reason === 'checkmate'
        ? 'Checkmate — ' + (gameOver.result === '1-0' ? 'White' : 'Black') + ' wins'
        : 'Draw — ' + gameOver.reason;
      els.turnChip.classList.remove('check');
      els.turnDot.className = 'dot ' + (gameOver.result === '0-1' ? 'black' : 'white');
      scene.setCheckSquare(null);
      return;
    }

    var side = engine.turn === 'w' ? 'White' : 'Black';
    var check = engine.inCheck(engine.turn);

    if (thinking) {
      els.turnText.textContent = 'Computer is thinking…';
      els.turnDot.className = 'dot black pulse';
      els.turnChip.classList.remove('check');
    } else if (check) {
      els.turnText.textContent = side + ' is in check';
      els.turnDot.className = 'dot ' + (engine.turn === 'w' ? 'white' : 'black') + ' pulse';
      els.turnChip.classList.add('check');
      Sound.play('check');
    } else {
      els.turnText.textContent = side + ' to move';
      els.turnDot.className = 'dot ' + (engine.turn === 'w' ? 'white' : 'black');
      els.turnChip.classList.remove('check');
    }

    // Red highlight under the checked king.
    if (check && viewingPly === null) {
      scene.setCheckSquare(engine.kingSquare(engine.turn));
    } else if (viewingPly === null) {
      scene.setCheckSquare(null);
    }

    els.btnUndo.disabled = !engine.history.length || thinking || animating;
  }

  // -------------------------------------------------------------- move list
  function renderMoveList() {
    els.moveList.innerHTML = '';
    var n = engine.history.length;
    els.movesEmpty.style.display = n ? 'none' : 'block';

    for (var i = 0; i < n; i += 2) {
      var li = document.createElement('li');
      li.className = 'move-row';
      var num = document.createElement('span');
      num.className = 'move-num';
      num.textContent = (i / 2 + 1) + '.';
      li.appendChild(num);

      for (var j = 0; j < 2; j++) {
        var ply = i + j;
        var span = document.createElement('span');
        span.className = 'move-san';
        if (ply < n) {
          span.textContent = engine.history[ply].san;
          span.title = 'View position after this move';
          (function (p) {
            span.addEventListener('click', function () { viewPly(p + 1); });
          })(ply);
          if (viewingPly === ply + 1) span.classList.add('current');
          else if (viewingPly === null && ply === n - 1) span.classList.add('current');
        } else {
          span.textContent = '…';
          span.style.opacity = '0.25';
          span.style.cursor = 'default';
        }
        li.appendChild(span);
      }
      els.moveList.appendChild(li);
    }
    // Keep the latest move visible.
    els.moveList.scrollTop = els.moveList.scrollHeight;
  }

  // --------------------------------------------------------------- captured
  function capturedList() {
    var list = [];
    engine.history.forEach(function (rec) {
      if (rec.move.captured) {
        list.push({ type: CE.typeOf(rec.move.captured), color: CE.colorOf(rec.move.captured) });
      }
    });
    return list;
  }

  function updateCaptured() {
    var byWhite = [], byBlack = [];
    capturedList().forEach(function (c) {
      (c.color === 'b' ? byWhite : byBlack).push(c.type);
    });
    var order = { Q: 0, R: 1, B: 2, N: 3, P: 4 };
    byWhite.sort(function (a, b) { return order[a] - order[b]; });
    byBlack.sort(function (a, b) { return order[a] - order[b]; });

    function fill(el, types, cls) {
      el.innerHTML = types.map(function (t) {
        return '<span class="' + cls + '">' + GLYPH[t] + '</span>';
      }).join('');
    }
    fill(els.capWhite, byWhite, 'cb'); // pieces White captured (black glyphs)
    fill(els.capBlack, byBlack, 'cw'); // pieces Black captured (white glyphs)

    var diff = byWhite.reduce(function (s, t) { return s + PIECE_VALUE[t]; }, 0) -
               byBlack.reduce(function (s, t) { return s + PIECE_VALUE[t]; }, 0);
    els.matWhite.textContent = diff > 0 ? '+' + diff : '';
    els.matBlack.textContent = diff < 0 ? '+' + (-diff) : '';
  }

  // ---------------------------------------------------------- history review
  function viewPly(p) {
    if (animating) return;
    if (p >= engine.history.length) { closeReview(); return; }
    clearSelection();
    viewingPly = p;

    viewEngine.loadFen(fenHistory[p]);
    scene.showBoard(viewEngine.board);
    scene.setLastMove(null, null);
    if (p > 0) {
      var mv = engine.history[p - 1].move;
      scene.setLastMove(mv.from, mv.to);
    }
    scene.setCheckSquare(viewEngine.inCheck(viewEngine.turn)
      ? viewEngine.kingSquare(viewEngine.turn) : null);

    els.reviewText.textContent = 'Viewing ' + p + ' / ' + engine.history.length;
    els.reviewBanner.classList.remove('hidden');
    hoverSuppressed = true;
    scene.setHover(null);
    renderMoveList();
  }

  function closeReview() {
    if (viewingPly === null) return;
    viewingPly = null;
    els.reviewBanner.classList.add('hidden');
    hoverSuppressed = false;
    scene.showBoard(engine.board);
    scene.restoreCaptured(capturedList());
    var last = engine.history.length ? engine.history[engine.history.length - 1].move : null;
    scene.setLastMove(last ? last.from : null, last ? last.to : null);
    scene.setCheckSquare(!gameOver && engine.inCheck(engine.turn)
      ? engine.kingSquare(engine.turn) : null);
    renderMoveList();
  }

  $('btn-review-live').addEventListener('click', closeReview);
  $('btn-review-back').addEventListener('click', function () {
    if (viewingPly === null) viewPly(engine.history.length - 1);
    else if (viewingPly > 0) viewPly(viewingPly - 1);
  });
  $('btn-review-fwd').addEventListener('click', function () {
    if (viewingPly === null) return;
    if (viewingPly + 1 >= engine.history.length) closeReview();
    else viewPly(viewingPly + 1);
  });

  // --------------------------------------------------------------- settings
  function bindSeg(id, attr, fn) {
    var seg = $(id);
    seg.addEventListener('click', function (e) {
      var btn = e.target.closest('button[' + attr + ']');
      if (!btn) return;
      seg.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      fn(btn.getAttribute(attr));
    });
  }
  function setSegActive(id, attr, value) {
    $(id).querySelectorAll('button[' + attr + ']').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute(attr) === value);
    });
  }

  function applyModeUI() {
    var isAI = settings.mode === 'ai';
    $('seg-diff').style.opacity = isAI ? '1' : '0.35';
    $('seg-diff').style.pointerEvents = isAI ? 'auto' : 'none';
    $('set-playas-row').style.display = isAI ? '' : 'none';
    $('set-diff-row').style.display = isAI ? '' : 'none';
    setSegActive('seg-mode', 'data-mode', settings.mode);
    setSegActive('set-mode', 'data-mode', settings.mode);
  }

  function setMode(mode, silent) {
    if (mode === settings.mode) return;
    settings.mode = mode;
    applyModeUI();
    if (!silent && engine.history.length && !gameOver) {
      toast('Mode change applies to the next game');
    } else if (mode === 'ai' && engine.turn === settings.aiColor && !gameOver) {
      scheduleAI();
    }
  }

  function setDifficulty(d) {
    settings.difficulty = d;
    setSegActive('seg-diff', 'data-diff', d);
    setSegActive('set-diff', 'data-diff', d);
  }

  function setCamera(cam) {
    settings.camera = cam;
    setSegActive('set-camera', 'data-cam', cam);
    scene.flyTo(cam);
  }

  function setSound(on) {
    settings.sound = on;
    Sound.setEnabled(on);
    $('btn-sound').textContent = on ? '🔊' : '🔇';
    $('btn-sound').classList.toggle('off', !on);
    var t = $('set-sound');
    t.classList.toggle('on', on);
    t.setAttribute('aria-pressed', on);
  }

  bindSeg('seg-mode', 'data-mode', function (m) { setMode(m); });
  bindSeg('set-mode', 'data-mode', function (m) { setMode(m); });
  bindSeg('seg-diff', 'data-diff', setDifficulty);
  bindSeg('set-diff', 'data-diff', setDifficulty);
  bindSeg('set-camera', 'data-cam', setCamera);
  bindSeg('set-playas', 'data-side', function (side) {
    settings.playerColor = side;
    if (engine.history.length) toast('You will play ' + (side === 'w' ? 'White' : 'Black') + ' in the next game');
  });

  $('set-sound').addEventListener('click', function () { setSound(!settings.sound); });
  $('btn-sound').addEventListener('click', function () { setSound(!settings.sound); });
  $('btn-camera').addEventListener('click', function () {
    var order = ['white', 'black', 'top'];
    var next = order[(order.indexOf(settings.camera) + 1) % order.length];
    setCamera(next);
    toast('Camera: ' + next);
  });

  $('btn-settings').addEventListener('click', function () {
    els.settingsModal.classList.remove('hidden');
  });
  $('btn-settings-close').addEventListener('click', function () {
    els.settingsModal.classList.add('hidden');
  });
  els.settingsModal.addEventListener('click', function (e) {
    if (e.target === els.settingsModal) els.settingsModal.classList.add('hidden');
  });

  // ----------------------------------------------------------- panel (mobile)
  els.panelToggle.addEventListener('click', function () {
    els.panel.classList.toggle('open');
    els.panelToggle.classList.toggle('hidden', els.panel.classList.contains('open'));
  });
  function closeSheet() {
    els.panel.classList.remove('open');
    els.panelToggle.classList.remove('hidden');
  }
  // Swipe the grip down (or tap it) to close.
  var gripStartY = null, gripMoved = 0;
  els.panelGrip.addEventListener('pointerdown', function (e) {
    gripStartY = e.clientY;
    gripMoved = 0;
  });
  window.addEventListener('pointermove', function (e) {
    if (gripStartY === null) return;
    gripMoved += Math.abs(e.clientY - (gripStartY || e.clientY));
    if (e.clientY - gripStartY > 60) { closeSheet(); gripStartY = null; }
  });
  window.addEventListener('pointerup', function () {
    if (gripStartY !== null && gripMoved < 8) closeSheet(); // tap on grip
    gripStartY = null;
  });

  // ---------------------------------------------------------------- keyboard
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!els.settingsModal.classList.contains('hidden')) { els.settingsModal.classList.add('hidden'); return; }
      if (!els.overModal.classList.contains('hidden')) { hideGameOver(); return; }
      if (pendingPromotion) { pendingPromotion = null; els.promoModal.classList.add('hidden'); clearSelection(); return; }
      if (viewingPly !== null) { closeReview(); return; }
      clearSelection();
    } else if (e.key === 'ArrowLeft') {
      if (viewingPly === null) viewPly(engine.history.length - 1);
      else if (viewingPly > 0) viewPly(viewingPly - 1);
    } else if (e.key === 'ArrowRight') {
      if (viewingPly === null) return;
      if (viewingPly + 1 >= engine.history.length) closeReview();
      else viewPly(viewingPly + 1);
    } else if (e.key === 'u' || e.key === 'U') {
      undo();
    }
  });

  // ------------------------------------------------------------------- boot
  applyModeUI();
  setDifficulty(settings.difficulty);
  setSound(true);
  scene.flyTo('white');
  newGame(false);
  setTimeout(function () { toast('Click a piece to begin — drag to orbit the board'); }, 1400);

  // Debug/QA hook (harmless in production; used by automated tests).
  window.__gambit = {
    engine: engine,
    scene: scene,
    settings: settings,
    doMove: doMove,
    squareToScreen: function (sq) {
      var w = Scene3D.squareToWorld(sq);
      var v = new THREE.Vector3(w.x, 0.05, w.z).project(scene.camera);
      var rect = els.container.getBoundingClientRect();
      return {
        x: rect.left + ((v.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - v.y) / 2) * rect.height
      };
    }
  };
})();
