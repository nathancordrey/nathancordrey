import './style.css';
import Phaser from 'phaser';

import { GAME_CONFIG, MAP } from './shared/config';
import type { Team } from './shared/config';
import type { Vec2 } from './shared/geometry';
import {
  carriedFlagTeam,
  createMatchState,
  evaluateMatch,
  computeVisionPolygon,
  createCtfState,
  isTargetVisible,
  moveCircle,
  resolveShot,
  returnFlagOnDeath,
  tryCaptureFlag,
  tryGrabFlag,
} from './shared/sim';
import type { CtfState, MatchState } from './shared/sim';
import type { CircleTarget } from './shared/sim';

type Enemy = {
  sim: CircleTarget;
  body: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  lastSeenAt: number;
  lastSeenPos: Vec2;
  ghost: Phaser.GameObjects.Arc;
  visibleNow: boolean;
};

class GameScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Arc;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;

  private enemies: Enemy[] = [];

  private debugText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private campText!: Phaser.GameObjects.Text;

  private aimGraphics!: Phaser.GameObjects.Graphics;
  private shotGraphics!: Phaser.GameObjects.Graphics;
  private visionGraphics!: Phaser.GameObjects.Graphics;
  private mobileControlGraphics!: Phaser.GameObjects.Graphics;

  private fogRect!: Phaser.GameObjects.Rectangle;
  private fogMaskGraphics!: Phaser.GameObjects.Graphics;

  private playerTeam: Team = 'red';
  private playerAlive = true;

  private visionHistory: Array<{ points: Phaser.Math.Vector2[]; at: number }> = [];
  private lastVisionSampleAt = 0;

  private ctf: CtfState = createCtfState();
  private match: MatchState = createMatchState();
  private roundStartAt = 0;
  private timerText!: Phaser.GameObjects.Text;
  private flagMarkers: Partial<Record<Team, Phaser.GameObjects.Arc[]>> = {};
  private carryIndicator!: Phaser.GameObjects.Arc;
  private respawnAt = 0;

  private ownFlagCampStartedAt: number | null = null;
  private ownFlagExitedAt: number | null = null;

  private lastShotAt = -Infinity;
  private shotVisibleUntil = 0;
  private activeShot: { start: Vec2; end: Vec2 } | null = null;
  private hitCount = 0;

  private mobileMovePointerId: number | null = null;
  private mobileMoveOrigin: Vec2 | null = null;
  private mobileMoveCurrent: Vec2 | null = null;
  private mobileMoveVector: Vec2 = { x: 0, y: 0 };

  constructor() {
    super('GameScene');
  }

  create() {
    // scene.restart() reuses this instance, so reset all round state here.
    this.ctf = createCtfState();
    this.match = createMatchState();
    this.enemies = [];
    this.flagMarkers = {};
    this.playerAlive = true;
    this.respawnAt = 0;
    this.ownFlagCampStartedAt = null;
    this.ownFlagExitedAt = null;
    this.lastShotAt = -Infinity;
    this.shotVisibleUntil = 0;
    this.activeShot = null;
    this.hitCount = 0;
    this.mobileMovePointerId = null;
    this.mobileMoveOrigin = null;
    this.mobileMoveCurrent = null;
    this.mobileMoveVector = { x: 0, y: 0 };
    this.visionHistory = [];
    this.lastVisionSampleAt = 0;
    this.roundStartAt = this.time.now;

    this.cameras.main.setBackgroundColor('#111827');

    this.add
      .text(12, 10, 'Sniper Locks prototype', {
        color: '#ffffff',
        fontSize: '15px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setDepth(100)
      .setScrollFactor(0);

    this.add
      .text(12, 30, 'WASD/arrows + mouse • Phone: left drag + right tap', {
        color: '#cbd5e1',
        fontSize: '11px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setDepth(100)
      .setScrollFactor(0);

    this.debugText = this.add.text(12, 50, '', {
      color: '#94a3b8',
      fontSize: '10px',
      fontFamily: 'monospace',
    });

    this.statusText = this.add.text(12, 108, '', {
      color: '#fef3c7',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
    });

    this.campText = this.add.text(12, 126, '', {
      color: '#fecaca',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
    });

    this.debugText.setDepth(100).setScrollFactor(0);
    this.statusText.setDepth(100).setScrollFactor(0);
    this.campText.setDepth(100).setScrollFactor(0);

    this.timerText = this.add.text(GAME_CONFIG.viewportWidth / 2, 8, '', {
      color: '#ffffff',
      fontSize: '18px',
      fontFamily: 'monospace',
    });
    this.timerText.setOrigin(0.5, 0);
    this.timerText.setDepth(100);
    this.timerText.setScrollFactor(0);

    this.input.keyboard!.on('keydown-R', () => {
      if (this.match.phase === 'ended') this.scene.restart();
    });

    this.createArena();

    this.player = this.add.circle(
      GAME_CONFIG.playerSpawnX,
      GAME_CONFIG.playerSpawnY,
      GAME_CONFIG.playerRadius,
      0x38bdf8
    );

    // Fog of war: a dark overlay covering the whole world. The mask polygon
    // (your line of sight + your flag's beacon) is inverted, so fog renders
    // everywhere you can NOT see.
    this.fogRect = this.add.rectangle(
      GAME_CONFIG.worldWidth / 2,
      GAME_CONFIG.worldHeight / 2,
      GAME_CONFIG.worldWidth,
      GAME_CONFIG.worldHeight,
      0x070b16,
      0.82
    );
    this.fogRect.setDepth(50);

    // Mask graphics live off the display list — the fog's Mask filter renders
    // them to its own texture. invert=true makes fog show where we DON'T draw.
    this.fogMaskGraphics = this.make.graphics({}, false);
    this.fogRect.enableFilters();
    this.fogRect.filters!.internal.addMask(this.fogMaskGraphics, true);

    this.visionGraphics = this.add.graphics();
    this.aimGraphics = this.add.graphics();
    this.shotGraphics = this.add.graphics();
    this.mobileControlGraphics = this.add.graphics();

    // Your own aim/tracer/controls and the HUD render above the fog.
    this.visionGraphics.setDepth(60);
    this.aimGraphics.setDepth(60);
    this.shotGraphics.setDepth(60);
    this.mobileControlGraphics.setDepth(100);
    this.mobileControlGraphics.setScrollFactor(0);
    this.player.setDepth(60);

    // Small enemy-colored dot riding on the carrier — only YOU see it
    // (fog still hides you from the enemy team; no carrier reveal).
    this.carryIndicator = this.add.circle(0, 0, 6, 0x3b82f6, 0.95);
    this.carryIndicator.setDepth(61);
    this.carryIndicator.setVisible(false);

    // Big map: the camera shows a BW-sized viewport and follows the player.
    this.cameras.main.setBounds(0, 0, GAME_CONFIG.worldWidth, GAME_CONFIG.worldHeight);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);

    this.cursors = this.input.keyboard!.createCursorKeys();

    this.keys = this.input.keyboard!.addKeys({
      w: Phaser.Input.Keyboard.KeyCodes.W,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<string, Phaser.Input.Keyboard.Key>;

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.handlePointerDown(pointer);
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      this.handlePointerMove(pointer);
    });

    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      this.handlePointerUp(pointer);
    });

    this.input.on('pointerupoutside', (pointer: Phaser.Input.Pointer) => {
      this.handlePointerUp(pointer);
    });
  }

  update(time: number, delta: number) {
    const dt = delta / 1000;

    if (this.match.phase === 'ended') {
      return;
    }

    const remainingMs = GAME_CONFIG.roundDurationMs - (time - this.roundStartAt);
    this.updateTimerText(remainingMs);

    if (evaluateMatch(this.match, this.ctf, remainingMs, GAME_CONFIG.scoreToWin)) {
      this.showMatchEnd();
      return;
    }

    if (!this.playerAlive) {
      this.mobileMoveVector = { x: 0, y: 0 };

      if (time >= this.respawnAt) {
        this.respawnPlayer();
      }

      this.aimGraphics.clear();
      this.drawActiveShot(time);
      this.drawMobileControls();
      this.drawFog(time);
      this.updateVisibility(time);
      this.updateCampTimer(time);
      return;
    }

    let dx = 0;
    let dy = 0;

    if (this.cursors.left.isDown || this.keys.a.isDown) dx -= 1;
    if (this.cursors.right.isDown || this.keys.d.isDown) dx += 1;
    if (this.cursors.up.isDown || this.keys.w.isDown) dy -= 1;
    if (this.cursors.down.isDown || this.keys.s.isDown) dy += 1;

    dx += this.mobileMoveVector.x;
    dy += this.mobileMoveVector.y;

    if (dx !== 0 || dy !== 0) {
      const length = Math.hypot(dx, dy);
      dx /= length;
      dy /= length;

      const next = moveCircle(
        { x: this.player.x, y: this.player.y },
        dx * GAME_CONFIG.playerSpeed * dt,
        dy * GAME_CONFIG.playerSpeed * dt,
        GAME_CONFIG.playerRadius,
        MAP.walls
      );

      this.player.x = next.x;
      this.player.y = next.y;
    }

    this.updateCtf();

    this.drawVisionRing();
    this.drawFog(time);
    this.drawAimLine();
    this.drawActiveShot(time);
    this.drawMobileControls();
    this.updateVisibility(time);
    this.updateCampTimer(time);

    const cooldownRemaining = Math.max(
      0,
      GAME_CONFIG.shotCooldownMs - (time - this.lastShotAt)
    );

    const aliveEnemies = this.enemies.filter((enemy) => enemy.sim.alive).length;
    const visibleEnemies = this.enemies.filter((enemy) => enemy.body.visible).length;

    this.debugText.setText(
      [
        `x=${this.player.x.toFixed(0)} y=${this.player.y.toFixed(0)}`,
        `shot cooldown=${cooldownRemaining.toFixed(0)}ms`,
        `enemies alive=${aliveEnemies}/${this.enemies.length} visible=${visibleEnemies}`,
        `hits=${this.hitCount}`,
        `score RED ${this.ctf.scores.red} — ${this.ctf.scores.blue} BLUE${
          carriedFlagTeam(this.ctf, 'player') ? '  [CARRYING FLAG]' : ''
        }`,
      ].join('\n')
    );
  }

  private createArena() {
    for (const wallDef of MAP.walls) {
      const { rect, blocksShots } = wallDef;
      const width = rect.right - rect.left;
      const height = rect.bottom - rect.top;
      const cx = rect.left + width / 2;
      const cy = rect.top + height / 2;

      if (blocksShots) {
        // Hard wall: solid slate. Stops bullets, vision, movement.
        this.add.rectangle(cx, cy, width, height, 0x475569);
      } else {
        // Soft cover: foliage. Blocks vision + movement, bullets pass through.
        const body = this.add.rectangle(cx, cy, width, height, 0x3f6212, 0.55);
        body.setStrokeStyle(2, 0x84cc16, 0.5);
      }
    }

    for (const flag of MAP.flags) {
      this.addFlagZone(flag.team, flag.x, flag.y, flag.team === 'red' ? 0xef4444 : 0x3b82f6);
    }

    for (const spawn of MAP.enemySpawns) {
      this.addEnemy(spawn.x, spawn.y, spawn.label);
    }
  }

  private addEnemy(x: number, y: number, labelText: string) {
    const body = this.add.circle(x, y, GAME_CONFIG.targetRadius, 0x3b82f6);
    body.setStrokeStyle(2, 0xbfdbfe, 0.9);

    const label = this.add.text(x - 9, y - 32, labelText, {
      color: '#bfdbfe',
      fontSize: '13px',
      fontFamily: 'monospace',
    });

    const ghost = this.add.circle(x, y, GAME_CONFIG.targetRadius, 0x3b82f6, 0.18);
    ghost.setStrokeStyle(1, 0x93c5fd, 0.35);
    ghost.setVisible(false);

    this.enemies.push({
      sim: { x, y, radius: GAME_CONFIG.targetRadius, alive: true },
      body,
      label,
      lastSeenAt: -Infinity,
      lastSeenPos: { x, y },
      ghost,
      visibleNow: false,
    });
  }

  private addFlagZone(team: Team, x: number, y: number, color: number) {
    this.add.circle(x, y, GAME_CONFIG.flagVisionRadius, color, 0.08);

    const visionRing = this.add.circle(x, y, GAME_CONFIG.flagVisionRadius);
    visionRing.setStrokeStyle(2, color, 0.22);

    if (team === this.playerTeam) {
      const campRing = this.add.circle(x, y, GAME_CONFIG.ownFlagCampRadius);
      campRing.setStrokeStyle(2, 0xfca5a5, 0.32);
    }

    const outerMarker = this.add.circle(x, y, 28, color, 0.35);
    const innerMarker = this.add.circle(x, y, 8, color, 0.9);
    this.flagMarkers[team] = [outerMarker, innerMarker];

    this.add.text(x - 24, y + 34, team.toUpperCase(), {
      color: team === 'red' ? '#fecaca' : '#bfdbfe',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
    });
  }

  // Each frame: an enemy renders only if the shared sim says we can see it.
  // Losing sight leaves a fading "last seen" ghost marker for a moment.
  private updateVisibility(time: number) {
    const viewer: Vec2 = { x: this.player.x, y: this.player.y };

    for (const enemy of this.enemies) {
      const seen =
        this.playerAlive &&
        enemy.sim.alive &&
        isTargetVisible(
          viewer,
          this.playerTeam,
          { x: enemy.sim.x, y: enemy.sim.y },
          MAP.walls,
          GAME_CONFIG.playerVisionRadius,
          MAP.flags
        );

      enemy.visibleNow = seen;

      if (seen) {
        enemy.lastSeenAt = time;
        enemy.lastSeenPos = { x: enemy.sim.x, y: enemy.sim.y };
      }

      enemy.body.setVisible(seen);
      enemy.label.setVisible(seen);

      const sinceSeen = time - enemy.lastSeenAt;
      const showGhost =
        !seen && enemy.sim.alive && sinceSeen <= GAME_CONFIG.lastSeenLingerMs;

      enemy.ghost.setVisible(showGhost);
      if (showGhost) {
        enemy.ghost.x = enemy.lastSeenPos.x;
        enemy.ghost.y = enemy.lastSeenPos.y;
        enemy.ghost.setAlpha(1 - sinceSeen / GAME_CONFIG.lastSeenLingerMs);
      }
    }
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer) {
    if (this.match.phase === 'ended') {
      this.scene.restart();
      return;
    }

    const pointerEvent = pointer.event as Event & { pointerType?: string };
    const isTouch =
      (pointer as unknown as { wasTouch?: boolean }).wasTouch === true ||
      pointerEvent.pointerType === 'touch';

    // Screen-space check: with a scrolling camera, world coords no longer
    // map to screen halves.
    const isLeftHalf = pointer.x < GAME_CONFIG.viewportWidth / 2;

    if (isTouch && isLeftHalf) {
      this.mobileMovePointerId = pointer.id;
      this.mobileMoveOrigin = { x: pointer.x, y: pointer.y };
      this.mobileMoveCurrent = { x: pointer.x, y: pointer.y };
      this.updateMobileMoveVector(pointer);
      return;
    }

    this.tryShoot(this.time.now, {
      x: pointer.worldX,
      y: pointer.worldY,
    });
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer) {
    if (this.mobileMovePointerId !== pointer.id) {
      return;
    }

    this.mobileMoveCurrent = { x: pointer.x, y: pointer.y };
    this.updateMobileMoveVector(pointer);
  }

  private handlePointerUp(pointer: Phaser.Input.Pointer) {
    if (this.mobileMovePointerId !== pointer.id) {
      return;
    }

    this.mobileMovePointerId = null;
    this.mobileMoveOrigin = null;
    this.mobileMoveCurrent = null;
    this.mobileMoveVector = { x: 0, y: 0 };
  }

  private updateMobileMoveVector(pointer: Phaser.Input.Pointer) {
    if (!this.mobileMoveOrigin) {
      this.mobileMoveVector = { x: 0, y: 0 };
      return;
    }

    const rawDx = pointer.x - this.mobileMoveOrigin.x;
    const rawDy = pointer.y - this.mobileMoveOrigin.y;
    const dragDistance = Math.hypot(rawDx, rawDy);

    if (dragDistance < 6) {
      this.mobileMoveVector = { x: 0, y: 0 };
      return;
    }

    const clampedDistance = Math.min(dragDistance, GAME_CONFIG.mobileJoystickMaxDistance);
    const strength = clampedDistance / GAME_CONFIG.mobileJoystickMaxDistance;

    this.mobileMoveVector = {
      x: (rawDx / dragDistance) * strength,
      y: (rawDy / dragDistance) * strength,
    };
  }

  private drawMobileControls() {
    this.mobileControlGraphics.clear();

    if (!this.mobileMoveOrigin || !this.mobileMoveCurrent) {
      return;
    }

    this.mobileControlGraphics.lineStyle(2, 0x93c5fd, 0.45);
    this.mobileControlGraphics.strokeCircle(
      this.mobileMoveOrigin.x,
      this.mobileMoveOrigin.y,
      GAME_CONFIG.mobileJoystickMaxDistance
    );

    this.mobileControlGraphics.lineStyle(3, 0xbfdbfe, 0.7);
    this.mobileControlGraphics.beginPath();
    this.mobileControlGraphics.moveTo(this.mobileMoveOrigin.x, this.mobileMoveOrigin.y);
    this.mobileControlGraphics.lineTo(this.mobileMoveCurrent.x, this.mobileMoveCurrent.y);
    this.mobileControlGraphics.strokePath();

    this.mobileControlGraphics.fillStyle(0xbfdbfe, 0.7);
    this.mobileControlGraphics.fillCircle(this.mobileMoveCurrent.x, this.mobileMoveCurrent.y, 10);
  }

  private updateTimerText(remainingMs: number) {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    this.timerText.setText(`${minutes}:${seconds.toString().padStart(2, '0')}`);
  }

  private showMatchEnd() {
    this.timerText.setText('0:00');

    const overlay = this.add.rectangle(
      GAME_CONFIG.viewportWidth / 2,
      GAME_CONFIG.viewportHeight / 2,
      GAME_CONFIG.viewportWidth,
      GAME_CONFIG.viewportHeight,
      0x000000,
      0.72
    );
    overlay.setDepth(200);
    overlay.setScrollFactor(0);

    const result = this.match.result;
    const headline =
      result === 'draw' ? 'DRAW' : `${(result ?? '').toUpperCase()} TEAM WINS`;
    const headlineColor =
      result === 'red' ? '#fca5a5' : result === 'blue' ? '#93c5fd' : '#e2e8f0';

    this.add
      .text(GAME_CONFIG.viewportWidth / 2, GAME_CONFIG.viewportHeight / 2 - 44, headline, {
        color: headlineColor,
        fontSize: '34px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setOrigin(0.5)
      .setDepth(201)
      .setScrollFactor(0);

    this.add
      .text(
        GAME_CONFIG.viewportWidth / 2,
        GAME_CONFIG.viewportHeight / 2 + 2,
        `RED ${this.ctf.scores.red} — ${this.ctf.scores.blue} BLUE`,
        {
          color: '#e2e8f0',
          fontSize: '20px',
          fontFamily: 'monospace',
        }
      )
      .setOrigin(0.5)
      .setDepth(201)
      .setScrollFactor(0);

    this.add
      .text(
        GAME_CONFIG.viewportWidth / 2,
        GAME_CONFIG.viewportHeight / 2 + 40,
        'Press R or tap to play again',
        {
          color: '#94a3b8',
          fontSize: '13px',
          fontFamily: 'system-ui, sans-serif',
        }
      )
      .setOrigin(0.5)
      .setDepth(201)
      .setScrollFactor(0);
  }

  private updateCtf() {
    const pos = { x: this.player.x, y: this.player.y };

    if (
      tryGrabFlag(this.ctf, 'player', this.playerTeam, pos, MAP.flags, GAME_CONFIG.flagInteractRadius)
    ) {
      this.statusText.setText('ENEMY FLAG TAKEN — bring it home');
      this.time.delayedCall(1500, () => this.statusText.setText(''));
    }

    if (
      tryCaptureFlag(this.ctf, 'player', this.playerTeam, pos, MAP.flags, GAME_CONFIG.flagInteractRadius)
    ) {
      this.statusText.setText('CAPTURED! +1');
      this.time.delayedCall(1500, () => this.statusText.setText(''));
    }

    // Flag center markers only render while the flag is home.
    for (const flag of MAP.flags) {
      const atBase = this.ctf.flags[flag.team].atBase;
      for (const marker of this.flagMarkers[flag.team] ?? []) {
        marker.setVisible(atBase);
      }
    }

    // Carry indicator rides on the player.
    const carrying = carriedFlagTeam(this.ctf, 'player') !== null;
    this.carryIndicator.setVisible(carrying && this.playerAlive);
    if (carrying) {
      this.carryIndicator.x = this.player.x;
      this.carryIndicator.y = this.player.y - GAME_CONFIG.playerRadius - 10;
    }
  }

  // Redraw the fog mask: lit area = line-of-sight polygon (when alive)
  // plus your own flag's beacon circle. Everything else stays dark.
  private drawFog(time: number) {
    this.fogMaskGraphics.clear();

    if (this.playerAlive) {
      const polygon = computeVisionPolygon(
        { x: this.player.x, y: this.player.y },
        MAP.walls,
        GAME_CONFIG.playerVisionRadius
      ).map((p) => new Phaser.Math.Vector2(p.x, p.y));

      // Sample the current polygon into a short history so recently-seen
      // ground stays dimly lit for a moment after you move on (SC-style
      // vision decay).
      if (time - this.lastVisionSampleAt >= GAME_CONFIG.visionSampleMs) {
        this.visionHistory.push({ points: polygon, at: time });
        this.lastVisionSampleAt = time;
      }
      this.visionHistory = this.visionHistory.filter(
        (sample) => time - sample.at <= GAME_CONFIG.visionMemoryMs
      );

      // Older samples first, fading with age; current sight on top at full
      // strength.
      for (const sample of this.visionHistory) {
        const age = time - sample.at;
        const alpha = Math.max(0.15, 1 - age / GAME_CONFIG.visionMemoryMs) * 0.8;
        this.fogMaskGraphics.fillStyle(0xffffff, alpha);
        this.fogMaskGraphics.fillPoints(sample.points, true);
      }

      this.fogMaskGraphics.fillStyle(0xffffff, 1);
      this.fogMaskGraphics.fillPoints(polygon, true);
    } else {
      this.visionHistory = [];
      this.fogMaskGraphics.fillStyle(0xffffff, 1);
    }

    const ownFlag = MAP.flags.find((flag) => flag.team === this.playerTeam);
    if (ownFlag) {
      this.fogMaskGraphics.fillStyle(0xffffff, 1);
      this.fogMaskGraphics.fillCircle(ownFlag.x, ownFlag.y, ownFlag.visionRadius);
    }
  }

  private drawVisionRing() {
    this.visionGraphics.clear();
    this.visionGraphics.lineStyle(1, 0x38bdf8, 0.18);
    this.visionGraphics.strokeCircle(
      this.player.x,
      this.player.y,
      GAME_CONFIG.playerVisionRadius
    );
  }

  private drawAimLine() {
    const pointer = this.input.activePointer;
    const angle = Phaser.Math.Angle.Between(
      this.player.x,
      this.player.y,
      pointer.worldX,
      pointer.worldY
    );

    const aimLength = 80;
    const endX = this.player.x + Math.cos(angle) * aimLength;
    const endY = this.player.y + Math.sin(angle) * aimLength;

    this.aimGraphics.clear();
    this.aimGraphics.lineStyle(2, 0x93c5fd, 0.45);
    this.aimGraphics.beginPath();
    this.aimGraphics.moveTo(this.player.x, this.player.y);
    this.aimGraphics.lineTo(endX, endY);
    this.aimGraphics.strokePath();

    this.aimGraphics.fillStyle(0xffffff, 0.7);
    this.aimGraphics.fillCircle(endX, endY, 3);
  }

  private tryShoot(time: number, aimPoint: Vec2) {
    if (!this.playerAlive) {
      return;
    }

    if (time - this.lastShotAt < GAME_CONFIG.shotCooldownMs) {
      return;
    }

    this.lastShotAt = time;

    const result = resolveShot(
      { x: this.player.x, y: this.player.y },
      aimPoint,
      GAME_CONFIG.shotRange,
      MAP.walls,
      this.enemies.map((enemy) => ({ ...enemy.sim, targetable: enemy.visibleNow }))
    );

    if (result.hitIndex !== null) {
      this.killEnemy(this.enemies[result.hitIndex]);
    } else {
      this.statusText.setText('MISS');
      this.time.delayedCall(500, () => this.statusText.setText(''));
    }

    this.activeShot = { start: result.start, end: result.end };
    this.shotVisibleUntil = time + 120;
  }

  private killEnemy(enemy: Enemy) {
    enemy.sim.alive = false;
    enemy.body.setVisible(false);
    enemy.label.setVisible(false);
    enemy.ghost.setVisible(false);
    this.hitCount += 1;

    this.statusText.setText('HIT');

    const hitText = this.add.text(enemy.sim.x - 16, enemy.sim.y - 8, 'HIT', {
      color: '#fef3c7',
      fontSize: '16px',
      fontFamily: 'monospace',
    });

    this.tweens.add({
      targets: hitText,
      y: hitText.y - 18,
      alpha: 0,
      duration: 600,
      onComplete: () => hitText.destroy(),
    });

    this.time.delayedCall(500, () => this.statusText.setText(''));

    this.time.delayedCall(GAME_CONFIG.targetRespawnMs, () => {
      enemy.sim.alive = true;
      enemy.lastSeenAt = -Infinity;
    });
  }

  private killPlayer(reason: string) {
    this.playerAlive = false;
    this.player.setVisible(false);
    this.respawnAt = this.time.now + GAME_CONFIG.respawnTimeMs;

    this.mobileMoveVector = { x: 0, y: 0 };
    this.mobileMovePointerId = null;
    this.mobileMoveOrigin = null;
    this.mobileMoveCurrent = null;

    this.ownFlagCampStartedAt = null;
    this.ownFlagExitedAt = null;

    this.visionGraphics.clear();

    if (returnFlagOnDeath(this.ctf, 'player')) {
      this.statusText.setText(`${reason} — flag returned, respawning...`);
    } else {
      this.statusText.setText(`${reason} — respawning...`);
    }
  }

  private respawnPlayer() {
    this.playerAlive = true;
    this.player.setVisible(true);
    this.player.x = GAME_CONFIG.playerSpawnX;
    this.player.y = GAME_CONFIG.playerSpawnY;

    this.statusText.setText('RESPAWNED');
    this.time.delayedCall(700, () => this.statusText.setText(''));
  }

  private updateCampTimer(time: number) {
    if (!this.playerAlive) {
      this.ownFlagCampStartedAt = null;
      this.ownFlagExitedAt = null;
      this.campText.setText('');
      return;
    }

    const ownFlag = MAP.flags.find((flag) => flag.team === this.playerTeam);

    if (!ownFlag) {
      return;
    }

    const distanceToOwnFlag = Math.hypot(this.player.x - ownFlag.x, this.player.y - ownFlag.y);
    const insideOwnFlagCampZone = distanceToOwnFlag <= ownFlag.campRadius;

    if (insideOwnFlagCampZone) {
      if (this.ownFlagCampStartedAt === null) {
        this.ownFlagCampStartedAt = time;
      }

      this.ownFlagExitedAt = null;

      const elapsed = time - this.ownFlagCampStartedAt;
      const warningStartsAt = GAME_CONFIG.campGraceMs;
      const deathAt = GAME_CONFIG.campGraceMs + GAME_CONFIG.campWarningMs;

      if (elapsed >= deathAt) {
        this.killPlayer('CAMPING');
        return;
      }

      if (elapsed >= warningStartsAt) {
        const remaining = Math.ceil((deathAt - elapsed) / 1000);
        this.campText.setText(`LEAVE YOUR FLAG — death in ${remaining}s`);
      } else {
        const safeRemaining = Math.ceil((warningStartsAt - elapsed) / 1000);
        this.campText.setText(`Own flag zone: ${safeRemaining}s until warning`);
      }

      return;
    }

    if (this.ownFlagCampStartedAt !== null) {
      if (this.ownFlagExitedAt === null) {
        this.ownFlagExitedAt = time;
      }

      const outsideElapsed = time - this.ownFlagExitedAt;

      if (outsideElapsed >= GAME_CONFIG.campResetMs) {
        this.ownFlagCampStartedAt = null;
        this.ownFlagExitedAt = null;
        this.campText.setText('');
      } else {
        const resetRemaining = Math.ceil((GAME_CONFIG.campResetMs - outsideElapsed) / 1000);
        this.campText.setText(`Camp timer resetting in ${resetRemaining}s`);
      }

      return;
    }

    this.campText.setText('');
  }

  private drawActiveShot(time: number) {
    this.shotGraphics.clear();

    if (!this.activeShot || time > this.shotVisibleUntil) {
      return;
    }

    this.shotGraphics.lineStyle(3, 0xfef3c7, 0.95);
    this.shotGraphics.beginPath();
    this.shotGraphics.moveTo(this.activeShot.start.x, this.activeShot.start.y);
    this.shotGraphics.lineTo(this.activeShot.end.x, this.activeShot.end.y);
    this.shotGraphics.strokePath();

    this.shotGraphics.fillStyle(0xfef3c7, 1);
    this.shotGraphics.fillCircle(this.activeShot.end.x, this.activeShot.end.y, 4);
  }
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: GAME_CONFIG.viewportWidth,
  height: GAME_CONFIG.viewportHeight,
  parent: 'app',
  backgroundColor: '#111827',
  scene: GameScene,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: GAME_CONFIG.viewportWidth,
    height: GAME_CONFIG.viewportHeight,
  },
};

new Phaser.Game(config);
