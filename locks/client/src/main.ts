import './style.css';
import Phaser from 'phaser';

import { GAME_CONFIG, MAP } from './shared/config';
import type { Team } from './shared/config';
import type { Vec2 } from './shared/geometry';
import { carriedFlagTeam, computeVisionPolygon } from './shared/sim';
import {
  createGameState,
  isUnitVisibleToTeam,
  perceive,
  remainingRoundMs,
  step,
  IDLE_INTENT,
  TICK_MS,
} from './shared/state';
import type { GameEvent, GameState, Intent, Unit } from './shared/state';
import { makeAggroBrain } from './shared/bots';
import type { BotBrain } from './shared/bots';

const PLAYER_ID = 'r1';
const PLAYER_TEAM: Team = 'red';

type UnitView = {
  body: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  ghost: Phaser.GameObjects.Arc;
  carryDot: Phaser.GameObjects.Arc;
  prevPos: Vec2;
  lastSeenAt: number;
  lastSeenPos: Vec2;
};

type Tracer = { from: Vec2; to: Vec2; until: number };

class GameScene extends Phaser.Scene {
  private state!: GameState;
  private accumulator = 0;

  private unitViews: Map<string, UnitView> = new Map();
  private flagMarkers: Partial<Record<Team, Phaser.GameObjects.Arc[]>> = {};

  private debugText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private campText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;

  private aimGraphics!: Phaser.GameObjects.Graphics;
  private shotGraphics!: Phaser.GameObjects.Graphics;
  private mobileControlGraphics!: Phaser.GameObjects.Graphics;

  private fogRect!: Phaser.GameObjects.Rectangle;
  private fogMaskGraphics!: Phaser.GameObjects.Graphics;
  private fogPolygonCache: Map<number, Phaser.Math.Vector2[]> = new Map();

  private tracers: Tracer[] = [];
  private matchEndShown = false;

  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;

  private pendingLockTargetId: string | null = null;
  private pendingCancelLock = false;

  private mobileMovePointerId: number | null = null;
  private mobileMoveOrigin: Vec2 | null = null;
  private mobileMoveCurrent: Vec2 | null = null;
  private mobileMoveVector: Vec2 = { x: 0, y: 0 };

  private statusClearEvent: Phaser.Time.TimerEvent | null = null;
  private botBrains: Map<string, BotBrain> = new Map();

  constructor() {
    super('GameScene');
  }

