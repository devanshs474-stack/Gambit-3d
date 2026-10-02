/**
 * sound.js — tiny WebAudio SFX synth. No external audio files: every effect
 * is generated (wood thocks from filtered noise + sine bodies, UI blips from
 * short envelopes). The AudioContext is created/resumed lazily on the first
 * user gesture to satisfy browser autoplay policies.
 *
 * API:
 *   Sound.setEnabled(bool)   — master toggle (settings panel)
 *   Sound.play(name)         — 'select' | 'move' | 'capture' | 'castle' |
 *                              'check' | 'promote' | 'gameWin' | 'gameLoss' |
 *                              'gameDraw' | 'error'
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sound = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ctx = null, master = null, enabled = true;

  function ensure() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  // Unlock on the first interaction anywhere.
  if (typeof window !== 'undefined') {
    var unlock = function () { ensure(); window.removeEventListener('pointerdown', unlock); };
    window.addEventListener('pointerdown', unlock, { once: true });
  }

  /** Simple enveloped oscillator. */
  function tone(freq, dur, type, gain, when, slideTo) {
    var t0 = ctx.currentTime + (when || 0);
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  /** Band-passed noise burst (the "wood" in a wooden thock). */
  function knock(dur, freq, gain, when) {
    var t0 = ctx.currentTime + (when || 0);
    var n = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 1.4;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(t0);
  }

  var fx = {
    select: function () { tone(1150, 0.05, 'sine', 0.10); knock(0.03, 2400, 0.05); },
    move: function () { knock(0.07, 900, 0.55); tone(190, 0.10, 'sine', 0.22, 0, 150); },
    capture: function () {
      knock(0.10, 650, 0.85);
      tone(150, 0.16, 'sine', 0.32, 0, 95);
      knock(0.05, 1600, 0.22, 0.03);
    },
    castle: function () {
      knock(0.06, 900, 0.5); tone(190, 0.09, 'sine', 0.2, 0, 150);
      knock(0.06, 900, 0.5, 0.13); tone(190, 0.09, 'sine', 0.2, 0.13, 150);
    },
    check: function () {
      tone(660, 0.11, 'triangle', 0.22);
      tone(880, 0.16, 'triangle', 0.22, 0.10);
    },
    promote: function () {
      tone(523, 0.10, 'triangle', 0.20);
      tone(659, 0.10, 'triangle', 0.20, 0.09);
      tone(784, 0.18, 'triangle', 0.22, 0.18);
    },
    gameWin: function () {
      [523, 659, 784, 1047].forEach(function (f, i) {
        tone(f, 0.22, 'triangle', 0.22, i * 0.14);
      });
    },
    gameLoss: function () {
      [392, 330, 262].forEach(function (f, i) {
        tone(f, 0.30, 'sine', 0.24, i * 0.17);
      });
    },
    gameDraw: function () {
      [440, 440, 349].forEach(function (f, i) {
        tone(f, 0.24, 'sine', 0.20, i * 0.16);
      });
    },
    error: function () { tone(130, 0.09, 'square', 0.08); }
  };

  return {
    setEnabled: function (v) { enabled = !!v; },
    isEnabled: function () { return enabled; },
    play: function (name) {
      if (!enabled) return;
      if (!ensure()) return;
      var fn = fx[name];
      if (fn) {
        try { fn(); } catch (e) { /* audio must never break the game */ }
      }
    }
  };
});
