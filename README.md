# Gambit 3D — Chess

A fully playable, polished 3D chess game in a single self-contained web app:
Three.js rendering, a perft-verified rules engine, a minimax AI with three
difficulty levels, and a responsive UI — no build step, no external assets,
no network needed at runtime.

![modes](https://img.shields.io/badge/modes-pass%20%26%20play%20%7C%20vs%20AI-gold)

## Quick start

Everything (including Three.js) is vendored locally, so the simplest start is:

1. Double-click `index.html` — or serve the folder for a cleaner origin:

   ```bash
   # any one of these, from this directory:
   npx http-server -p 8080
   python -m http.server 8080
   ```

2. Open `http://localhost:8080` in a modern browser (Chrome / Edge / Firefox / Safari).

No install, no build. Click a piece to see its legal squares, click a
highlighted square to move.

## Features

**Rules — complete and verified**

- Full legal move generation: castling (both sides, with every legality
  condition), en passant (including the en-passant pin), pawn promotion with
  a UI picker (queen / rook / bishop / knight)
- Check, checkmate, stalemate
- Draws: threefold repetition, fifty-move rule, insufficient material
- Standard Algebraic Notation move list with disambiguation, `+`/`#` suffixes
- Correctness is proven by a perft test suite (see Testing) — the move
  generator matches published node counts for all six reference positions

**Game play**

- Local two-player (pass & play) and player-vs-AI
- AI: negamax + alpha-beta, MVV-LVA move ordering, quiescence search,
  piece-square tables (with an endgame king table)
  - **Easy** — depth 1, picks randomly among near-best moves
  - **Medium** — depth 2 + quiescence
  - **Hard** — depth 4 + quiescence
- The AI search is chunked (a few milliseconds per animation frame), so the
  page never freezes while the computer thinks; a progress bar shows its work
- Undo (retracts the AI reply too in vs-AI mode), New Game, click any move in
  the history panel to view that board state, arrow keys to step through the
  game, `Esc` to deselect / close dialogs, `U` to undo
- Captured pieces with material advantage, turn + check indicators, and a
  game-over modal with the result and reason

**3D scene**

- Wooden board rendered from a procedurally painted texture: grain, frame
  line, baked corner ambient occlusion, file/rank labels
- Staunton-style pieces built from lathe profiles + primitives (no external
  models), with procedural ivory-marble / ebony-wood texture and bump maps
- Soft studio backdrop room (wall paneling, glowing window panels, fog),
  dark table, equirectangular environment for reflections
- Key light with soft shadows, opposite fill light with a second shadow pass,
  and fake contact shadows under every piece that follow moves and arcs
- Smooth eased animations: moves (higher arc for knights), captures (victim
  flies to a side tray), castling (rook follows), promotions (mesh swap +
  hop), and a staggered drop-in on every new game
- Selection brackets, legal-move dots / capture rings, last-move highlight,
  pulsing red ring on a checked king
- Camera: orbit / zoom / pan (mouse or touch), presets for White side, Black
  side and top-down, plus an automatic portrait fit for phones

**UI / misc**

- Sound effects generated with WebAudio (no audio files): move, capture,
  castle, check, promote, game end — toggle in the top bar or Settings
- Settings panel: sound, camera preset, game mode, play-as side, AI difficulty
- Responsive: the side panel becomes a swipeable bottom sheet on phones

## Project structure

```
chess3d/
├── index.html            # shell: viewport, top bar, panel, modals, script tags
├── css/
│   └── style.css         # theme, layout, bottom-sheet responsive rules
├── js/
│   ├── engine.js         # pure chess rules (no rendering dependencies)
│   ├── ai.js             # negamax + alpha-beta + quiescence + PSTs
│   ├── textures.js       # procedural canvas textures (wood, marble, room, SFX-free)
│   ├── pieces.js         # Staunton piece geometry from primitives
│   ├── sound.js          # WebAudio synthesized sound effects
│   ├── scene.js          # Three.js scene: board, lights, camera, picking, animations
│   └── app.js            # UI controller: state, panels, modals, AI think loop
├── tests/
│   ├── engine.test.js    # perft + rule scenarios (40 tests)
│   └── ai.test.js        # tactics, legality, self-play, timing (12 tests)
└── vendor/
    └── three.min.js      # Three.js r128 (UMD), vendored
```

The layers are strictly separated: `engine.js` and `ai.js` are DOM-free and
run unchanged in Node, `scene.js` knows nothing about whose turn it is, and
`app.js` is the only module that touches both worlds.

## Testing

The engine is validated against the standard perft suite (move-tree node
counts from chessprogramming.org), which exercises castling legality,
en-passant pins, promotions and check evasions exhaustively:

```bash
node tests/engine.test.js     # perft + rule scenarios  -> 40 passed
node tests/ai.test.js         # tactics + legality      -> 12 passed
```

## Controls

| Action            | Mouse / Trackpad            | Touch                    |
| ----------------- | --------------------------- | ------------------------ |
| Select / move     | Left click                  | Tap                      |
| Orbit             | Left-drag                   | One-finger drag          |
| Zoom              | Scroll wheel                | Pinch                    |
| Pan               | Right-drag / Shift-drag     | Two-finger drag          |
| Cycle camera view | 🎥 button                   | 🎥 button                |
| History browsing  | Click a move, ← / →         | Tap a move               |

## Browser notes

- Any modern browser with WebGL. The AudioContext is created on the first
  user gesture (browser autoplay policy), so sounds start after the first tap.
- Everything is computed and rendered locally — the page works fully offline.