  create() {
    // scene.restart() reuses this instance: reset everything here.
    this.state = createGameState();
    this.accumulator = 0;
    this.unitViews = new Map();
    this.flagMarkers = {};
    this.fogPolygonCache = new Map();
    this.tracers = [];
    this.matchEndShown = false;
    this.pendingLockTargetId = null;
    this.pendingCancelLock = false;
    this.mobileMovePointerId = null;
    this.mobileMoveOrigin = null;
    this.mobileMoveCurrent = null;
    this.mobileMoveVector = { x: 0, y: 0 };
    this.statusClearEvent = null;
    this.botBrains = new Map();

    this.cameras.main.setBackgroundColor('#111827');

    this.createArena();
    this.createUnits();
    this.createFog();
    this.createHud();

    const playerView = this.unitViews.get(PLAYER_ID)!;
    this.cameras.main.setBounds(0, 0, GAME_CONFIG.worldWidth, GAME_CONFIG.worldHeight);
    this.cameras.main.startFollow(playerView.body, true, 0.12, 0.12);

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keys = this.input.keyboard!.addKeys({
      w: Phaser.Input.Keyboard.KeyCodes.W,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<string, Phaser.Input.Keyboard.Key>;

    this.input.keyboard!.on('keydown-R', () => {
      if (this.state.match.phase === 'ended') this.scene.restart();
    });

    this.input.keyboard!.on('keydown-X', () => {
      this.pendingCancelLock = true;
    });

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.handlePointerDown(pointer);
    });
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (this.mobileMovePointerId === pointer.id) {
        this.mobileMoveCurrent = { x: pointer.x, y: pointer.y };
        this.updateMobileMoveVector(pointer);
      }
    });
    const release = (pointer: Phaser.Input.Pointer) => {
      if (this.mobileMovePointerId === pointer.id) {
        this.mobileMovePointerId = null;
        this.mobileMoveOrigin = null;
        this.mobileMoveCurrent = null;
        this.mobileMoveVector = { x: 0, y: 0 };
      }
    };
    this.input.on('pointerup', release);
    this.input.on('pointerupoutside', release);
  }

  // ------------------------------------------------------------------ setup

  private createArena() {
    for (const wallDef of MAP.walls) {
      const { rect, blocksShots } = wallDef;
      const width = rect.right - rect.left;
      const height = rect.bottom - rect.top;
      const cx = rect.left + width / 2;
      const cy = rect.top + height / 2;

      if (blocksShots) {
        this.add.rectangle(cx, cy, width, height, 0x475569);
      } else {
        const body = this.add.rectangle(cx, cy, width, height, 0x3f6212, 0.55);
        body.setStrokeStyle(2, 0x84cc16, 0.5);
      }
    }

    for (const flag of MAP.flags) {
      const color = flag.team === 'red' ? 0xef4444 : 0x3b82f6;

      this.add.circle(flag.x, flag.y, flag.visionRadius, color, 0.08);
      const visionRing = this.add.circle(flag.x, flag.y, flag.visionRadius);
      visionRing.setStrokeStyle(2, color, 0.22);

      if (flag.team === PLAYER_TEAM) {
        const campRing = this.add.circle(flag.x, flag.y, flag.campRadius);
        campRing.setStrokeStyle(2, 0xfca5a5, 0.32);
      }

      const outerMarker = this.add.circle(flag.x, flag.y, 28, color, 0.35);
      const innerMarker = this.add.circle(flag.x, flag.y, 8, color, 0.9);
      this.flagMarkers[flag.team] = [outerMarker, innerMarker];

      this.add.text(flag.x - 24, flag.y + 34, flag.team.toUpperCase(), {
        color: flag.team === 'red' ? '#fecaca' : '#bfdbfe',
        fontSize: '13px',
        fontFamily: 'system-ui, sans-serif',
      });
    }
  }

  private createUnits() {
    for (const unit of Object.values(this.state.units)) {
      const isPlayer = unit.id === PLAYER_ID;
      const color = unit.team === 'red' ? (isPlayer ? 0x38bdf8 : 0xf87171) : 0x3b82f6;

      const body = this.add.circle(unit.pos.x, unit.pos.y, GAME_CONFIG.playerRadius, color);
      body.setStrokeStyle(2, unit.team === 'red' ? 0xbae6fd : 0xbfdbfe, 0.9);
      body.setDepth(isPlayer ? 60 : 10);

      const label = this.add.text(unit.pos.x - 10, unit.pos.y - 34, unit.label, {
        color: unit.team === 'red' ? '#bae6fd' : '#bfdbfe',
        fontSize: '12px',
        fontFamily: 'monospace',
      });
      label.setDepth(body.depth);

      const ghost = this.add.circle(unit.pos.x, unit.pos.y, GAME_CONFIG.playerRadius, 0x3b82f6, 0.18);
      ghost.setStrokeStyle(1, 0x93c5fd, 0.35);
      ghost.setVisible(false);

      const carryDot = this.add.circle(unit.pos.x, unit.pos.y - GAME_CONFIG.playerRadius - 10, 6, 0xffffff, 0.95);
      carryDot.setDepth(body.depth + 1);
      carryDot.setVisible(false);

      this.unitViews.set(unit.id, {
        body,
        label,
        ghost,
        carryDot,
        prevPos: { ...unit.pos },
        lastSeenAt: -Infinity,
        lastSeenPos: { ...unit.pos },
      });
    }
  }

  private createFog() {
    this.fogRect = this.add.rectangle(
      GAME_CONFIG.worldWidth / 2,
      GAME_CONFIG.worldHeight / 2,
      GAME_CONFIG.worldWidth,
      GAME_CONFIG.worldHeight,
      0x070b16,
      0.82
    );
    this.fogRect.setDepth(50);

    this.fogMaskGraphics = this.make.graphics({}, false);
    this.fogRect.enableFilters();
    this.fogRect.filters!.internal.addMask(this.fogMaskGraphics, true);

    this.aimGraphics = this.add.graphics();
    this.aimGraphics.setDepth(60);
    this.shotGraphics = this.add.graphics();
    this.shotGraphics.setDepth(60);
    this.mobileControlGraphics = this.add.graphics();
    this.mobileControlGraphics.setDepth(100);
    this.mobileControlGraphics.setScrollFactor(0);
  }

  private createHud() {
    this.add
      .text(12, 10, 'Sniper Locks prototype', {
        color: '#ffffff',
        fontSize: '15px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setDepth(100)
      .setScrollFactor(0);

    this.add
      .text(12, 30, 'Move: WASD/drag • Lock: click enemy • X: cancel lock', {
        color: '#cbd5e1',
        fontSize: '11px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setDepth(100)
      .setScrollFactor(0);

    this.debugText = this.add
      .text(12, 50, '', {
        color: '#94a3b8',
        fontSize: '10px',
        fontFamily: 'monospace',
      })
      .setDepth(100)
      .setScrollFactor(0);

    this.statusText = this.add
      .text(12, 118, '', {
        color: '#fef3c7',
        fontSize: '13px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setDepth(100)
      .setScrollFactor(0);

    this.campText = this.add
      .text(12, 136, '', {
        color: '#fecaca',
        fontSize: '13px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setDepth(100)
      .setScrollFactor(0);

    this.timerText = this.add
      .text(GAME_CONFIG.viewportWidth / 2, 8, '', {
        color: '#ffffff',
        fontSize: '18px',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5, 0)
      .setDepth(100)
      .setScrollFactor(0);
  }

  // ------------------------------------------------------------------ input

  private handlePointerDown(pointer: Phaser.Input.Pointer) {
    if (this.state.match.phase === 'ended') {
      this.scene.restart();
      return;
    }

    const pointerEvent = pointer.event as Event & { pointerType?: string };
    const isTouch =
      (pointer as unknown as { wasTouch?: boolean }).wasTouch === true ||
      pointerEvent.pointerType === 'touch';

    if (isTouch && pointer.x < GAME_CONFIG.viewportWidth / 2) {
      this.mobileMovePointerId = pointer.id;
      this.mobileMoveOrigin = { x: pointer.x, y: pointer.y };
      this.mobileMoveCurrent = { x: pointer.x, y: pointer.y };
      this.updateMobileMoveVector(pointer);
      return;
    }

    // Lock attempt: click a rendered (i.e. team-visible) enemy.
    const click: Vec2 = { x: pointer.worldX, y: pointer.worldY };
    let bestId: string | null = null;
    let bestDistance = Infinity;

    for (const unit of Object.values(this.state.units)) {
      if (unit.team === PLAYER_TEAM || !unit.alive) continue;
      if (!isUnitVisibleToTeam(this.state, PLAYER_TEAM, unit)) continue;
      const d = Math.hypot(click.x - unit.pos.x, click.y - unit.pos.y);
      if (d <= GAME_CONFIG.playerRadius + GAME_CONFIG.lockClickTolerance && d < bestDistance) {
        bestDistance = d;
        bestId = unit.id;
      }
    }

    if (bestId !== null) {
      this.pendingLockTargetId = bestId;
    }
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
    const clamped = Math.min(dragDistance, GAME_CONFIG.mobileJoystickMaxDistance);
    const strength = clamped / GAME_CONFIG.mobileJoystickMaxDistance;
    this.mobileMoveVector = {
      x: (rawDx / dragDistance) * strength,
      y: (rawDy / dragDistance) * strength,
    };
  }

  private buildPlayerIntent(): Intent {
    let dx = 0;
    let dy = 0;
    if (this.cursors.left.isDown || this.keys.a.isDown) dx -= 1;
    if (this.cursors.right.isDown || this.keys.d.isDown) dx += 1;
    if (this.cursors.up.isDown || this.keys.w.isDown) dy -= 1;
    if (this.cursors.down.isDown || this.keys.s.isDown) dy += 1;
    dx += this.mobileMoveVector.x;
    dy += this.mobileMoveVector.y;

    const intent: Intent = { move: { x: dx, y: dy } };
    if (this.pendingLockTargetId !== null) {
      intent.lockTargetId = this.pendingLockTargetId;
      this.pendingLockTargetId = null;
    }
    if (this.pendingCancelLock) {
      intent.cancelLock = true;
      this.pendingCancelLock = false;
    }
    return intent;
  }

  // ------------------------------------------------------------------ loop

  update(time: number, delta: number) {
    if (this.state.match.phase === 'ended') {
      if (!this.matchEndShown) this.showMatchEnd();
      return;
    }

    this.accumulator += delta;
    // Avoid spiral-of-death after tab-switch pauses.
    this.accumulator = Math.min(this.accumulator, TICK_MS * 8);

    let ended = false;
    while (this.accumulator >= TICK_MS && !ended) {
      for (const [id, view] of this.unitViews) {
        view.prevPos = { ...this.state.units[id].pos };
      }

      const intents: Record<string, Intent> = {};
      for (const unit of Object.values(this.state.units)) {
        if (unit.control === 'player') {
          intents[unit.id] = unit.id === PLAYER_ID ? this.buildPlayerIntent() : IDLE_INTENT;
        } else {
          let brain = this.botBrains.get(unit.id);
          if (brain === undefined) {
            brain = makeAggroBrain(unit.id);
            this.botBrains.set(unit.id, brain);
          }
          intents[unit.id] = brain(perceive(this.state, unit.id));
        }
      }

      const events = step(this.state, intents);
      this.processEvents(events, time);
      ended = events.some((event) => event.type === 'match-end');
      this.accumulator -= TICK_MS;
    }

    const alpha = this.accumulator / TICK_MS;
    this.render(alpha, time);
  }

  private processEvents(events: GameEvent[], time: number) {
    for (const event of events) {
      switch (event.type) {
        case 'shot':
          this.tracers.push({ from: event.from, to: event.to, until: time + 120 });
          break;
        case 'kill': {
          const hitText = this.add.text(event.at.x - 16, event.at.y - 8, 'HIT', {
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
          if (event.unitId === PLAYER_ID) {
            this.setStatus(
              event.reason === 'camping' ? 'CAMPING — respawning...' : 'YOU DIED — respawning...',
              GAME_CONFIG.respawnTimeMs
            );
          }
          break;
        }
        case 'flag-grab':
          this.setStatus(
            event.byId === PLAYER_ID
              ? 'ENEMY FLAG TAKEN — bring it home'
              : `${this.state.units[event.byId].label} took the ${event.flagTeam.toUpperCase()} flag`,
            1500
          );
          break;
        case 'flag-capture':
          this.setStatus(
            `${event.scoringTeam.toUpperCase()} CAPTURES! +1`,
            1500
          );
          break;
        case 'flag-return':
          this.setStatus(`${event.flagTeam.toUpperCase()} flag returned`, 1200);
          break;
        case 'respawn':
          if (event.unitId === PLAYER_ID) this.setStatus('RESPAWNED', 700);
          break;
        case 'match-end':
          break;
      }
    }
  }

  private setStatus(text: string, clearAfterMs: number) {
    this.statusText.setText(text);
    if (this.statusClearEvent !== null) this.statusClearEvent.remove();
    this.statusClearEvent = this.time.delayedCall(clearAfterMs, () =>
      this.statusText.setText('')
    );
  }

  // ---------------------------------------------------------------- render

  private render(alpha: number, time: number) {
    const player = this.state.units[PLAYER_ID];

    for (const [id, view] of this.unitViews) {
      const unit = this.state.units[id];
      const x = view.prevPos.x + (unit.pos.x - view.prevPos.x) * alpha;
      const y = view.prevPos.y + (unit.pos.y - view.prevPos.y) * alpha;

      const onPlayerTeam = unit.team === PLAYER_TEAM;
      const seen =
        unit.alive && (onPlayerTeam || isUnitVisibleToTeam(this.state, PLAYER_TEAM, unit));

      view.body.setPosition(x, y);
      view.label.setPosition(x - 10, y - 34);
      view.body.setVisible(seen);
      view.label.setVisible(seen);

      if (seen && !onPlayerTeam) {
        view.lastSeenAt = time;
        view.lastSeenPos = { x, y };
      }

      const sinceSeen = time - view.lastSeenAt;
      const showGhost =
        !seen && !onPlayerTeam && unit.alive && sinceSeen <= GAME_CONFIG.lastSeenLingerMs;
      view.ghost.setVisible(showGhost);
      if (showGhost) {
        view.ghost.setPosition(view.lastSeenPos.x, view.lastSeenPos.y);
        view.ghost.setAlpha(1 - sinceSeen / GAME_CONFIG.lastSeenLingerMs);
      }

      // Carrier identity is public; position still gated by visibility.
      const carrying = carriedFlagTeam(this.state.ctf, id);
      const showDot = carrying !== null && seen;
      view.carryDot.setVisible(showDot);
      if (showDot) {
        view.carryDot.setFillStyle(carrying === 'red' ? 0xef4444 : 0x3b82f6, 0.95);
        view.carryDot.setPosition(x, y - GAME_CONFIG.playerRadius - 10);
      }
    }

    for (const flag of MAP.flags) {
      const atBase = this.state.ctf.flags[flag.team].atBase;
      for (const marker of this.flagMarkers[flag.team] ?? []) marker.setVisible(atBase);
    }

    this.drawAim(player);
    this.drawTracers(time);
    this.drawFog(player);
    this.drawMobileControls();
    this.updateHud(player);
  }

  private drawAim(player: Unit) {
    this.aimGraphics.clear();
    if (!player.alive) return;

    const view = this.unitViews.get(PLAYER_ID)!;
    const px = view.body.x;
    const py = view.body.y;
    const angle = player.facingRadians;

    if (player.lock !== null) {
      const halfCone = ((GAME_CONFIG.locks.attackConeDegrees * Math.PI) / 180) / 2;
      const coneLength = GAME_CONFIG.shotRange * 0.5;
      this.aimGraphics.lineStyle(1, 0xfbbf24, 0.3);
      for (const edge of [angle - halfCone, angle + halfCone]) {
        this.aimGraphics.beginPath();
        this.aimGraphics.moveTo(px, py);
        this.aimGraphics.lineTo(px + Math.cos(edge) * coneLength, py + Math.sin(edge) * coneLength);
        this.aimGraphics.strokePath();
      }
    }

    const aimLength = 80;
    this.aimGraphics.lineStyle(2, 0x93c5fd, 0.45);
    this.aimGraphics.beginPath();
    this.aimGraphics.moveTo(px, py);
    this.aimGraphics.lineTo(px + Math.cos(angle) * aimLength, py + Math.sin(angle) * aimLength);
    this.aimGraphics.strokePath();
    this.aimGraphics.fillStyle(0xffffff, 0.7);
    this.aimGraphics.fillCircle(px + Math.cos(angle) * aimLength, py + Math.sin(angle) * aimLength, 3);
  }

  private drawTracers(time: number) {
    this.shotGraphics.clear();
    this.tracers = this.tracers.filter((tracer) => time <= tracer.until);
    for (const tracer of this.tracers) {
      this.shotGraphics.lineStyle(3, 0xfef3c7, 0.95);
      this.shotGraphics.beginPath();
      this.shotGraphics.moveTo(tracer.from.x, tracer.from.y);
      this.shotGraphics.lineTo(tracer.to.x, tracer.to.y);
      this.shotGraphics.strokePath();
      this.shotGraphics.fillStyle(0xfef3c7, 1);
      this.shotGraphics.fillCircle(tracer.to.x, tracer.to.y, 4);
    }
  }

  private drawFog(player: Unit) {
    this.fogMaskGraphics.clear();

    if (player.alive) {
      const view = this.unitViews.get(PLAYER_ID)!;
      const renderPos: Vec2 = { x: view.body.x, y: view.body.y };

      // Cached polygons for decay samples; live polygon every frame.
      const liveKeys = new Set<number>();
      for (const sample of player.visionSamples) {
        liveKeys.add(sample.atTick);
        if (!this.fogPolygonCache.has(sample.atTick)) {
          this.fogPolygonCache.set(
            sample.atTick,
            computeVisionPolygon(sample.pos, MAP.walls, GAME_CONFIG.playerVisionRadius).map(
              (p) => new Phaser.Math.Vector2(p.x, p.y)
            )
          );
        }
      }
      for (const key of this.fogPolygonCache.keys()) {
        if (!liveKeys.has(key)) this.fogPolygonCache.delete(key);
      }

      for (const sample of player.visionSamples) {
        const ageMs = (this.state.tick - sample.atTick) * TICK_MS;
        const fade = Math.max(0.15, 1 - ageMs / GAME_CONFIG.visionMemoryMs) * 0.8;
        const polygon = this.fogPolygonCache.get(sample.atTick);
        if (polygon) {
          this.fogMaskGraphics.fillStyle(0xffffff, fade);
          this.fogMaskGraphics.fillPoints(polygon, true);
        }
      }

      const livePolygon = computeVisionPolygon(
        renderPos,
        MAP.walls,
        GAME_CONFIG.playerVisionRadius
      ).map((p) => new Phaser.Math.Vector2(p.x, p.y));
      this.fogMaskGraphics.fillStyle(0xffffff, 1);
      this.fogMaskGraphics.fillPoints(livePolygon, true);
    } else {
      this.fogPolygonCache.clear();
    }

    const ownFlag = MAP.flags.find((flag) => flag.team === PLAYER_TEAM);
    if (ownFlag) {
      this.fogMaskGraphics.fillStyle(0xffffff, 1);
      this.fogMaskGraphics.fillCircle(ownFlag.x, ownFlag.y, ownFlag.visionRadius);
    }
  }

  private drawMobileControls() {
    this.mobileControlGraphics.clear();
    if (!this.mobileMoveOrigin || !this.mobileMoveCurrent) return;

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

  private updateHud(player: Unit) {
    const remainingMs = remainingRoundMs(this.state);
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    this.timerText.setText(
      `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, '0')}`
    );

    const cooldownTicks = Math.max(
      0,
      Math.round(GAME_CONFIG.shotCooldownMs / TICK_MS) - (this.state.tick - player.lastShotAtTick)
    );
    const lockLabel =
      player.lock === null
        ? 'none'
        : `${this.state.units[player.lock.targetId].label}${
            isUnitVisibleToTeam(this.state, PLAYER_TEAM, this.state.units[player.lock.targetId])
              ? ''
              : ' (hidden)'
          }`;

    this.debugText.setText(
      [
        `tick=${this.state.tick} x=${player.pos.x.toFixed(0)} y=${player.pos.y.toFixed(0)}`,
        `cooldown=${Math.max(0, Math.round(cooldownTicks * TICK_MS))}ms`,
        `lock=${lockLabel}`,
        `score RED ${this.state.ctf.scores.red} — ${this.state.ctf.scores.blue} BLUE${
          carriedFlagTeam(this.state.ctf, PLAYER_ID) !== null ? '  [CARRYING FLAG]' : ''
        }`,
      ].join('\n')
    );

    this.updateCampText(player);
  }

  private updateCampText(player: Unit) {
    if (!player.alive || player.campStartedTick === null) {
      this.campText.setText('');
      return;
    }

    const graceMs = GAME_CONFIG.campGraceMs;
    const warningMs = GAME_CONFIG.campWarningMs;
    const elapsedMs = (this.state.tick - player.campStartedTick) * TICK_MS;

    if (player.campExitedTick !== null) {
      const outsideMs = (this.state.tick - player.campExitedTick) * TICK_MS;
      const resetRemaining = Math.ceil((GAME_CONFIG.campResetMs - outsideMs) / 1000);
      this.campText.setText(`Camp timer resetting in ${Math.max(0, resetRemaining)}s`);
      return;
    }

    if (elapsedMs >= graceMs) {
      const remaining = Math.ceil((graceMs + warningMs - elapsedMs) / 1000);
      this.campText.setText(`LEAVE YOUR FLAG — death in ${Math.max(0, remaining)}s`);
    } else {
      const safeRemaining = Math.ceil((graceMs - elapsedMs) / 1000);
      this.campText.setText(`Own flag zone: ${safeRemaining}s until warning`);
    }
  }

  private showMatchEnd() {
    this.matchEndShown = true;
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

    const result = this.state.match.result;
    const headline = result === 'draw' ? 'DRAW' : `${(result ?? '').toUpperCase()} TEAM WINS`;
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
        `RED ${this.state.ctf.scores.red} — ${this.state.ctf.scores.blue} BLUE`,
        { color: '#e2e8f0', fontSize: '20px', fontFamily: 'monospace' }
      )
      .setOrigin(0.5)
      .setDepth(201)
      .setScrollFactor(0);

    this.add
      .text(
        GAME_CONFIG.viewportWidth / 2,
        GAME_CONFIG.viewportHeight / 2 + 40,
        'Press R or tap to play again',
        { color: '#94a3b8', fontSize: '13px', fontFamily: 'system-ui, sans-serif' }
      )
      .setOrigin(0.5)
      .setDepth(201)
      .setScrollFactor(0);
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
