(() => {
  'use strict';

  // Gameplay tuning
  const CONFIG = {
    // 👋 Change this to your GitHub username, push, and look for it on the live game screen
    githubUsername: 'Nafeel005',

    startSpeed: 6,
    maxSpeed: 13,
    acceleration: 0.0015,   // speed gained per frame
    gravity: 0.65,
    jumpVelocity: 12,
    birdsAfterScore: 250,   // birds start appearing after this score
    startText: 'PRESS SPACE OR TAP TO START',
    gameOverText: 'G A M E   O V E R',
    restartText: 'PRESS SPACE OR TAP TO RESTART',
  };

  const W = 800;
  const H = 220;
  const GROUND_Y = 190;
  const HI_KEY = 'dino-run-hi';

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

  let colors = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    colors = {
      ink: v('--ink', '#535353'),
      bg: v('--game-bg', '#ffffff'),
      cloud: v('--cloud', '#d0d0d0'),
    };
  }

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  };

  let audio = null;
  function beep(freq, duration) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
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

  const rand = (min, max) => min + Math.random() * (max - min);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ---------- state ----------

  let state = 'ready'; // ready | running | over
  let dino, obstacles, clouds, speed, distance, score, nextSpawnIn, gameOverAt, flashUntil;
  let hiScore = Number(storage.get(HI_KEY)) || 0;

  function reset() {
    dino = { x: 50, lift: 0, vy: 0, onGround: true, ducking: false };
    obstacles = [];
    speed = CONFIG.startSpeed;
    distance = 0;
    score = 0;
    nextSpawnIn = 400;
    flashUntil = 0;
  }

  function initClouds() {
    clouds = Array.from({ length: 4 }, (_, i) => ({ x: 120 + i * 220 + rand(-40, 40), y: rand(20, 90) }));
  }

  // ---------- geometry ----------

  function dinoBox() {
    const ducking = dino.ducking && dino.onGround && state === 'running';
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
      o = { type: 'bird', x: W + 10, y: top, w: 46, h: 32 };
    } else {
      const large = Math.random() < 0.5;
      const unit = large ? 25 : 17;
      const h = large ? 50 : 35;
      const maxCount = speed > 8 ? 3 : 2;
      const count = 1 + Math.floor(Math.random() * maxCount);
      const w = count * unit + (count - 1) * 2;
      o = { type: 'cactus', x: W + 10, y: GROUND_Y - h, w, h, unit, count };
    }
    obstacles.push(o);
    nextSpawnIn = o.w + speed * rand(45, 85);
  }

  // ---------- update ----------

  function jump() {
    if (dino.onGround) {
      dino.vy = CONFIG.jumpVelocity;
      dino.onGround = false;
      beep(620, 0.05);
    }
  }

  function update(dt) {
    if (state !== 'running') return;

    speed = Math.min(CONFIG.maxSpeed, speed + CONFIG.acceleration * dt);
    distance += speed * dt;

    const newScore = Math.floor(distance * 0.025);
    if (Math.floor(newScore / 100) > Math.floor(score / 100)) {
      beep(880, 0.08);
      flashUntil = performance.now() + 900;
    }
    score = newScore;

    // dino physics (holding "down" mid-air = fast fall)
    if (!dino.onGround) {
      const g = CONFIG.gravity * (dino.ducking ? 3 : 1);
      dino.lift += dino.vy * dt;
      dino.vy -= g * dt;
      if (dino.lift <= 0) {
        dino.lift = 0;
        dino.vy = 0;
        dino.onGround = true;
      }
    }

    // obstacles
    nextSpawnIn -= speed * dt;
    if (nextSpawnIn <= 0) spawnObstacle();

    for (const o of obstacles) {
      o.x -= (o.type === 'bird' ? speed + 0.8 : speed) * dt;
    }
    obstacles = obstacles.filter((o) => o.x + o.w > -20);

    // clouds
    for (const c of clouds) {
      c.x -= speed * 0.15 * dt;
      if (c.x < -60) { c.x = W + rand(0, 200); c.y = rand(20, 90); }
    }

    // collision
    const d = dinoBox();
    if (obstacles.some((o) => hits(d, obstacleBox(o)))) gameOver();
  }

  function gameOver() {
    state = 'over';
    gameOverAt = performance.now();
    beep(160, 0.25);
    if (score > hiScore) {
      hiScore = score;
      storage.set(HI_KEY, String(hiScore));
    }
  }

  // ---------- drawing ----------

  function rect(x, y, w, h) { ctx.fillRect(Math.round(x), Math.round(y), w, h); }

  function drawDino() {
    const b = dinoBox();
    const x = b.x;
    const y = b.y;
    const running = state === 'running' && dino.onGround;
    const leg = running ? Math.floor(distance / 28) % 2 : -1;
    const dead = state === 'over';
    ctx.fillStyle = colors.ink;

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
  }

  function drawCactus(x, y, w, h) {
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
  }

  function drawObstacle(o) {
    ctx.fillStyle = colors.ink;
    if (o.type === 'cactus') {
      for (let i = 0; i < o.count; i++) {
        drawCactus(o.x + i * (o.unit + 2), o.y, o.unit, o.h);
      }
      return;
    }
    // bird (faces left, flaps)
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

  function drawCloud(c) {
    ctx.fillStyle = colors.cloud;
    rect(c.x + 8, c.y, 24, 4);
    rect(c.x + 4, c.y + 4, 36, 4);
    rect(c.x, c.y + 8, 46, 4);
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
  }

  function pad(n) { return String(n).padStart(5, '0'); }

  function drawText(text, x, y, size, align = 'center') {
    ctx.font = `${size}px "Press Start 2P", ui-monospace, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  function drawHud() {
    ctx.fillStyle = colors.ink;
    const flashing = performance.now() < flashUntil && Math.floor(performance.now() / 150) % 2 === 0;
    const current = flashing ? '' : pad(score);
    drawText(`HI ${pad(hiScore)}  ${current.padStart(5, ' ')}`, W - 20, 24, 12, 'right');
    if (CONFIG.githubUsername) {
      drawText(`@${CONFIG.githubUsername}`, 20, 24, 12, 'left');
    }

    if (state === 'ready') {
      drawText(CONFIG.startText, W / 2, 90, 12);
    } else if (state === 'over') {
      drawText(CONFIG.gameOverText, W / 2, 70, 16);
      drawText(CONFIG.restartText, W / 2, 105, 10);
    }
  }

  function draw() {
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, H);
    clouds.forEach(drawCloud);
    drawGround();
    obstacles.forEach(drawObstacle);
    drawDino();
    drawHud();
  }

  // ---------- loop ----------

  let last = performance.now();
  function loop(now) {
    const dt = Math.min((now - last) / (1000 / 60), 3); // normalised to 60fps
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  // ---------- input ----------

  function primaryAction() {
    if (state === 'ready') {
      state = 'running';
      jump();
    } else if (state === 'over') {
      if (performance.now() - gameOverAt > 400) {
        reset();
        state = 'running';
      }
    } else {
      jump();
    }
  }

  const JUMP_KEYS = ['Space', 'ArrowUp', 'KeyW'];
  const DUCK_KEYS = ['ArrowDown', 'KeyS'];

  document.addEventListener('keydown', (e) => {
    if (JUMP_KEYS.includes(e.code)) {
      e.preventDefault();
      if (!e.repeat) primaryAction();
    } else if (DUCK_KEYS.includes(e.code)) {
      e.preventDefault();
      dino.ducking = true;
    }
  });

  document.addEventListener('keyup', (e) => {
    if (DUCK_KEYS.includes(e.code)) dino.ducking = false;
  });

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    primaryAction();
  });

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
  renderBuildInfo();
  requestAnimationFrame(loop);
  // Re-draw once the pixel font arrives so canvas text uses it
  if (document.fonts) document.fonts.ready.then(draw);
})();
