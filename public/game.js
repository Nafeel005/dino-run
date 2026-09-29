(() => {
  'use strict';

  // Gameplay tuning
  const CONFIG = {
    // 👋 Change this to your GitHub username, push, and look for it on the live game screen
    githubUsername: 'thivindu',

    startSpeed: 6,
    maxSpeed: 13,
    acceleration: 0.0015,   // speed gained per frame
    gravity: 0.65,
    jumpVelocity: 12,
    birdsAfterScore: 250,   // birds start appearing after this score
    startText: 'PRESS SPACE OR TAP TO START',
    gameOverText: 'G A M E   O V E R',
    restartText: 'PRESS SPACE OR TAP TO RESTART',
    coyoteMs: 100,          // grace period to still jump after leaving ground
    jumpBufferMs: 120,      // jump pressed slightly early still counts on landing
    jumpCutVelocity: 5,     // releasing jump early cuts upward velocity (variable jump)
    doubleJumpVelocity: 11, // upward velocity of the mid-air double jump
    coinValue: 25,          // score bonus per coin
    coinAfterScore: 100,    // coins start appearing after this score
    shieldAfterScore: 300,  // shields start appearing after this score
    dayNightCycle: 800,     // score points per full day/night loop
  };

  const W = 800;
  const H = 220;
  const GROUND_Y = 190;
  const HI_KEY = 'dino-run-hi';
  const MUTE_KEY = 'dino-run-muted';
  const MISSIONS_KEY = 'dino-run-missions';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // ---------- setup ----------

  function setupCanvas() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  let baseColors = { ink: '#535353', bg: '#ffffff', cloud: '#d0d0d0' };
  let colors = { ...baseColors };
  const NIGHT = { ink: '#e6edf3', bg: '#0d1117', cloud: '#30363d' };
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    baseColors = {
      ink: v('--ink', '#535353'),
      bg: v('--game-bg', '#ffffff'),
      cloud: v('--cloud', '#d0d0d0'),
    };
    colors = { ...baseColors };
  }

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mixHex(a, b, t) {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }

  // Day/night: 0 = day, 1 = night. Loops every CONFIG.dayNightCycle points.
  // Sunset peaks in between so the sky melts through a warm gradient.
  function skyPhase() {
    return (score % CONFIG.dayNightCycle) / CONFIG.dayNightCycle; // 0..1
  }
  function nightFactor() {
    const p = skyPhase();
    if (p < 0.55) return 0;
    if (p < 0.7) return smooth((p - 0.55) / 0.15);
    if (p < 0.9) return 1;
    return 1 - smooth((p - 0.9) / 0.1);
  }
  function sunsetFactor() {
    const p = skyPhase();
    if (p < 0.48 || p > 0.78) return 0;
    if (p < 0.58) return smooth((p - 0.48) / 0.1);
    if (p < 0.68) return 1;
    return 1 - smooth((p - 0.68) / 0.1);
  }
  function applyPalette() {
    const n = nightFactor();
    colors = {
      ink: mixHex(baseColors.ink, NIGHT.ink, n),
      bg: mixHex(baseColors.bg, NIGHT.bg, n),
      cloud: mixHex(baseColors.cloud, NIGHT.cloud, n),
    };
    return n;
  }

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  };

  let muted = storage.get(MUTE_KEY) === '1';
  let audio = null;
  function beep(freq, duration) {
    if (muted) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') {
        // Sound is optional: resume() rejects when blocked outside a user
        // gesture, so swallow the rejection instead of triggering an
        // unhandled promise rejection warning.
        try {
          const resumed = audio.resume();
          if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
        } catch { /* ignore sync resume errors */ }
      }
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.value = 0.04;
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + duration);
    } catch { /* audio is optional */ }
  }
  function jingle(notes) {
    notes.forEach((f, i) => setTimeout(() => beep(f, 0.07), i * 80));
  }

  const rand = (min, max) => min + Math.random() * (max - min);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ---------- state ----------

  let state = 'ready'; // ready | running | paused | over
  let dino, obstacles, clouds, stars, particles, floaters, powerups, coins;
  let speed, distance, score, bonus, coinCount, nextSpawnIn, nextPowerIn, nextCoinIn;
  let runNearMisses, runCoins, runUnlocks;
  let gameOverAt, flashUntil, shakeUntil, invulnUntil, isNewBest;
  let hiScore = Number(storage.get(HI_KEY)) || 0;
  let dustTimer = 0;

  // Missions: persisted unlocks + per-run progress
  const MISSION_DEFS = [
    { id: 'scout', name: 'SCOUT: reach 500 pts', check: () => score >= 500 },
    { id: 'daredevil', name: 'DAREDEVIL: 3 near-misses in one run', check: () => runNearMisses >= 3 },
    { id: 'collector', name: 'COLLECTOR: grab 5 coins in one run', check: () => runCoins >= 5 },
  ];
  let unlockedMissions = [];
  try {
    unlockedMissions = JSON.parse(storage.get(MISSIONS_KEY) || '[]');
    if (!Array.isArray(unlockedMissions)) unlockedMissions = [];
  } catch { unlockedMissions = []; }

  function checkMissions() {
    for (const m of MISSION_DEFS) {
      if (!unlockedMissions.includes(m.id) && !runUnlocks.includes(m.id) && m.check()) {
        runUnlocks.push(m.id);
        unlockedMissions.push(m.id);
        storage.set(MISSIONS_KEY, JSON.stringify(unlockedMissions));
        floater(`MISSION: ${m.name}`, W / 2, 78);
        jingle([523, 659, 784, 1047]);
      }
    }
  }

  function reset() {
    dino = {
      x: 50, lift: 0, vy: 0, onGround: true, ducking: false,
      squash: 1, flip: 0, airJumps: 0, coyoteAt: 0, bufferedAt: -9999, jumpHeld: false,
    };
    obstacles = [];
    powerups = [];
    coins = [];
    particles = [];
    floaters = [];
    speed = CONFIG.startSpeed;
    distance = 0;
    score = 0;
    bonus = 0;
    coinCount = 0;
    runNearMisses = 0;
    runCoins = 0;
    runUnlocks = [];
    nextSpawnIn = 400;
    nextPowerIn = 900;
    nextCoinIn = 500;
    flashUntil = 0;
    shakeUntil = 0;
    invulnUntil = 0;
    isNewBest = false;
    dinoShield(false);
  }

  function dinoShield(on) { dino.shield = on; }

  function initClouds() {
    clouds = Array.from({ length: 4 }, (_, i) => ({ x: 120 + i * 220 + rand(-40, 40), y: rand(20, 90) }));
    stars = Array.from({ length: 40 }, () => ({ x: rand(0, W), y: rand(0, 140), s: rand(0.5, 1.8) }));
  }

  // ---------- particles & floating text ----------

  function burst(x, y, n, spread, up) {
    for (let i = 0; i < n; i++) {
      particles.push({
        x, y,
        vx: rand(-spread, spread),
        vy: rand(-up, up * 0.4),
        life: 0, maxLife: rand(20, 45),
        size: rand(1, 3.5),
      });
    }
  }
  function dustPuff(strength = 1) {
    burst(dino.x + 12, GROUND_Y - 1, Math.round(2 * strength), 1.6, 2.2);
  }
  function floater(text, x, y, color) {
    floaters.push({ text, x, y, life: 0, maxLife: 70, color: color || null });
  }
  function updateParticles(dt) {
    for (const p of particles) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.12 * dt;
    }
    particles = particles.filter((p) => p.life < p.maxLife);
    for (const f of floaters) {
      f.life += dt;
      f.y -= 0.5 * dt;
    }
    floaters = floaters.filter((f) => f.life < f.maxLife);
  }

  // ---------- geometry ----------

  function dinoBox() {
    const ducking = dino.ducking && dino.onGround && (state === 'running' || state === 'paused');
    const w = ducking ? 58 : 44;
    const h = ducking ? 26 : 47;
    return { x: dino.x, y: GROUND_Y - dino.lift - h, w, h, ducking };
  }

  function obstacleBox(o) {
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  }

  function hits(a, b, pad = 6) {
    return a.x + pad < b.x + b.w - pad &&
            a.x + a.w - pad > b.x + pad &&
            a.y + pad < b.y + b.h - pad &&
            a.y + a.h - pad > b.y + pad;
  }

  // ---------- spawning ----------

  function spawnObstacle() {
    let o;
    if (score >= CONFIG.birdsAfterScore && Math.random() < 0.3) {
      // low: must jump · mid: duck or jump · high: run underneath
      const top = pick([GROUND_Y - 32, GROUND_Y - 62, GROUND_Y - 100]);
      o = { type: 'bird', x: W + 10, y: top, baseY: top, seed: rand(0, 6.28), w: 46, h: 32, passed: false };
    } else {
      const large = Math.random() < 0.5;
      const unit = large ? 25 : 17;
      const h = large ? 50 : 35;
      const maxCount = speed > 8 ? 3 : 2;
      const count = 1 + Math.floor(Math.random() * maxCount);
      const w = count * unit + (count - 1) * 2;
      o = { type: 'cactus', x: W + 10, y: GROUND_Y - h, w, h, unit, count, passed: false, wobble: 0 };
    }
    obstacles.push(o);
    nextSpawnIn = o.w + speed * rand(45, 85);
  }

  function spawnShield() {
    const y = pick([GROUND_Y - 70, GROUND_Y - 110]);
    powerups.push({ x: W + 10, y, w: 26, h: 26, seed: rand(0, 6.28) });
    nextPowerIn = speed * rand(160, 300);
  }

  function spawnCoinLine() {
    // arc of 5 coins: low arc reachable by jump, high arc needs double jump
    const high = Math.random() < 0.4;
    const baseY = high ? GROUND_Y - 120 : GROUND_Y - 60;
    for (let i = 0; i < 5; i++) {
      coins.push({
        x: W + 10 + i * 34,
        y: baseY - Math.sin((i / 4) * Math.PI) * 44,
        baseY: baseY - Math.sin((i / 4) * Math.PI) * 44,
        w: 16, h: 16, seed: rand(0, 6.28),
      });
    }
    nextCoinIn = speed * rand(120, 220);
  }

  // ---------- update ----------

  function jump() {
    const now = performance.now();
    if (dino.onGround || now - dino.coyoteAt < CONFIG.coyoteMs) {
      dino.vy = CONFIG.jumpVelocity;
      dino.onGround = false;
      dino.coyoteAt = 0;
      dino.squash = 1.28; // stretch
      dino.jumpHeld = true;
      dustPuff(2);
      beep(620, 0.05);
    } else if (dino.airJumps < 1) {
      // double jump: one extra hop mid-air with a flip
      dino.airJumps += 1;
      dino.vy = CONFIG.doubleJumpVelocity;
      dino.flip = 1;
      dino.squash = 1.2;
      dino.jumpHeld = true;
      burst(dino.x + 22, GROUND_Y - dino.lift, 10, 2, 3);
      beep(780, 0.06);
    } else {
      dino.bufferedAt = now; // try again on landing
    }
  }
  function cutJump() {
    dino.jumpHeld = false;
    if (!dino.onGround && dino.vy > CONFIG.jumpCutVelocity) {
      dino.vy = CONFIG.jumpCutVelocity; // variable jump height
    }
  }

  function update(dt) {
    if (state !== 'running') return;
    const now = performance.now();

    speed = Math.min(CONFIG.maxSpeed, speed + CONFIG.acceleration * dt);
    distance += speed * dt;

    const base = Math.floor(distance * 0.025);
    const newScore = base + bonus;
    if (Math.floor(newScore / 100) > Math.floor(score / 100)) {
      beep(880, 0.08);
      flashUntil = now + 900;
      floater(`${newScore} PTS — SPEED UP!`, W / 2, 60);
    }
    score = newScore;

    // squash recovery + flip animation
    dino.squash += (1 - dino.squash) * Math.min(1, 0.18 * dt);
    if (dino.flip > 0) dino.flip = Math.max(0, dino.flip - dt * 0.045);

    // dino physics (holding "down" mid-air = fast fall)
    if (!dino.onGround) {
      const g = CONFIG.gravity * (dino.ducking ? 3 : 1);
      dino.lift += dino.vy * dt;
      dino.vy -= g * dt;
      if (dino.lift <= 0) {
        dino.lift = 0;
        dino.vy = 0;
        dino.onGround = true;
        dino.coyoteAt = now;
        dino.airJumps = 0;
        dino.flip = 0;
        dino.squash = 0.68; // squash on land
        dustPuff(3);
        beep(200, 0.03);
        // buffered jump fires on landing
        if (now - dino.bufferedAt < CONFIG.jumpBufferMs) {
          dino.bufferedAt = -9999;
          jump();
        }
      }
    } else if (dino.coyoteAt === 0) {
      dino.coyoteAt = now;
    }

    // run dust
    dustTimer += dt;
    if (dino.onGround && dustTimer > 7) {
      dustTimer = 0;
      dustPuff(dino.ducking ? 2 : 1);
    }

    // obstacles
    nextSpawnIn -= speed * dt;
    if (nextSpawnIn <= 0) spawnObstacle();

    // shield powerups
    if (score >= CONFIG.shieldAfterScore && !dino.shield) {
      nextPowerIn -= speed * dt;
      if (nextPowerIn <= 0) spawnShield();
    }

    // coins
    if (score >= CONFIG.coinAfterScore) {
      nextCoinIn -= speed * dt;
      if (nextCoinIn <= 0) spawnCoinLine();
    }

    for (const o of obstacles) {
      o.x -= (o.type === 'bird' ? speed + 0.8 : speed) * dt;
      if (o.type === 'bird') o.y = o.baseY + Math.sin(now / 240 + o.seed) * 7;
      if (o.type === 'cactus' && o.wobble > 0) o.wobble -= dt;
    }
    obstacles = obstacles.filter((o) => o.x + o.w > -20);
    for (const p of powerups) {
      p.x -= speed * dt;
      p.y += Math.sin(now / 300 + p.seed) * 0.3 * dt;
    }
    powerups = powerups.filter((p) => p.x + p.w > -20);
    for (const c of coins) {
      c.x -= speed * dt;
      c.y = c.baseY + Math.sin(now / 280 + c.seed) * 3;
    }
    coins = coins.filter((c) => c.x + c.w > -20);

    // clouds
    for (const c of clouds) {
      c.x -= speed * 0.15 * dt;
      if (c.x < -60) { c.x = W + rand(0, 200); c.y = rand(20, 90); }
    }

    // shield pickup
    const d = dinoBox();
    for (let i = powerups.length - 1; i >= 0; i--) {
      const p = powerups[i];
      if (hits(d, p, 0)) {
        powerups.splice(i, 1);
        dinoShield(true);
        burst(p.x + 13, p.y + 13, 16, 2.5, 3.5);
        floater('SHIELD!', dino.x + 22, d.y - 14);
        jingle([660, 830, 990]);
      }
    }

    // coin pickup
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      if (hits(d, c, 2)) {
        coins.splice(i, 1);
        coinCount += 1;
        runCoins += 1;
        bonus += CONFIG.coinValue;
        score += CONFIG.coinValue;
        burst(c.x + 8, c.y + 8, 8, 2, 3);
        floater(`+${CONFIG.coinValue}`, c.x + 8, c.y - 10);
        jingle([1320, 1760]);
      }
    }

    // near-miss bonus: obstacle just passed without hitting
    for (const o of obstacles) {
      if (!o.passed && o.x + o.w < d.x) {
        o.passed = true;
        const dy = Math.min(
          Math.abs((d.y + d.h) - o.y),
          Math.abs(d.y - (o.y + o.h))
        );
        if (dy < 26) {
          bonus += 10;
          score += 10;
          runNearMisses += 1;
          o.wobble = 18;
          floater('+10 NEAR MISS', d.x + 10, d.y - 12);
          beep(1200, 0.06);
        }
      }
    }

    checkMissions();

    // collision (skip while briefly invulnerable after shield save)
    if (now >= invulnUntil && obstacles.some((o) => hits(d, obstacleBox(o)))) {
      if (dino.shield) {
        dinoShield(false);
        invulnUntil = now + 1500;
        shakeUntil = now + 220;
        // knock away the obstacle that saved us
        obstacles = obstacles.filter((o) => !hits(d, obstacleBox(o)));
        burst(d.x + 22, d.y + 20, 22, 3.5, 5);
        floater('SAVED!', d.x + 22, d.y - 14);
        jingle([500, 350, 250]);
      } else {
        gameOver();
      }
    }
  }

  function gameOver() {
    const now = performance.now();
    state = 'over';
    gameOverAt = now;
    shakeUntil = now + 350;
    beep(160, 0.25);
    burst(dino.x + 22, GROUND_Y - 30, 26, 4, 6);
    if (score > hiScore) {
      hiScore = score;
      isNewBest = true;
      storage.set(HI_KEY, String(hiScore));
      jingle([880, 1100, 1320]);
    }
  }

  function togglePause() {
    if (state === 'running') {
      state = 'paused';
      syncButtons();
    } else if (state === 'paused') {
      state = 'running';
      syncButtons();
    }
  }

  function toggleMute() {
    muted = !muted;
    storage.set(MUTE_KEY, muted ? '1' : '0');
    syncButtons();
    if (!muted) beep(880, 0.06);
  }

  // ---------- drawing ----------

  function rect(x, y, w, h) { ctx.fillRect(Math.round(x), Math.round(y), w, h); }

  function drawDino() {
    const b = dinoBox();
    // invulnerability blink
    if (state === 'running' && performance.now() < invulnUntil && Math.floor(performance.now() / 120) % 2 === 0) {
      return;
    }
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const bottom = b.y + b.h;
    const sy = Math.max(0.6, Math.min(1.4, dino.squash));
    const sx = 1 + (1 - sy) * 0.9;
    ctx.save();
    if (!b.ducking && dino.flip > 0) {
      ctx.translate(cx, cy);
      ctx.rotate((1 - dino.flip) * Math.PI * 2);
      ctx.translate(-cx, -cy);
    }
    ctx.translate(cx, bottom);
    ctx.scale(sx, sy);
    ctx.translate(-cx, -bottom);

    const x = b.x;
    const y = b.y;
    const running = state === 'running' && dino.onGround;
    const leg = running ? Math.floor(distance / 28) % 2 : -1;
    const dead = state === 'over';
    ctx.fillStyle = colors.ink;

    // shield ring
    if (dino.shield) {
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, b.y + b.h / 2, b.h * 0.75 + Math.sin(performance.now() / 200) * 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = colors.ink;
    }

    if (b.ducking) {
      rect(x, y + 2, 4, 8);          // tail
      rect(x + 2, y + 6, 38, 14);    // body
      rect(x + 38, y, 20, 12);       // head
      rect(x + 38, y + 12, 12, 3);   // jaw
      rect(x + 34, y + 18, 5, 2);    // arm
      rect(x + 10, y + 20, 5, leg === 0 ? 3 : 6);
      rect(x + 24, y + 20, 5, leg === 1 ? 3 : 6);
      ctx.fillStyle = colors.bg;
      rect(x + 42, y + 3, 3, 3);     // eye
      ctx.restore();
      return;
    }

    rect(x + 22, y, 22, 14);         // head
    rect(x + 22, y + 14, 12, 4);     // jaw
    rect(x + 22, y + 18, 10, 6);     // neck
    rect(x + 6, y + 20, 24, 14);     // body
    rect(x, y + 14, 4, 12);          // tail tip
    rect(x + 4, y + 20, 4, 10);      // tail
    rect(x + 30, y + 24, 6, 3);      // arm
    rect(x + 34, y + 24, 2, 5);      // hand

    // legs
    const leftLen = leg === 0 ? 7 : 13;
    const rightLen = leg === 1 ? 7 : 13;
    rect(x + 10, y + 34, 5, leftLen);
    rect(x + 10, y + 34 + leftLen - 2, 8, 2);
    rect(x + 22, y + 34, 5, rightLen);
    rect(x + 22, y + 34 + rightLen - 2, 8, 2);

    // eye
    ctx.fillStyle = colors.bg;
    if (dead) {
      rect(x + 25, y + 2, 6, 6);
      ctx.fillStyle = colors.ink;
      rect(x + 27, y + 4, 2, 2);
    } else {
      rect(x + 26, y + 3, 3, 3);
    }
    ctx.restore();
  }

  function drawCactus(x, y, w, h, wobble) {
    const tilt = wobble > 0 ? Math.sin(performance.now() / 60) * 1.5 : 0;
    ctx.save();
    ctx.translate(x + w / 2, y + h);
    ctx.rotate(tilt * Math.PI / 180);
    ctx.translate(-(x + w / 2), -(y + h));
    const stem = Math.max(5, Math.round(w * 0.36));
    const sx = x + (w - stem) / 2;
    const armW = Math.max(3, Math.round(w * 0.2));
    rect(sx, y, stem, h);
    // left arm
    rect(x, y + h * 0.25, armW, h * 0.35);
    rect(x, y + h * 0.55, sx - x + 1, armW);
    // right arm
    rect(x + w - armW, y + h * 0.15, armW, h * 0.35);
    rect(sx + stem - 1, y + h * 0.45, x + w - (sx + stem) + 1, armW);
    ctx.restore();
  }

  function drawObstacle(o) {
    ctx.fillStyle = colors.ink;
    if (o.type === 'cactus') {
      for (let i = 0; i < o.count; i++) {
        drawCactus(o.x + i * (o.unit + 2), o.y, o.unit, o.h, o.wobble);
      }
      return;
    }
    // bird (faces left, flaps + bobs)
    const flap = Math.floor(performance.now() / 160) % 2;
    const { x, y } = o;
    rect(x, y + 13, 4, 3);          // beak
    rect(x + 4, y + 10, 10, 8);     // head
    rect(x + 12, y + 12, 24, 8);    // body
    rect(x + 36, y + 12, 8, 4);     // tail
    if (flap) rect(x + 16, y, 8, 12);
    else rect(x + 16, y + 20, 8, 12);
    ctx.fillStyle = colors.bg;
    rect(x + 7, y + 12, 2, 2);      // eye
  }

  function drawShieldPickup(p) {
    const pulse = 1 + Math.sin(performance.now() / 180 + p.seed) * 0.12;
    ctx.save();
    ctx.translate(p.x + 13, p.y + 13);
    ctx.scale(pulse, pulse);
    ctx.fillStyle = colors.ink;
    rect(-9, -9, 18, 3);
    rect(-9, 6, 18, 3);
    rect(-9, -9, 3, 18);
    rect(6, -9, 3, 18);
    rect(-4, -4, 8, 8);
    ctx.fillStyle = colors.bg;
    rect(-2, -5, 4, 10);
    rect(-5, -2, 10, 4);
    ctx.restore();
  }

  function drawCoin(c) {
    const pulse = 1 + Math.sin(performance.now() / 220 + c.seed) * 0.15;
    ctx.save();
    ctx.translate(c.x + 8, c.y + 8);
    ctx.scale(pulse, pulse);
    ctx.fillStyle = colors.ink;
    // pixel diamond coin
    rect(-3, -8, 6, 16);
    rect(-6, -5, 12, 10);
    rect(-8, -2, 16, 4);
    ctx.fillStyle = colors.bg;
    rect(-2, -4, 4, 8);
    ctx.restore();
  }

  // Gradient sky: day -> warm sunset -> night, with travelling sun + moon
  function drawSky(night, sunset) {
    const top = mixHex(mixHex(baseColors.bg, '#ffd9a0', sunset * 0.55), '#0b1026', night);
    const horizon = mixHex(mixHex(baseColors.bg, '#ff8c42', sunset * 0.75), NIGHT.bg, night);
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    g.addColorStop(0, top);
    g.addColorStop(1, horizon);
    ctx.fillStyle = g;
    ctx.fillRect(-10, -10, W + 20, GROUND_Y + 10);

    const p = skyPhase();
    // sun arcs down as sunset approaches
    if (night < 0.9) {
      const t = Math.min(1, Math.max(0, (p - 0.25) / 0.45)); // 0→1 across afternoon
      const sx = W - 90 - t * (W - 220);
      const sy = 34 + Math.sin(t * Math.PI) * -6 + t * 78;
      ctx.save();
      ctx.globalAlpha = 1 - night;
      ctx.fillStyle = mixHex('#ffc93c', '#ff6b35', sunset);
      rect(sx - 9, sy - 9, 18, 18);
      ctx.fillStyle = mixHex('#ffe89d', '#ffd9a0', sunset);
      rect(sx - 5, sy - 5, 10, 10);
      ctx.restore();
    }
  }

  function drawCloud(c) {
    ctx.fillStyle = colors.cloud;
    rect(c.x + 8, c.y, 24, 4);
    rect(c.x + 4, c.y + 4, 36, 4);
    rect(c.x, c.y + 8, 46, 4);
  }

  function drawParallax(night) {
    // far mountains (0.05x) + near hills (0.2x)
    ctx.fillStyle = colors.cloud;
    ctx.globalAlpha = 0.55;
    const mOff = (distance * 0.05) % 260;
    for (let x = -260; x < W + 260; x += 260) {
      const bx = x - mOff;
      ctx.beginPath();
      ctx.moveTo(bx, GROUND_Y - 2);
      ctx.lineTo(bx + 60, GROUND_Y - 52);
      ctx.lineTo(bx + 120, GROUND_Y - 2);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(bx + 110, GROUND_Y - 2);
      ctx.lineTo(bx + 170, GROUND_Y - 38);
      ctx.lineTo(bx + 230, GROUND_Y - 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 0.85;
    const hOff = (distance * 0.2) % 180;
    for (let x = -180; x < W + 180; x += 180) {
      const bx = x - hOff;
      ctx.beginPath();
      ctx.arc(bx + 60, GROUND_Y - 1, 42, Math.PI, 0);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (night > 0.3) {
      ctx.fillStyle = colors.ink;
      for (const s of stars) {
        ctx.globalAlpha = (0.4 + 0.6 * Math.abs(Math.sin(performance.now() / 900 + s.x))) * night;
        rect(s.x, s.y, s.s, s.s);
      }
      ctx.globalAlpha = 1;
      // moon
      ctx.fillStyle = colors.ink;
      ctx.globalAlpha = night;
      rect(W - 90, 30, 18, 18);
      ctx.fillStyle = colors.bg;
      rect(W - 86, 28, 10, 14);
      ctx.globalAlpha = 1;
    }
  }

  function drawGround() {
    ctx.fillStyle = colors.ink;
    rect(0, GROUND_Y - 2, W, 1);
    const span = W + 40;
    for (let i = 0; i < 36; i++) {
      const px = (((i * 137 - distance) % span) + span) % span - 20;
      const py = GROUND_Y + 3 + ((i * 7) % 12);
      rect(px, py, 1 + (i % 3) * 2, 1);
    }
    // speed lines at high speed
    if (state === 'running' && speed > 9) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.5, (speed - 9) * 0.15);
      ctx.fillStyle = colors.ink;
      const t = performance.now() / 16;
      for (let i = 0; i < 4; i++) {
        const y = 40 + ((i * 53 + t * 0) % 110);
        const x = W - ((t * (14 + i * 3) + i * 210) % (W + 200)) + 100;
        rect(x, y, 34, 1);
      }
      ctx.restore();
    }
  }

  function drawParticles() {
    ctx.fillStyle = colors.ink;
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.maxLife) * 0.9;
      rect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters() {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of floaters) {
      const a = Math.max(0, 1 - f.life / f.maxLife);
      ctx.globalAlpha = a;
      ctx.font = '10px "Press Start 2P", ui-monospace, monospace';
      ctx.fillStyle = f.color || colors.ink;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  function pad(n) { return String(Math.max(0, Math.floor(n))).padStart(5, '0'); }

  function drawText(text, x, y, size, align = 'center') {
    ctx.font = `${size}px "Press Start 2P", ui-monospace, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  function roundPanel(x, y, w, h) {
    ctx.fillStyle = colors.bg;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }

  function drawHud() {
    ctx.fillStyle = colors.ink;
    const flashing = performance.now() < flashUntil && Math.floor(performance.now() / 150) % 2 === 0;
    const current = flashing ? '' : pad(score);
    drawText(`HI ${pad(hiScore)}  ${current.padStart(5, ' ')}`, W - 20, 24, 12, 'right');
    let subY = 44;
    if (coinCount > 0) { drawText(`◉ ${coinCount}`, W - 20, subY, 8, 'right'); subY += 16; }
    if (dino.shield) drawText('[SHIELD]', W - 20, subY, 8, 'right');
    if (CONFIG.githubUsername) {
      drawText(`@${CONFIG.githubUsername}`, 20, 24, 12, 'left');
    }

    if (state === 'ready') {
      const bounce = Math.sin(performance.now() / 350) * 4;
      drawText(CONFIG.startText, W / 2, 82 + bounce, 12);
      drawText('SPACE x2 = DOUBLE JUMP · HOLD = HIGHER · P = PAUSE · M = MUTE', W / 2, 104, 7);
      MISSION_DEFS.forEach((m, i) => {
        const done = unlockedMissions.includes(m.id);
        drawText(`${done ? '★' : '·'} ${m.name}`, W / 2, 122 + i * 13, 7);
      });
    } else if (state === 'paused') {
      drawText('PAUSED — PRESS P TO RESUME', W / 2, 90, 12);
    } else if (state === 'over') {
      // dim + card
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      const pw = 380;
      const ph = (isNewBest ? 108 : 92) + runUnlocks.length * 18;
      const px = W / 2 - pw / 2;
      const py = 40;
      roundPanel(px, py, pw, ph);
      ctx.fillStyle = colors.ink;
      drawText(CONFIG.gameOverText, W / 2, py + 22, 14);
      drawText(`SCORE ${pad(score)}   HI ${pad(hiScore)}`, W / 2, py + 48, 10);
      let ly = py + 68;
      if (isNewBest) {
        const blink = Math.floor(performance.now() / 300) % 2 === 0;
        if (blink) drawText('★ NEW BEST! ★', W / 2, ly, 10);
        ly += 20;
      }
      for (const id of runUnlocks) {
        const m = MISSION_DEFS.find((x) => x.id === id);
        if (m) { drawText(`★ ${m.name}`, W / 2, ly, 7); ly += 18; }
      }
      const showRestart = performance.now() - gameOverAt > 400;
      if (showRestart && Math.floor(performance.now() / 500) % 2 === 0) {
        drawText(CONFIG.restartText, W / 2, py + ph + 20, 9);
      }
    }
  }

  function draw() {
    const now = performance.now();
    const night = applyPalette();
    const sunset = sunsetFactor();
    ctx.save();
    if (now < shakeUntil) {
      const mag = state === 'over' ? 5 : 3;
      ctx.translate(rand(-mag, mag), rand(-mag, mag));
    }
    drawSky(night, sunset);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(-10, GROUND_Y, W + 20, H - GROUND_Y + 10);
    drawParallax(night);
    clouds.forEach(drawCloud);
    drawGround();
    powerups.forEach(drawShieldPickup);
    coins.forEach(drawCoin);
    obstacles.forEach(drawObstacle);
    drawParticles();
    drawDino();
    drawFloaters();
    drawHud();
    ctx.restore();
  }

  // ---------- loop ----------

  let last = performance.now();
  function loop(now) {
    const dt = Math.min((now - last) / (1000 / 60), 3); // normalised to 60fps
    last = now;
    update(dt);
    // Cosmetic-only layer: particles/floaters advance exactly once per frame
    // in every state (ready/paused/over) so toasts from Share/Mute/missions
    // still expire. Score, obstacles, and physics stay frozen while paused
    // because update() above early-returns unless state === 'running'.
    updateParticles(dt);
    draw();
    requestAnimationFrame(loop);
  }

  // ---------- input ----------

  function primaryAction() {
    if (state === 'ready') {
      state = 'running';
      syncButtons();
      jump();
    } else if (state === 'paused') {
      state = 'running';
      syncButtons();
    } else if (state === 'over') {
      if (performance.now() - gameOverAt > 400) {
        reset();
        state = 'running';
        syncButtons();
      }
    } else {
      jump();
    }
  }

  const JUMP_KEYS = ['Space', 'ArrowUp', 'KeyW'];
  const DUCK_KEYS = ['ArrowDown', 'KeyS'];

  // Duck hold is the union of global-keyboard / Duck-button-pointer /
  // Duck-button-keyboard / touch-swipe holds, so releasing one source never
  // sticks or prematurely clears another.
  const duckKeysHeld = new Set();
  const jumpKeysHeld = new Set();
  let duckPointerHeld = false;
  let duckButtonKeyHeld = false;
  let touchDuckHeld = false;
  function syncDuck() {
    dino.ducking = duckKeysHeld.size > 0 || duckPointerHeld || duckButtonKeyHeld || touchDuckHeld;
  }
  function clearDuckHolds() {
    duckKeysHeld.clear();
    duckPointerHeld = false;
    duckButtonKeyHeld = false;
    touchDuckHeld = false;
    if (dino) syncDuck();
  }

  function isInteractiveControl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === canvas || el === document.body || el === document.documentElement) return false;
    if (el.isContentEditable) return true;
    if (typeof el.closest !== 'function') return false;
    return !!el.closest('button, a[href], input, textarea, select, [contenteditable], [role="button"], [role="link"]');
  }

  document.addEventListener('keydown', (e) => {
    // Gameplay shortcuts only fire when the page or canvas has focus. A
    // focused button, link, editable field, or other interactive control
    // keeps its normal keyboard behavior (Space/Enter activate, typing
    // works, arrows move within the control). Tab/Shift+Tab are never
    // intercepted.
    if (isInteractiveControl(e.target)) return;
    if (JUMP_KEYS.includes(e.code)) {
      e.preventDefault();
      if (!e.repeat) {
        jumpKeysHeld.add(e.code);
        primaryAction();
      }
    } else if (DUCK_KEYS.includes(e.code)) {
      e.preventDefault();
      duckKeysHeld.add(e.code);
      syncDuck();
    } else if (e.code === 'KeyP' || e.code === 'Escape') {
      e.preventDefault();
      togglePause();
    } else if (e.code === 'KeyM') {
      toggleMute();
    }
  });

  document.addEventListener('keyup', (e) => {
    // Always release duck keys (even when focus moved mid-hold) so the
    // dino is never left stuck ducking.
    if (DUCK_KEYS.includes(e.code)) {
      if (duckKeysHeld.has(e.code)) {
        duckKeysHeld.delete(e.code);
        syncDuck();
      }
    }
    if (JUMP_KEYS.includes(e.code)) {
      // Only shorten a jump this listener actually started. A keydown
      // ignored on a focused control (e.g. Space for a keyboard click on
      // the Jump button) leaves no trace here, so its jump keeps full
      // height instead of being cut by its own keyup.
      if (jumpKeysHeld.has(e.code)) {
        jumpKeysHeld.delete(e.code);
        cutJump();
      }
    }
  });

  // touch: tap = jump, swipe-down-hold = duck
  let touchStartY = null;
  let touchStartX = null;
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    primaryAction();
  });
  canvas.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touchStartY = t.clientY;
    touchStartX = t.clientX;
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    if (touchStartY == null) return;
    const t = e.touches[0];
    if (t.clientY - touchStartY > 24) {
      touchDuckHeld = true;
      syncDuck();
    }
  }, { passive: true });
  canvas.addEventListener('touchend', () => {
    touchStartY = null;
    touchStartX = null;
    touchDuckHeld = false;
    syncDuck();
    cutJump();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === 'running') togglePause();
  });
  window.addEventListener('blur', () => {
    // A key released while the window is blurred never produces keyup, so
    // drop any tracked jump without shortening anything new.
    if (jumpKeysHeld.size > 0) {
      jumpKeysHeld.clear();
      cutJump();
    }
    clearDuckHolds();
    if (state === 'running') togglePause();
  });

  function shareScore() {
    const text = `I scored ${Math.floor(score)} in Dino Run (best ${Math.floor(hiScore)}). Can you beat me?`;
    const done = () => floater('SCORE COPIED — GO BRAG!', W / 2, 90);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => floater(`BEST ${pad(hiScore)} — SCREENSHOT IT!`, W / 2, 90));
      } else {
        floater(`BEST ${pad(hiScore)} — SCREENSHOT IT!`, W / 2, 90);
      }
    } catch { floater(`BEST ${pad(hiScore)} — SCREENSHOT IT!`, W / 2, 90); }
    beep(990, 0.06);
  }

  function syncButtons() {
    const pb = document.getElementById('btn-pause');
    const mb = document.getElementById('btn-mute');
    if (pb) pb.textContent = state === 'paused' ? '▶ Resume' : '⏸ Pause';
    if (mb) mb.textContent = muted ? '🔇 Unmute' : '🔊 Mute';
  }
  function wireButtons() {
    const pb = document.getElementById('btn-pause');
    const mb = document.getElementById('btn-mute');
    const sb = document.getElementById('btn-share');
    const jb = document.getElementById('btn-jump');
    const db = document.getElementById('btn-duck');
    if (pb) pb.addEventListener('click', (e) => { e.preventDefault(); togglePause(); canvas.focus(); });
    if (mb) mb.addEventListener('click', (e) => { e.preventDefault(); toggleMute(); canvas.focus(); });
    if (sb) sb.addEventListener('click', (e) => { e.preventDefault(); shareScore(); canvas.focus(); });
    // Jump: pointerdown gives instant touch/mouse response; click handles
    // keyboard activation (Space/Enter). Pointer clicks carry detail > 0, so
    // only detail === 0 (keyboard) fires here — no double jump on tap/click.
    if (jb) {
      jb.addEventListener('pointerdown', (e) => { e.preventDefault(); primaryAction(); });
      jb.addEventListener('click', (e) => { if (e.detail === 0) primaryAction(); });
    }
    if (db) {
      // Pointer and keyboard holds are tracked independently: releasing the
      // pointer never cancels a keyboard hold and vice versa.
      const pointerOn = (e) => { e.preventDefault(); duckPointerHeld = true; syncDuck(); };
      const pointerOff = (e) => { if (e) e.preventDefault(); duckPointerHeld = false; syncDuck(); };
      const keyOff = () => { duckButtonKeyHeld = false; syncDuck(); };
      db.addEventListener('pointerdown', pointerOn);
      db.addEventListener('pointerup', pointerOff);
      db.addEventListener('pointercancel', pointerOff);
      db.addEventListener('pointerleave', pointerOff);
      // Keyboard hold on the focused Duck button (the global listener skips
      // focused controls so native activation still works). Click itself is
      // a no-op for hold semantics — key up always releases.
      db.addEventListener('keydown', (e) => {
        if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
          if (!e.repeat) { duckButtonKeyHeld = true; syncDuck(); }
        }
      });
      db.addEventListener('keyup', (e) => {
        if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') keyOff();
      });
      db.addEventListener('blur', keyOff);
    }
  }

  // ---------- build info footer ----------

  function renderBuildInfo() {
    const el = document.getElementById('build');
    if (!el) return;
    const { commit, time, repo, run } = el.dataset;
    if (!commit || commit.startsWith('__')) {
      el.textContent = '🧪 Running locally — not deployed by the pipeline yet';
      return;
    }
    el.textContent = '🚀 Deployed by GitHub Actions · commit ';
    const commitLink = document.createElement('a');
    commitLink.href = `https://github.com/${repo}/commit/${commit}`;
    const code = document.createElement('code');
    code.textContent = commit.slice(0, 7);
    commitLink.append(code);
    el.append(commitLink, ` · ${time} · `);
    const runLink = document.createElement('a');
    runLink.href = run;
    runLink.textContent = 'view pipeline run';
    el.append(runLink);
  }

  // ---------- boot ----------

  setupCanvas();
  readColors();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
  reset();
  initClouds();
  wireButtons();
  syncButtons();
  renderBuildInfo();
  requestAnimationFrame(loop);
  // Re-draw once the pixel font arrives so canvas text uses it
  if (document.fonts) document.fonts.ready.then(draw);
})();
