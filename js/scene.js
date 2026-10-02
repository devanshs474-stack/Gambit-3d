/**
 * scene.js — Three.js rendering layer: board, table, lighting, custom orbit
 * controls, piece management, square picking and animated moves.
 *
 * The scene never mutates game state: it renders whatever the engine says
 * and reports clicks back through callbacks. All public methods are keyed by
 * engine square indices (0..63).
 *
 * World layout: square (file f, rank-index r) sits at
 *   x = f - 3.5,  z = r - 3.5
 * so White (rank 1, r = 7) is near +z and the default camera looks from
 * White's side. Board is 8 units of squares + 0.62 rim each side = 9.24.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('three'), require('./textures.js'), require('./pieces.js'));
  else root.Scene3D = factory(root.THREE, root.Textures, root.Pieces);
})(typeof self !== 'undefined' ? self : this, function (THREE, Textures, Pieces) {
  'use strict';

  var SQ = 1;                    // world size of one square
  var BOARD = 9.24;              // full board width incl. rim
  var RIM = 0.62;
  var ANIM = { move: 380, capture: 460, castle: 340, promo: 500, intro: 600 };

  // Easing -------------------------------------------------------------------
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function easeOutBack(t) {
    var c1 = 1.4, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
  function easeOutBounce(t) {
    var n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  }

  function squareToWorld(s) {
    return { x: (s & 7) - 3.5, z: (s >> 3) - 3.5 };
  }

  // ---------------------------------------------------------------------------
  function create(container, engine, callbacks) {
    callbacks = callbacks || {};
    var renderer, scene, camera, raycaster;
    var controls;                 // custom damped orbit state
    var piecesGroup, boardGroup, fxGroup;
    var materials = {};           // white / black piece materials
    var bySquare = new Array(64).fill(null);   // square -> piece entry
    var allPieces = [];                        // every live entry (incl. captured)
    var capturedStack = [];       // [{entry}] in capture order (for undo)
    var tweens = [];
    var clock = new THREE.Clock();
    var running = true;
    var disposed = false;

    // Overlay meshes
    var selMarker, hoverMarker, lastFromMesh, lastToMesh, checkMesh;
    var dotPool = [], ringPool = [];

    // --- renderer / scene ---------------------------------------------------
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(46, container.clientWidth / container.clientHeight, 0.1, 120);
    raycaster = new THREE.Raycaster();

    // Environment (reflections + soft blurred backdrop)
    var pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    var envSrc = Textures.canvasTexture(Textures.environmentTexture(), 4);
    envSrc.mapping = THREE.EquirectangularReflectionMapping;
    var envRT = pmrem.fromEquirectangular(envSrc);
    scene.environment = envRT.texture;
    scene.background = envRT.texture;   // softly blurred gradient backdrop
    envSrc.dispose();
    pmrem.dispose();

    // Fog for depth falloff; kept far enough to leave the backdrop visible.
    scene.fog = new THREE.Fog(0x1b1917, 34, 90);

    // --- lights ---------------------------------------------------------------
    // Key + fill + rim + environment: total diffuse is kept below ~1.0 on
    // facing surfaces so ACES tone mapping leaves visible shading.
    scene.add(new THREE.AmbientLight(0xffffff, 0.10));
    scene.add(new THREE.HemisphereLight(0xcfe0f2, 0x40342a, 0.22));

    var key = new THREE.DirectionalLight(0xfff0d8, 1.0);
    key.position.set(6.5, 12, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 2; key.shadow.camera.far = 34;
    key.shadow.camera.left = -8; key.shadow.camera.right = 8;
    key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 3.5;
    scene.add(key);

    var fill = new THREE.DirectionalLight(0xbdd2f5, 0.28);
    fill.position.set(-7, 6, -4);
    // Soft secondary shadows from the opposite side add depth.
    fill.castShadow = true;
    fill.shadow.mapSize.set(1024, 1024);
    fill.shadow.camera.near = 2; fill.shadow.camera.far = 34;
    fill.shadow.camera.left = -8; fill.shadow.camera.right = 8;
    fill.shadow.camera.top = 8; fill.shadow.camera.bottom = -8;
    fill.shadow.bias = -0.0006;
    fill.shadow.radius = 5;
    scene.add(fill);

    var rimLight = new THREE.DirectionalLight(0xffdfae, 0.22);
    rimLight.position.set(-2, 5, -9);
    scene.add(rimLight);

    // --- board ----------------------------------------------------------------
    boardGroup = new THREE.Group();
    scene.add(boardGroup);

    var aniso = renderer.capabilities.getMaxAnisotropy();
    var boardTop = Textures.canvasTexture(Textures.boardTexture(2048), aniso);
    var sideTex = Textures.canvasTexture(Textures.sideTexture(), aniso);

    // Colors are authored in sRGB hex; convert to linear so they survive
    // renderer.outputEncoding = sRGB without washing out.
    function stdMat(params) {
      var m = new THREE.MeshStandardMaterial(params);
      if (params.color) m.color.convertSRGBToLinear();
      return m;
    }

    var woodSide = stdMat({ map: sideTex, roughness: 0.72, metalness: 0.05 });
    var woodTop = stdMat({
      map: boardTop, roughness: 0.42, metalness: 0.06,
      envMapIntensity: 0.55
    });
    var woodDark = stdMat({ color: 0x241408, roughness: 0.8, metalness: 0.04 });

    // Box face order: +x, -x, +y, -y, +z, -z
    var boardBox = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD, 0.34, BOARD),
      [woodSide, woodSide, woodTop, woodDark, woodSide, woodSide]
    );
    boardBox.position.y = -0.17;
    boardBox.receiveShadow = true;
    boardBox.castShadow = true;
    boardGroup.add(boardBox);

    // Chamfer strip under the board (dark bevel).
    var bevel = new THREE.Mesh(new THREE.BoxGeometry(BOARD - 0.18, 0.07, BOARD - 0.18), woodDark);
    bevel.position.y = -0.375;
    bevel.castShadow = true;
    boardGroup.add(bevel);

    // Table the board rests on.
    var tableTex = Textures.canvasTexture(Textures.tableTexture(), aniso);
    var table = new THREE.Mesh(
      new THREE.CircleGeometry(16, 48),
      new THREE.MeshStandardMaterial({ map: tableTex, roughness: 0.95, metalness: 0 })
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.41;
    table.receiveShadow = true;
    scene.add(table);

    // Room backdrop: large open cylinder around the scene with a baked warm
    // studio-wall gradient (unlit, fog-affected) so the board sits in a space.
    var backdrop = new THREE.Mesh(
      new THREE.CylinderGeometry(24, 24, 44, 48, 1, true),
      new THREE.MeshBasicMaterial({
        map: Textures.canvasTexture(Textures.backdropTexture(), 4),
        side: THREE.BackSide, fog: true
      })
    );
    backdrop.position.y = 8;
    scene.add(backdrop);

    // Invisible plane for square picking (exactly the 8x8 playing area).
    var pickPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    pickPlane.rotation.x = -Math.PI / 2;
    pickPlane.position.y = 0.02;
    scene.add(pickPlane);

    // --- pieces ----------------------------------------------------------------
    piecesGroup = new THREE.Group();
    scene.add(piecesGroup);

    function physMat(params) {
      var m = new THREE.MeshPhysicalMaterial(params);
      if (params.color) m.color.convertSRGBToLinear();
      return m;
    }

    // Ivory marble / ebony wood — textures painted in final colors, so the
    // material color stays white. The same canvas doubles as a bump map for
    // surface relief on the veins / grain.
    var ivoryTex = Textures.canvasTexture(Textures.pieceIvoryTexture(), aniso);
    var ebonyTex = Textures.canvasTexture(Textures.pieceEbonyTexture(), aniso);

    // Keyed 'w' / 'b' to match engine color codes (see makeEntry).
    materials.w = physMat({
      color: 0xffffff, map: ivoryTex, bumpMap: ivoryTex, bumpScale: 0.012,
      roughness: 0.36, metalness: 0.04,
      envMapIntensity: 0.5, clearcoat: 0.5, clearcoatRoughness: 0.4
    });
    materials.b = physMat({
      color: 0xffffff, map: ebonyTex, bumpMap: ebonyTex, bumpScale: 0.018,
      roughness: 0.44, metalness: 0.20,
      envMapIntensity: 0.75, clearcoat: 0.5, clearcoatRoughness: 0.35
    });

    // --- overlays ---------------------------------------------------------------
    fxGroup = new THREE.Group();
    scene.add(fxGroup);

    function overlay(tex, size, color, opacity, y) {
      var m = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
          map: Textures.canvasTexture(tex, 4), transparent: true,
          color: color, opacity: opacity, depthWrite: false,
          side: THREE.DoubleSide
        })
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = y;
      m.visible = false;
      fxGroup.add(m);
      return m;
    }

    selMarker = overlay(Textures.markerTexture('corner'), 0.96, 0xffd76a, 0.95, 0.055);
    hoverMarker = overlay(Textures.markerTexture('glow'), 0.98, 0xffffff, 0.14, 0.045);
    lastFromMesh = overlay(Textures.markerTexture('glow'), 0.99, 0xffc94d, 0.30, 0.043);
    lastToMesh = overlay(Textures.markerTexture('glow'), 0.99, 0xffc94d, 0.38, 0.044);
    // Red ring around the checked king's square (visible around the piece).
    checkMesh = overlay(Textures.markerTexture('ring'), 1.0, 0xff2f2f, 0.75, 0.052);

    for (var i = 0; i < 32; i++) {
      dotPool.push(overlay(Textures.markerTexture('dot'), 0.34, 0x2f9e6e, 0.85, 0.06));
      ringPool.push(overlay(Textures.markerTexture('ring'), 0.94, 0xd8433b, 0.85, 0.06));
    }

    // --- tween manager ------------------------------------------------------------
    function addTween(dur, onUpdate, onDone, ease) {
      var tw = { t: 0, dur: dur / 1000, on: onUpdate, done: onDone, ease: ease || easeInOut, dead: false };
      tweens.push(tw);
      return tw;
    }

    function stepTweens(dt) {
      for (var i = tweens.length - 1; i >= 0; i--) {
        var tw = tweens[i];
        if (tw.dead) { tweens.splice(i, 1); continue; }
        tw.t += dt;
        var k = Math.min(1, tw.t / tw.dur);
        tw.on(tw.ease(k), k);
        if (k >= 1) {
          tweens.splice(i, 1);
          if (tw.done) tw.done();
        }
      }
    }

    // --- piece management -----------------------------------------------------------
    // Fake contact shadows: a soft blob under every piece that follows it,
    // grows fainter when the piece is airborne (intro / move arcs).
    var blobTex = Textures.canvasTexture(Textures.contactShadowTexture(), 4);
    var blobGeo = new THREE.PlaneGeometry(1.5, 1.5);
    function makeBlob() {
      var m = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({
        map: blobTex, transparent: true, opacity: 0.55, depthWrite: false
      }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.006;
      m.renderOrder = 1; // draw after the board top
      scene.add(m);
      return m;
    }

    function makeEntry(type, color, square) {
      var group = Pieces.createPiece(type, materials[color]);
      var w = squareToWorld(square);
      group.position.set(w.x, 0, w.z);
      group.rotation.y = color === 'w' ? Math.PI : 0; // knights face the enemy
      piecesGroup.add(group);
      var entry = { type: type, color: color, group: group, square: square, captured: false, lift: 0, blob: makeBlob() };
      allPieces.push(entry);
      return entry;
    }

    function clearPieces() {
      for (var i = 0; i < piecesGroup.children.length; i++) {
        var g = piecesGroup.children[i];
        g.traverse(function (o) { if (o.isMesh) o.geometry.dispose(); });
      }
      piecesGroup.children.length = 0;
      for (var j = 0; j < bySquare.length; j++) {
        if (bySquare[j] && bySquare[j].blob) {
          scene.remove(bySquare[j].blob);
          bySquare[j].blob.material.dispose();
        }
      }
      bySquare.fill(null);
      capturedStack.length = 0;
      allPieces.length = 0;
    }

    /** Rebuild every piece from a board array (restart / review jump). */
    function renderBoard(board, opts) {
      opts = opts || {};
      clearPieces();
      for (var s = 0; s < 64; s++) {
        var p = board[s];
        if (!p) continue;
        var color = p === p.toUpperCase() ? 'w' : 'b';
        var e = makeEntry(p.toUpperCase(), color, s);
        bySquare[s] = e;
        if (opts.intro) {
          var delay = (opts.stagger !== undefined ? opts.stagger : 26) * (7 - (s >> 3)) + Math.random() * 90;
          var gy = e.group.position.y;
          e.group.position.y = gy + 4.5;
          e.group.visible = false;
          (function (entry, baseY, d) {
            setTimeout(function () {
              if (disposed) return;
              entry.group.visible = true;
              var it = addTween(ANIM.intro, function (k) {
                entry.group.position.y = baseY + 4.5 * (1 - k);
              }, null, easeOutBounce);
              it.owner = entry.group;
            }, d);
          })(e, gy, delay);
        }
      }
    }

    /** Teleport-sync (fallback when a diff is easier than an animation). */
    function syncPieces() {
      renderBoard(engine.board);
    }

    /**
     * Re-place captured pieces on their trays (used when returning from
     * history view to the live position). `list` = [{type, color}, ...] in
     * capture order.
     */
    function restoreCaptured(list) {
      var counts = { w: 0, b: 0 };
      list.forEach(function (c) {
        var e = makeEntry(c.type, c.color, 0);
        e.captured = true;
        var slot = capturedSlotWorld(c.color, counts[c.color]++);
        e.group.position.set(slot.x, slot.y, slot.z);
        e.group.scale.setScalar(0.72);
        capturedStack.push(e);
        piecesGroup.add(e.group);
      });
    }

    function pieceAt(square) { return bySquare[square]; }

    // Captured piece tray positions, along the left/right edges of the table.
    function capturedSlotWorld(color, index) {
      var dir = color === 'w' ? 1 : -1;          // white captures go on black's side
      var col = index % 4, row = Math.floor(index / 4);
      return {
        x: -5.1 + col * 0.85,
        z: dir * (4.6 + row * 0.9),
        y: -0.41
      };
    }

    // --- move animation ------------------------------------------------------------
    /**
     * Animate a move that has ALREADY been applied to the engine.
     * opts: { isUndo, animate } — animate=false teleports instantly (review).
     * Returns a Promise resolved when all motion finishes.
     */
    function animateMove(m, opts) {
      opts = opts || {};
      return new Promise(function (resolve) {
        var entry = bySquare[m.from];
        if (!entry) { resolve(); return; }

        // Undo of a promotion: the mesh on the board is the promoted piece —
        // swap it back to a pawn before animating home.
        if (opts.isUndo && m.promotion && entry.type !== 'P') swapMesh(entry, 'P');

        if (opts.animate === false) {
          applyMoveInstant(m);
          resolve();
          return;
        }

        var victimSquare = m.captured ? (m.isEP ? (m.to + (entry.color === 'w' ? 8 : -8)) : m.to) : -1;
        var victim = victimSquare >= 0 ? bySquare[victimSquare] : null;
        var rookEntry = null, rookFrom = -1, rookTo = -1;
        if (m.isCastle === 'K') { rookFrom = m.to + 1; rookTo = m.to - 1; }
        if (m.isCastle === 'Q') { rookFrom = m.to - 2; rookTo = m.to + 1; }
        if (rookFrom >= 0) rookEntry = bySquare[rookFrom];

        // Bookkeeping: source clears now; destination clears if a victim leaves.
        bySquare[m.from] = null;
        if (victim) bySquare[victimSquare] = null;
        bySquare[m.to] = entry;
        entry.square = m.to;
        if (rookEntry) {
          bySquare[rookFrom] = null;
          bySquare[rookTo] = rookEntry;
          rookEntry.square = rookTo;
        }

        var pending = 1;
        function oneDone() { if (--pending === 0) finish(); }
        function finish() {
          // Promotion: swap the pawn mesh for its new type.
          if (m.promotion && !opts.isUndo) {
            swapMesh(entry, m.promotion);
            pulse(entry);
          }
          resolve();
        }

        // --- captured piece flies to the tray ------------------------------
        if (victim) {
          victim.captured = true;
          capturedStack.push(victim);
          var slot = capturedSlotWorld(victim.color, capturedStack.filter(function (c) { return c.color === victim.color; }).length - 1);
          var vFrom = victim.group.position.clone();
          var vTo = new THREE.Vector3(slot.x, slot.y, slot.z);
          pending++;
          var vt = addTween(ANIM.capture, function (k) {
            victim.group.position.lerpVectors(vFrom, vTo, k);
            victim.group.position.y = vFrom.y + (vTo.y - vFrom.y) * k + Math.sin(k * Math.PI) * 1.7;
            victim.group.scale.setScalar(1 - 0.28 * k);
          }, function () {
            victim.group.position.copy(vTo);
            victim.group.scale.setScalar(0.72);
            oneDone();
          }, easeInOut);
          vt.owner = victim.group;
        }

        // --- undo restore: bring back the captured piece --------------------
        if (opts.isUndo && m.captured) {
          var restored = capturedStack.pop();
          if (restored) {
            restored.captured = false;
            var home = squareToWorld(victimSquare);
            var rFrom = restored.group.position.clone();
            var rTo = new THREE.Vector3(home.x, 0, home.z);
            pending++;
            bySquare[victimSquare] = restored;
            restored.square = victimSquare;
            var rt = addTween(ANIM.capture * 0.8, function (k) {
              restored.group.position.lerpVectors(rFrom, rTo, k);
              restored.group.position.y = rFrom.y + (0 - rFrom.y) * k + Math.sin(k * Math.PI) * 1.4;
              restored.group.scale.setScalar(0.72 + 0.28 * k);
            }, function () {
              restored.group.position.set(home.x, 0, home.z);
              restored.group.scale.setScalar(1);
              oneDone();
            }, easeInOut);
            rt.owner = restored.group;
          }
        }

        // --- moving piece -----------------------------------------------------
        var fromW = entry.group.position.clone();
        var toW = squareToWorld(m.to);
        var isKnight = entry.type === 'N';
        var arc = isKnight ? 1.0 : (victim ? 0.32 : 0.20);
        entry.lift = 0;
        var mt = addTween(ANIM.move, function (k) {
          entry.group.position.x = fromW.x + (toW.x - fromW.x) * k;
          entry.group.position.z = fromW.z + (toW.z - fromW.z) * k;
          entry.group.position.y = fromW.y + (0 - fromW.y) * k + Math.sin(k * Math.PI) * arc;
        }, function () {
          entry.group.position.set(toW.x, 0, toW.z);
          oneDone();
        }, easeInOut);
        mt.owner = entry.group;

        // --- castling rook follows slightly after -------------------------------
        if (rookEntry) {
          var rFromW = rookEntry.group.position.clone();
          var rToW = squareToWorld(rookTo);
          pending++;
          setTimeout(function () {
            if (disposed) return;
            var ct = addTween(ANIM.castle, function (k) {
              rookEntry.group.position.lerpVectors(rFromW, rToW, k);
              rookEntry.group.position.y = Math.sin(k * Math.PI) * 0.18;
            }, function () {
              rookEntry.group.position.set(rToW.x, 0, rToW.z);
              oneDone();
            }, easeInOut);
            ct.owner = rookEntry.group;
          }, 110);
        }
      });
    }

    function applyMoveInstant(m) {
      var entry = bySquare[m.from];
      if (!entry) return;
      bySquare[m.from] = null;
      if (m.captured) {
        var vsq = m.isEP ? (m.to + (entry.color === 'w' ? 8 : -8)) : m.to;
        var victim = bySquare[vsq];
        if (victim) {
          victim.captured = true;
          capturedStack.push(victim);
          var idx = capturedStack.filter(function (c) { return c.color === victim.color; }).length - 1;
          var slot = capturedSlotWorld(victim.color, idx);
          victim.group.position.set(slot.x, slot.y, slot.z);
          victim.group.scale.setScalar(0.72);
          bySquare[vsq] = null;
        }
      }
      if (m.isCastle === 'K' || m.isCastle === 'Q') {
        var rookFrom = m.isCastle === 'K' ? m.to + 1 : m.to - 2;
        var rookTo = m.isCastle === 'K' ? m.to - 1 : m.to + 1;
        var rookEntry = bySquare[rookFrom];
        if (rookEntry) {
          bySquare[rookFrom] = null; bySquare[rookTo] = rookEntry;
          rookEntry.square = rookTo;
          var rw = squareToWorld(rookTo);
          rookEntry.group.position.set(rw.x, 0, rw.z);
        }
      }
      if (m.promotion) swapMesh(entry, m.promotion);
      var w = squareToWorld(m.to);
      entry.group.position.set(w.x, 0, w.z);
      entry.square = m.to;
      bySquare[m.to] = entry;
    }

    /** Replace a piece's mesh in place (promotion). */
    function swapMesh(entry, newType) {
      var old = entry.group;
      var g = Pieces.createPiece(newType, materials[entry.color]);
      g.position.copy(old.position);
      g.rotation.copy(old.rotation);
      piecesGroup.add(g);
      piecesGroup.remove(old);
      old.traverse(function (o) { if (o.isMesh) o.geometry.dispose(); });
      entry.group = g;
      entry.type = newType;
      // lift state transfers
      g.userData.lift = old.userData.lift || 0;
      entry.lift = old.userData.lift || 0;
    }

    /** Small celebratory hop (promotions). */
    function pulse(entry) {
      var pt = addTween(300, function (k) {
        entry.group.position.y = Math.sin(k * Math.PI) * 0.28;
      }, function () { entry.group.position.y = 0; }, easeOut);
      pt.owner = entry.group;
    }

    // --- overlays -----------------------------------------------------------------
    function placeSquare(mesh, s) {
      var w = squareToWorld(s);
      mesh.position.x = w.x;
      mesh.position.z = w.z;
      mesh.visible = true;
    }

    function setSelected(square) {
      if (square == null) { selMarker.visible = false; return; }
      placeSquare(selMarker, square);
    }

    function setHover(square) {
      if (square == null) { hoverMarker.visible = false; return; }
      placeSquare(hoverMarker, square);
    }

    function setLastMove(from, to) {
      if (from == null) { lastFromMesh.visible = false; lastToMesh.visible = false; return; }
      placeSquare(lastFromMesh, from);
      placeSquare(lastToMesh, to);
    }

    function setCheckSquare(square) {
      if (square == null) { checkMesh.visible = false; return; }
      placeSquare(checkMesh, square);
    }

    /** Show legal destination squares: dots for quiet moves, rings for captures. */
    function showLegalMoves(moves) {
      clearLegalMoves();
      var di = 0, ri = 0;
      moves.forEach(function (m) {
        var w = squareToWorld(m.to);
        var mesh = m.captured ? ringPool[ri++] : dotPool[di++];
        if (!mesh) return;
        mesh.position.x = w.x;
        mesh.position.z = w.z;
        mesh.visible = true;
      });
    }

    function clearLegalMoves() {
      dotPool.concat(ringPool).forEach(function (m) { m.visible = false; });
    }

    /** Lift the selected piece slightly. */
    function setLifted(square, lifted) {
      var e = square != null ? bySquare[square] : null;
      if (e) e.lift = lifted ? 0.22 : 0;
    }

    // --- controls (custom damped orbit) -----------------------------------------
    controls = {
      target: new THREE.Vector3(0, 0.2, 0),
      theta: 0, phi: 0.52, radius: 12,     // spherical around target
      dTheta: 0, dPhi: 0.52, dRadius: 12,  // desired
      dTarget: new THREE.Vector3(0, 0.2, 0)
    };

    function applyCamera() {
      var sinPhi = Math.sin(controls.phi);
      camera.position.set(
        controls.target.x + controls.radius * sinPhi * Math.sin(controls.theta),
        controls.target.y + controls.radius * Math.cos(controls.phi),
        controls.target.z + controls.radius * sinPhi * Math.cos(controls.theta)
      );
      camera.lookAt(controls.target);
    }

    var PRESETS = {
      // phi < atan(1/1.6) ≈ 0.56 keeps tall pieces from occluding the rank
      // behind them at the default view.
      white: { theta: 0, phi: 0.52, radius: 12 },
      black: { theta: Math.PI, phi: 0.52, radius: 12 },
      top: { theta: 0, phi: 0.12, radius: 12.5 }
    };

    function flyTo(preset) {
      var p = PRESETS[preset] || PRESETS.white;
      var t0 = controls.theta, p0 = controls.phi, r0 = controls.radius;
      var r1 = p.radius * fitFactor;              // respect portrait fit
      var tb = controls.target.clone();
      var tb2 = new THREE.Vector3(0, 0.2, 0);
      // Take the short way around for theta.
      var t1 = t0 + shortestAngle(t0, p.theta);
      addTween(900, function (k) {
        controls.theta = t0 + (t1 - t0) * k;
        controls.phi = p0 + (p.phi - p0) * k;
        controls.radius = r0 + (r1 - r0) * k;
        controls.target.lerpVectors(tb, tb2, k);
        controls.dTheta = controls.theta; controls.dPhi = controls.phi;
        controls.dRadius = controls.radius; controls.dTarget.copy(controls.target);
      }, null, easeInOut);
    }

    function shortestAngle(from, to) {
      var d = (to - from) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return d;
    }

    // pointer handling ------------------------------------------------------------
    var dom = renderer.domElement;
    var pointers = new Map();
    var dragMoved = 0, downTime = 0, pinchDist = 0, panMode = false;
    var gestureHadPinch = false;

    function ndcFromEvent(e) {
      var rect = dom.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
    }

    /** Square under the pointer, or -1. */
    function squareFromEvent(e) {
      raycaster.setFromCamera(ndcFromEvent(e), camera);
      // Pieces first (they visually own their square).
      var hits = raycaster.intersectObjects(piecesGroup.children, true);
      for (var i = 0; i < hits.length; i++) {
        var o = hits[i].object;
        while (o && !o.userData.pieceGroup) o = o.parent;
        if (o && o.userData.pieceGroup) {
          var entry = null;
          for (var s = 0; s < 64; s++) if (bySquare[s] && bySquare[s].group === o.userData.pieceGroup) { entry = s; break; }
          if (entry != null && !bySquare[entry].captured) return entry;
        }
      }
      var ph = raycaster.intersectObject(pickPlane);
      if (ph.length) {
        var p = ph[0].point;
        var f = Math.round(p.x + 3.5), r = Math.round(p.z + 3.5);
        if (f >= 0 && f < 8 && r >= 0 && r < 8) return r * 8 + f;
      }
      return -1;
    }

    function onPointerDown(e) {
      dom.setPointerCapture && dom.setPointerCapture(e.pointerId);
      if (pointers.size === 0) { dragMoved = 0; downTime = performance.now(); gestureHadPinch = false; }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      panMode = e.button === 2 || e.button === 1 || e.shiftKey;
      if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        gestureHadPinch = true;
      }
    }

    function onPointerMove(e) {
      if (!pointers.has(e.pointerId)) {
        // Hover (no button pressed).
        if (callbacks.onHover) callbacks.onHover(squareFromEvent(e));
        return;
      }
      var prev = pointers.get(e.pointerId);
      var dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragMoved += Math.abs(dx) + Math.abs(dy);

      if (pointers.size === 2) {
        // Pinch zoom + two-finger pan.
        var pts = Array.from(pointers.values());
        var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchDist > 0) controls.dRadius = clampRadius(controls.dRadius * (pinchDist / d));
        pinchDist = d;
        controls.dTarget.x -= dx * 0.004 * controls.radius * 0.12;
        controls.dTarget.z -= dy * 0.004 * controls.radius * 0.12;
        clampTarget();
        return;
      }
      if (panMode) {
        controls.dTarget.x -= (dx * 0.0016) * controls.radius;
        controls.dTarget.z -= (dy * 0.0016) * controls.radius;
        clampTarget();
      } else {
        controls.dTheta -= dx * 0.0055;
        controls.dPhi = Math.min(1.45, Math.max(0.10, controls.dPhi - dy * 0.0045));
      }
    }

    function onPointerUp(e) {
      var sizeBefore = pointers.size;
      var wasClick = !gestureHadPinch && dragMoved < 7 &&
        (performance.now() - downTime) < 500 && sizeBefore === 1 && !panMode;
      pointers.delete(e.pointerId);
      if (wasClick) {
        var s = squareFromEvent(e);
        if (s >= 0 && callbacks.onSquareClick) callbacks.onSquareClick(s);
      }
    }

    function onWheel(e) {
      e.preventDefault();
      controls.dRadius = clampRadius(controls.dRadius * Math.pow(1.0011, e.deltaY));
    }

    function onContextMenu(e) { e.preventDefault(); }

    function clampRadius(r) { return Math.min(34, Math.max(5.5, r)); }
    function clampTarget() {
      controls.dTarget.x = Math.min(6, Math.max(-6, controls.dTarget.x));
      controls.dTarget.z = Math.min(6, Math.max(-6, controls.dTarget.z));
    }

    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerup', onPointerUp);
    dom.addEventListener('pointercancel', onPointerUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('contextmenu', onContextMenu);

    // --- resize -------------------------------------------------------------------
    var fitFactor = 1;
    function resize() {
      var w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      var aspect = w / h;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      // Pull the camera back on narrow (portrait) screens so the board fits.
      var f = Math.max(1, Math.min(2.5, 1.12 / aspect));
      if (Math.abs(f - fitFactor) > 0.01) {
        var ratio = f / fitFactor;
        controls.radius *= ratio;
        controls.dRadius *= ratio;
        fitFactor = f;
      }
    }
    window.addEventListener('resize', resize);

    // --- frame loop -----------------------------------------------------------------
    function tick() {
      if (!running) return;
      requestAnimationFrame(tick);
      var dt = Math.min(clock.getDelta(), 0.05);

      // Damped camera.
      var k = 1 - Math.pow(0.0001, dt); // fast but smooth approach
      controls.theta += (controls.dTheta - controls.theta) * k;
      controls.phi += (controls.dPhi - controls.phi) * k;
      controls.radius += (controls.dRadius - controls.radius) * k;
      controls.target.lerp(controls.dTarget, k);
      applyCamera();

      // Piece hover-lift easing (yield to move tweens via tweenMoving).
      for (var s2 = 0; s2 < 64; s2++) {
        var entry = bySquare[s2];
        if (!entry || entry.captured) continue;
        var cur = entry.group.userData.liftY || 0;
        var next = cur + (entry.lift - cur) * Math.min(1, dt * 12);
        entry.group.userData.liftY = next;
        if (!tweenMoving(entry)) entry.group.position.y = next;
      }

      // Contact shadows follow their pieces; fade/grow while airborne.
      for (var pi = 0; pi < allPieces.length; pi++) {
        var en = allPieces[pi];
        if (!en.blob) continue;
        var h = Math.max(0, en.group.position.y);
        en.blob.position.x = en.group.position.x;
        en.blob.position.z = en.group.position.z;
        var bs = en.group.scale.x * (1 + h * 0.45);
        en.blob.scale.set(bs, bs, 1);
        en.blob.material.opacity = 0.55 / (1 + h * 2.4);
      }

      // Check highlight pulse.
      if (checkMesh.visible) {
        checkMesh.material.opacity = 0.55 + Math.sin(clock.elapsedTime * 4.5) * 0.2;
      }

      stepTweens(dt);
      renderer.render(scene, camera);
    }

    /** True while a tween owns this group's position (so lift logic yields). */
    function tweenMoving(entry) {
      for (var i = 0; i < tweens.length; i++) if (tweens[i].owner === entry.group) return true;
      return false;
    }

    // --- api -----------------------------------------------------------------------
    var api = {
      resize: resize,
      flyTo: flyTo,
      presets: PRESETS,
      setSelected: setSelected,
      setHover: setHover,
      setLastMove: setLastMove,
      setCheckSquare: setCheckSquare,
      showLegalMoves: showLegalMoves,
      clearLegalMoves: clearLegalMoves,
      setLifted: setLifted,
      animateMove: animateMove,
      setPiecesFromEngine: function (opts) { renderBoard(engine.board, opts || {}); },
      showBoard: function (board, opts) { renderBoard(board, opts || {}); },
      restoreCaptured: restoreCaptured,
      syncPieces: syncPieces,
      pieceAt: pieceAt,
      getScene: function () { return scene; },
      getMaterials: function () { return materials; },
      camera: camera,
      controls: controls
    };

    resize(); // apply portrait fit on load
    renderBoard(engine.board, { intro: true });
    applyCamera();
    tick();

    api.dispose = function () {
      disposed = true;
      running = false;
      window.removeEventListener('resize', resize);
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('pointercancel', onPointerUp);
      dom.removeEventListener('wheel', onWheel);
      dom.removeEventListener('contextmenu', onContextMenu);
      renderer.dispose();
      if (dom.parentNode) dom.parentNode.removeChild(dom);
    };

    return api;
  }

  return { create: create, squareToWorld: squareToWorld };
});
