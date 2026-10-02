/**
 * pieces.js — Staunton-style piece geometry built from Three.js primitives.
 *
 * Every piece is a THREE.Group whose origin sits at the center of its base
 * (y = 0 at the board surface). Profiles are turned on a lathe for the
 * turned-wood look (plinth -> collar -> stem -> head), with extra geometry
 * for the parts a lathe can't do: the knight's head, the rook's battlements,
 * the bishop's mitre slit and the king's cross.
 *
 * Heights follow real Staunton proportions relative to a 1-unit square:
 *   pawn 0.82, rook 1.00, knight 1.08, bishop 1.18, queen 1.42, king 1.58.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    try { module.exports = factory(require('three')); }
    catch (e) { module.exports = factory(null); }
  } else root.Pieces = factory(root.THREE || null);
})(typeof self !== 'undefined' ? self : this, function (THREE) {
  'use strict';

  if (!THREE) throw new Error('pieces.js requires THREE to be loaded first');

  var SEG = 28; // lathe / radial segments

  /** Helper: lathe from [ [radius, y], ... ] points. */
  function lathe(points, material) {
    var pts = points.map(function (p) { return new THREE.Vector2(p[0], p[1]); });
    var geo = new THREE.LatheGeometry(pts, SEG);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, material);
  }

  function mesh(geo, material) { return new THREE.Mesh(geo, material); }

  function torus(r, tube, material) {
    return mesh(new THREE.TorusGeometry(r, tube, 14, SEG), material);
  }

  // Turned body shared by several pieces: plinth, two collars, tapering stem.
  // Returns the lathe mesh; `h` = total body height before the head goes on.
  function body(material, rBase, h) {
    return lathe([
      [0.001, 0],
      [rBase, 0],
      [rBase, 0.045],
      [rBase * 0.94, 0.075],
      [rBase * 0.99, 0.10],        // lower collar groove
      [rBase * 0.80, 0.135],
      [rBase * 0.62, 0.19],
      [rBase * 0.56, h * 0.32],
      [rBase * 0.52, h * 0.55],
      [rBase * 0.58, h * 0.72],    // upper swell
      [rBase * 0.50, h * 0.85],
      [rBase * 0.44, h]
    ], material);
  }

  function collar(r, y, material) {
    var t = torus(r, r * 0.16, material);
    t.rotation.x = Math.PI / 2;
    t.position.y = y;
    return t;
  }

  var builders = {

    // ------------------------------------------------------------------ pawn
    pawn: function (material) {
      var g = new THREE.Group();
      var h = 0.50;
      g.add(body(material, 0.28, h));
      g.add(collar(0.16, h + 0.015, material));
      // Head: classic sphere.
      var head = mesh(new THREE.SphereGeometry(0.155, 22, 16), material);
      head.position.y = h + 0.15;
      g.add(head);
      // Collar under the head.
      var neck = lathe([[0.001, h + 0.02], [0.13, h + 0.03], [0.145, h + 0.06], [0.10, h + 0.09]], material);
      g.add(neck);
      return g;
    },

    // ------------------------------------------------------------------ rook
    rook: function (material) {
      var g = new THREE.Group();
      var h = 0.62;
      g.add(body(material, 0.30, h));
      // Slightly flared cylindrical top section.
      var top = lathe([
        [0.001, h], [0.21, h], [0.225, h + 0.16], [0.235, h + 0.17], [0.235, h + 0.27], [0.21, h + 0.28]
      ], material);
      g.add(top);
      // Battlements: 4 merlons with gaps (rectangular, Staunton style).
      for (var i = 0; i < 4; i++) {
        var a = (i / 4) * Math.PI * 2;
        var merlon = mesh(new THREE.BoxGeometry(0.115, 0.10, 0.075), material);
        merlon.position.set(Math.cos(a) * 0.155, h + 0.325, Math.sin(a) * 0.155);
        merlon.rotation.y = -a;
        g.add(merlon);
      }
      g.add(collar(0.24, h + 0.02, material));
      return g;
    },

    // ---------------------------------------------------------------- knight
    knight: function (material) {
      var g = new THREE.Group();
      var h = 0.42;
      g.add(body(material, 0.30, h));
      g.add(collar(0.20, h + 0.01, material));

      // Horse head assembled from angled boxes: neck, head, muzzle, ears.
      var neck = mesh(new THREE.BoxGeometry(0.24, 0.42, 0.28), material);
      neck.position.set(0, h + 0.24, 0.02);
      neck.rotation.x = -0.28;                       // leans forward
      g.add(neck);

      var head = mesh(new THREE.BoxGeometry(0.20, 0.20, 0.34), material);
      head.position.set(0, h + 0.47, 0.10);
      head.rotation.x = 0.35;                        // muzzle dips down
      g.add(head);

      var muzzle = mesh(new THREE.BoxGeometry(0.15, 0.13, 0.14), material);
      muzzle.position.set(0, h + 0.41, 0.27);
      muzzle.rotation.x = 0.5;
      g.add(muzzle);

      // Mane: thin slab down the back of the neck.
      var mane = mesh(new THREE.BoxGeometry(0.06, 0.40, 0.16), material);
      mane.position.set(0, h + 0.26, -0.115);
      mane.rotation.x = -0.28;
      g.add(mane);

      // Ears: two small cones.
      for (var i = -1; i <= 1; i += 2) {
        var ear = mesh(new THREE.ConeGeometry(0.045, 0.13, 8), material);
        ear.position.set(i * 0.065, h + 0.60, -0.02);
        ear.rotation.x = -0.25;
        g.add(ear);
      }
      // Eyes: two tiny darker spheres — use the same material but inset; a
      // separate dark material would need per-color pieces, so keep silhouette.
      return g;
    },

    // ---------------------------------------------------------------- bishop
    bishop: function (material) {
      var g = new THREE.Group();
      var h = 0.62;
      g.add(body(material, 0.29, h));
      g.add(collar(0.15, h + 0.015, material));
      // Mitre: pointed dome (sphere squashed into an egg) on a small neck.
      var neck = lathe([[0.001, h + 0.02], [0.12, h + 0.03], [0.135, h + 0.06], [0.10, h + 0.09]], material);
      g.add(neck);
      var mitre = mesh(new THREE.SphereGeometry(0.165, 22, 18), material);
      mitre.scale.set(1, 1.55, 1);
      mitre.position.y = h + 0.25;
      g.add(mitre);
      // The bishop's slit: a thin tilted torus wrapped around the mitre.
      var slit = torus(0.155, 0.018, material);
      slit.rotation.x = Math.PI / 2;
      slit.rotation.z = 0.5;
      slit.scale.set(1, 1, 0.36);
      slit.position.y = h + 0.28;
      g.add(slit);
      // Top ball.
      var ball = mesh(new THREE.SphereGeometry(0.055, 14, 10), material);
      ball.position.y = h + 0.50;
      g.add(ball);
      return g;
    },

    // ----------------------------------------------------------------- queen
    queen: function (material) {
      var g = new THREE.Group();
      var h = 0.78;
      g.add(body(material, 0.32, h));
      g.add(collar(0.17, h + 0.015, material));
      // Crown: flared cup.
      var crown = lathe([
        [0.001, h + 0.02], [0.10, h + 0.03], [0.12, h + 0.07], [0.115, h + 0.14],
        [0.20, h + 0.26], [0.215, h + 0.28]
      ], material);
      g.add(crown);
      var crenel = torus(0.185, 0.028, material);
      crenel.rotation.x = Math.PI / 2;
      crenel.position.y = h + 0.28;
      g.add(crenel);
      // Points around the crown rim (8 small cones).
      for (var i = 0; i < 8; i++) {
        var a = (i / 8) * Math.PI * 2;
        var spike = mesh(new THREE.ConeGeometry(0.035, 0.11, 8), material);
        spike.position.set(Math.cos(a) * 0.165, h + 0.335, Math.sin(a) * 0.165);
        g.add(spike);
      }
      // Orb on top.
      var orb = mesh(new THREE.SphereGeometry(0.065, 16, 12), material);
      orb.position.y = h + 0.38;
      g.add(orb);
      return g;
    },

    // ------------------------------------------------------------------ king
    king: function (material) {
      var g = new THREE.Group();
      var h = 0.88;
      g.add(body(material, 0.34, h));
      g.add(collar(0.18, h + 0.015, material));
      // Crown: flared cup with a smooth band (taller than the queen's).
      var crown = lathe([
        [0.001, h + 0.02], [0.11, h + 0.03], [0.13, h + 0.08], [0.125, h + 0.16],
        [0.21, h + 0.30], [0.225, h + 0.32]
      ], material);
      g.add(crown);
      var band = torus(0.195, 0.030, material);
      band.rotation.x = Math.PI / 2;
      band.position.y = h + 0.32;
      g.add(band);
      // Cross on top (two boxes) — the king's distinguishing mark.
      var stem = mesh(new THREE.BoxGeometry(0.055, 0.20, 0.055), material);
      stem.position.y = h + 0.42;
      g.add(stem);
      var arms = mesh(new THREE.BoxGeometry(0.16, 0.055, 0.055), material);
      arms.position.y = h + 0.45;
      g.add(arms);
      // Small orb between crown and cross.
      var orb = mesh(new THREE.SphereGeometry(0.06, 16, 12), material);
      orb.position.y = h + 0.355;
      g.add(orb);
      return g;
    }
  };

  // Engine letter -> builder name.
  var TYPE_ALIASES = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };

  /**
   * Build a piece. `type` is 'P'|'N'|'B'|'R'|'Q'|'K'.
   * The returned group has userData = { pieceType: type } and all child
   * meshes carry userData.pieceGroup = group so raycasting can map a hit
   * back to the piece.
   */
  function createPiece(type, material) {
    var builder = builders[TYPE_ALIASES[type] || type];
    if (!builder) throw new Error('Unknown piece type: ' + type);
    var g = builder(material);
    g.userData.pieceType = type;
    g.traverse(function (o) {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.userData.pieceGroup = g;
      }
    });
    return g;
  }

  return { createPiece: createPiece };
});
