import './style.css';
import Phaser from 'phaser';

import { GAME_CONFIG, MAP } from './shared/config';
import type { Team } from './shared/config';
import type { Vec2 } from './shared/geometry';
import { computeVisionPolygon } from './shared/sim';
import { TICK_MS } from './shared/state';
import type { GameEvent, Intent, Unit } from './shared/state';
import type { Snapshot } from './shared/protocol';
import { LocalSession, OnlineSession } from './session';
import type { Frame, GameSession } from './session';

const TEAM_COLORS: Record<Team, number> = { red: 0xef4444, blue: 0x3b82f6 };
const TEAM_LIGHT: Record<Team, number> = { red: 0xfecaca, blue: 0xbfdbfe };

const DEFAULT_SERVER = (() => {
  const override = new URLSearchParams(window.location.search).get('server');
  if (override !== null && override !== '') return override;
  const fromEnv = (import.meta as { env?: Record<string, string> }).env?.VITE_LOCKS_SERVER;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  // https pages must use wss (mixed content); local dev falls back to :2567.
  const secure = window.location.protocol === 'https:';
  return secure
    ? `wss://${window.location.hostname}`
    : `ws://${window.location.hostname}:2567`;
})();

// ---------------------------------------------------------------------------

class MenuScene extends Phaser.Scene {
  private busy = false;
  private errorText!: Phaser.GameObjects.Text;

  constructor() {
    super('MenuScene');
  }

  create() {
    this.busy = false;
    this.cameras.main.setBackgroundColor('#111827');
    const cx = GAME_CONFIG.viewportWidth / 2;

    this.add
      .text(cx, 70, 'LOCKS', {
        color: '#ffffff',
        fontSize: '42px',
        fontFamily: 'system-ui, sans-serif',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, 110, 'capture the flag in the fog', {
        color: '#94a3b8',
        fontSize: '14px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setOrigin(0.5);

    this.makeButton(cx, 175, 'PRACTICE — EASY', () => {
      this.scene.start('GameScene', { session: new LocalSession('easy') });
    });

    this.makeButton(cx, 235, 'PRACTICE — NORMAL', () => {
      this.scene.start('GameScene', { session: new LocalSession('normal') });
    });

    this.makeButton(cx, 295, 'ONLINE', async () => {
      if (this.busy) return;
      this.busy = true;
      this.errorText.setText('Connecting...');
      try {
        const name = `Guest${Math.floor(Math.random() * 900 + 100)}`;
        const session = await OnlineSession.create(DEFAULT_SERVER, name);
        this.scene.start('GameScene', { session });
      } catch (error) {
        this.busy = false;
        this.errorText.setText(
          `Could not reach server (${DEFAULT_SERVER}). Is it running?`
        );
        console.error(error);
      }
    });

    this.errorText = this.add
      .text(cx, 350, '', {
        color: '#fca5a5',
        fontSize: '12px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setOrigin(0.5);
  }

  private makeButton(x: number, y: number, label: string, onClick: () => void) {
    const button = this.add
      .rectangle(x, y, 220, 48, 0x1f2937)
      .setStrokeStyle(2, 0x38bdf8, 0.7)
      .setInteractive({ useHandCursor: true });
    this.add
      .text(x, y, label, {
        color: '#e2e8f0',
        fontSize: '18px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setOrigin(0.5);
    button.on('pointerdown', onClick);
  }
}

// ---------------------------------------------------------------------------

type UnitView = {
  body: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  ghost: Phaser.GameObjects.Arc;
  carryDot: Phaser.GameObjects.Arc;
  lastSeenAt: number;
  lastSeenPos: Vec2;
  team: Team;
};

type Tracer = { from: Vec2; to: Vec2; until: number };

class GameScene extends Phaser.Scene {
  private session!: GameSession;
  private started = false;

  private unitViews: Map<string, UnitView> = new Map();
  private flagMarkers: Partial<Record<Team, Phaser.GameObjects.Arc[]>> = {};
  private cameraTarget!: Phaser.GameObjects.Rectangle;

  private connectingText!: Phaser.GameObjects.Text;
  private debugText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private campText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;

  private aimGraphics!: Phaser.GameObjects.Graphics;
  private shotGraphics!: Phaser.GameObjects.Graphics;
  private mobileControlGraphics!: Phaser.GameObjects.Graphics;
  private minimapGraphics!: Phaser.GameObjects.Graphics;

  private fogRect!: Phaser.GameObjects.Rectangle;
  private fogMaskGraphics!: Phaser.GameObjects.Graphics;
  private fogPolygonCache: Map<number, Phaser.Math.Vector2[]> = new Map();

  private tracers: Tracer[] = [];
  private matchEndShown = false;

  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;

  private pendingLockTargetId: string | null = null;
  private pendingCancelLock = false;
  private lastView: Snapshot | null = null;

  private mobileMovePointerId: number | null = null;
  private mobileMoveOrigin: Vec2 | null = null;
  private mobileMoveCurrent: Vec2 | null = null;
  private mobileMoveVector: Vec2 = { x: 0, y: 0 };

  private statusClearEvent: Phaser.Time.TimerEvent | null = null;

  constructor() {
    super('GameScene');
  }

  init(data: { session: GameSession }) {
    this.session = data.session;
  }

  create() {
    this.started = false;
    this.unitViews = new Map();
    this.flagMarkers = {};
    this.fogPolygonCache = new Map();
    this.tracers = [];
    this.matchEndShown = false;
    this.pendingLockTargetId = null;
    this.pendingCancelLock = false;
    this.lastView = null;
    this.mobileMovePointerId = null;
    this.mobileMoveOrigin = null;
    this.mobileMoveCurrent = null;
    this.mobileMoveVector = { x: 0, y: 0 };
    this.statusClearEvent = null;

    this.cameras.main.setBackgroundColor('#111827');

    this.createArena();
    this.createFog();
    this.createHud();

    this.cameraTarget = this.add.rectangle(0, 0, 2, 2, 0x000000, 0);
    this.cameras.main.setBounds(0, 0, GAME_CONFIG.worldWidth, GAME_CONFIG.worldHeight);
    this.cameras.main.startFollow(this.cameraTarget, true, 0.12, 0.12);

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keys = this.input.keyboard!.addKeys({
      w: Phaser.Input.Keyboard.KeyCodes.W,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<string, Phaser.Input.Keyboard.Key>;

    this.input.keyboard!.on('keydown-R', () => {
      if (this.lastView?.match.phase === 'ended') this.exitOrRestart();
    });
    this.input.keyboard!.on('keydown-X', () => {
      this.pendingCancelLock = true;
    });

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) =>
      this.handlePointerDown(pointer)
    );
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

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.session.dispose();
    });
  }

  private exitOrRestart() {
    if (this.session.mode === 'practice') {
      this.scene.restart({ session: new LocalSession() });
    } else {
      this.scene.start('MenuScene');
    }
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
      const color = TEAM_COLORS[flag.team];

      this.add.circle(flag.x, flag.y, flag.visionRadius, color, 0.08);
      const visionRing = this.add.circle(flag.x, flag.y, flag.visionRadius);
      visionRing.setStrokeStyle(2, color, 0.22);

      const campRing = this.add.circle(flag.x, flag.y, flag.campRadius);
      campRing.setStrokeStyle(2, 0xfca5a5, 0.2);

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

  private ensureUnitView(id: string, team: Team, label: string, isSelf: boolean): UnitView {
    let view = this.unitViews.get(id);
    if (view !== undefined) return view;

    const body = this.add.circle(0, 0, GAME_CONFIG.playerRadius, TEAM_COLORS[team]);
    // Team color encodes team; YOU get the white ring.
    body.setStrokeStyle(isSelf ? 3 : 1.5, isSelf ? 0xffffff : TEAM_LIGHT[team], 0.95);
    body.setDepth(isSelf ? 60 : 10);

    const labelText = this.add.text(0, 0, label, {
      color: team === 'red' ? '#fecaca' : '#bfdbfe',
      fontSize: '12px',
      fontFamily: 'monospace',
    });
    labelText.setDepth(body.depth);

    const ghost = this.add.circle(0, 0, GAME_CONFIG.playerRadius, TEAM_COLORS[team], 0.18);
    ghost.setStrokeStyle(1, TEAM_LIGHT[team], 0.35);
    ghost.setVisible(false);

    const carryDot = this.add.circle(0, 0, 6, 0xffffff, 0.95);
    carryDot.setDepth(body.depth + 1);
    carryDot.setVisible(false);

    view = {
      body,
      label: labelText,
      ghost,
      carryDot,
      lastSeenAt: -Infinity,
      lastSeenPos: { x: 0, y: 0 },
      team,
    };
    this.unitViews.set(id, view);
    return view;
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
    this.minimapGraphics = this.add.graphics();
    this.minimapGraphics.setDepth(110);
    this.minimapGraphics.setScrollFactor(0);
  }

  private createHud() {
    this.add
      .text(12, 10, 'Locks', {
        color: '#ffffff',
        fontSize: '15px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setDepth(100)
      .setScrollFactor(0);

    this.add
      .text(12, 30, 'Move: WASD/drag • Lock: click enemy • X: cancel', {
        color: '#cbd5e1',
        fontSize: '11px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setDepth(100)
      .setScrollFactor(0);

    this.connectingText = this.add
      .text(GAME_CONFIG.viewportWidth / 2, GAME_CONFIG.viewportHeight / 2, 'Connecting...', {
        color: '#e2e8f0',
        fontSize: '16px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setOrigin(0.5)
      .setDepth(100)
      .setScrollFactor(0);

    this.debugText = this.add
      .text(12, 50, '', { color: '#94a3b8', fontSize: '10px', fontFamily: 'monospace' })
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
    if (this.lastView?.match.phase === 'ended') {
      this.exitOrRestart();
      return;
    }

    const pointerEvent = pointer.event as Event & { pointerType?: string };
    const deviceHasTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
    const isTouch =
      (pointer as unknown as { wasTouch?: boolean }).wasTouch === true ||
      pointerEvent.pointerType === 'touch' ||
      (deviceHasTouch && pointerEvent.pointerType !== 'mouse');

    if (isTouch && pointer.x < GAME_CONFIG.viewportWidth / 2) {
      this.mobileMovePointerId = pointer.id;
      this.mobileMoveOrigin = { x: pointer.x, y: pointer.y };
      this.mobileMoveCurrent = { x: pointer.x, y: pointer.y };
      this.updateMobileMoveVector(pointer);
      return;
    }

    if (this.lastView === null) return;

    const click: Vec2 = { x: pointer.worldX, y: pointer.worldY };
    let bestId: string | null = null;
    let bestDistance = Infinity;
    for (const enemy of this.lastView.visibleEnemies) {
      const d = Math.hypot(click.x - enemy.pos.x, click.y - enemy.pos.y);
      if (d <= GAME_CONFIG.playerRadius + GAME_CONFIG.lockClickTolerance && d < bestDistance) {
        bestDistance = d;
        bestId = enemy.id;
      }
    }
    if (bestId !== null) this.pendingLockTargetId = bestId;
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
    if (this.lastView?.match.phase === 'ended') {
      if (!this.matchEndShown) this.showMatchEnd(this.lastView);
      return;
    }

    this.session.update(delta, this.buildPlayerIntent());
    const frame = this.session.frame();
    if (frame === null) return;

    if (!this.started) {
      this.started = true;
      this.connectingText.setVisible(false);
    }

    this.lastView = frame.view;
    this.processEvents(frame.events, time, frame.view);
    this.render(frame, time);
  }

  private processEvents(events: GameEvent[], time: number, view: Snapshot) {
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
          if (event.unitId === this.session.playerId) {
            this.setStatus(
              event.reason === 'camping' ? 'CAMPING — respawning...' : 'YOU DIED — respawning...',
              GAME_CONFIG.respawnTimeMs
            );
          }
          break;
        }
        case 'flag-grab':
          this.setStatus(
            event.byId === this.session.playerId
              ? 'ENEMY FLAG TAKEN — bring it home'
              : `${event.flagTeam.toUpperCase()} flag taken`,
            1500
          );
          break;
        case 'flag-capture':
          this.setStatus(`${event.scoringTeam.toUpperCase()} CAPTURES! +1`, 1500);
          break;
        case 'flag-return':
          this.setStatus(`${event.flagTeam.toUpperCase()} flag returned`, 1200);
          break;
        case 'respawn':
          if (event.unitId === this.session.playerId) this.setStatus('RESPAWNED', 700);
          break;
        case 'match-end':
          break;
      }
    }
    void view;
  }

  private setStatus(text: string, clearAfterMs: number) {
    this.statusText.setText(text);
    if (this.statusClearEvent !== null) this.statusClearEvent.remove();
    this.statusClearEvent = this.time.delayedCall(clearAfterMs, () =>
      this.statusText.setText('')
    );
  }

  // ---------------------------------------------------------------- render

  private interp(prev: Map<string, Vec2>, id: string, pos: Vec2, alpha: number): Vec2 {
    const from = prev.get(id);
    if (from === undefined) return pos;
    return { x: from.x + (pos.x - from.x) * alpha, y: from.y + (pos.y - from.y) * alpha };
  }

  private render(frame: Frame, time: number) {
    const { view, prev, alpha } = frame;
    const self = view.self;
    const selfId = this.session.playerId;

    const drawn = new Set<string>();

    const drawUnit = (
      id: string,
      team: Team,
      label: string,
      pos: Vec2,
      alive: boolean,
      carrying: Team | null
    ) => {
      const unitView = this.ensureUnitView(id, team, label, id === selfId);
      const p = this.interp(prev, id, pos, alpha);
      unitView.body.setPosition(p.x, p.y);
      unitView.label.setPosition(p.x - 10, p.y - 34);
      unitView.body.setVisible(alive);
      unitView.label.setVisible(alive);
      unitView.ghost.setVisible(false);
      const showDot = carrying !== null && alive;
      unitView.carryDot.setVisible(showDot);
      if (showDot) {
        unitView.carryDot.setFillStyle(TEAM_COLORS[carrying], 0.95);
        unitView.carryDot.setPosition(p.x, p.y - GAME_CONFIG.playerRadius - 10);
      }
      if (id !== selfId && team !== self.team && alive) {
        unitView.lastSeenAt = time;
        unitView.lastSeenPos = p;
      }
      drawn.add(id);
    };

    const carryingOf = (id: string): Team | null => {
      if (view.carrierIds.red === id) return 'red';
      if (view.carrierIds.blue === id) return 'blue';
      return null;
    };

    drawUnit(self.id, self.team, self.label, self.pos, self.alive, carryingOf(self.id));
    for (const ally of view.allies) {
      drawUnit(ally.id, ally.team, ally.label, ally.pos, ally.alive, carryingOf(ally.id));
    }
    for (const enemy of view.visibleEnemies) {
      drawUnit(enemy.id, enemy.team, enemy.label, enemy.pos, true, enemy.carryingFlag);
    }

    // Units not in this frame's view: hide; enemies get a fading ghost.
    for (const [id, unitView] of this.unitViews) {
      if (drawn.has(id)) continue;
      unitView.body.setVisible(false);
      unitView.label.setVisible(false);
      unitView.carryDot.setVisible(false);
      const sinceSeen = time - unitView.lastSeenAt;
      const showGhost =
        unitView.team !== self.team && sinceSeen <= GAME_CONFIG.lastSeenLingerMs;
      unitView.ghost.setVisible(showGhost);
      if (showGhost) {
        unitView.ghost.setPosition(unitView.lastSeenPos.x, unitView.lastSeenPos.y);
        unitView.ghost.setAlpha(1 - sinceSeen / GAME_CONFIG.lastSeenLingerMs);
      }
    }

    // Camera follows interpolated self.
    const selfView = this.unitViews.get(selfId);
    if (selfView !== undefined) {
      this.cameraTarget.setPosition(selfView.body.x, selfView.body.y);
    }

    for (const flag of MAP.flags) {
      const atBase = view.flagsAtBase[flag.team];
      for (const marker of this.flagMarkers[flag.team] ?? []) marker.setVisible(atBase);
    }

    this.drawAim(self);
    this.drawTracers(time);
    this.drawFog(view);
    this.drawMobileControls();
    this.drawMinimap(view);
    this.updateHud(view);
  }

  private drawAim(self: Unit) {
    this.aimGraphics.clear();
    if (!self.alive) return;

    const selfView = this.unitViews.get(self.id);
    if (selfView === undefined) return;
    const px = selfView.body.x;
    const py = selfView.body.y;
    const angle = self.facingRadians;

    if (self.lock !== null) {
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
    this.aimGraphics.fillCircle(
      px + Math.cos(angle) * aimLength,
      py + Math.sin(angle) * aimLength,
      3
    );
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

  private drawFog(view: Snapshot) {
    this.fogMaskGraphics.clear();
    const self = view.self;

    if (self.alive) {
      const liveKeys = new Set<number>();
      for (const sample of self.visionSamples) {
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

      for (const sample of self.visionSamples) {
        const ageMs = (view.tick - sample.atTick) * TICK_MS;
        const fade = Math.max(0.15, 1 - ageMs / GAME_CONFIG.visionMemoryMs) * 0.8;
        const polygon = this.fogPolygonCache.get(sample.atTick);
        if (polygon) {
          this.fogMaskGraphics.fillStyle(0xffffff, fade);
          this.fogMaskGraphics.fillPoints(polygon, true);
        }
      }

      const selfView = this.unitViews.get(self.id);
      const renderPos: Vec2 =
        selfView !== undefined ? { x: selfView.body.x, y: selfView.body.y } : self.pos;
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

    // Living teammates light their surroundings too (team vision) — including
    // while YOU are dead: the original's dead players spectated through their
    // team's eyes, which is also how you learn what killed you.
    for (const ally of view.allies) {
      if (!ally.alive) continue;
      const allyPolygon = computeVisionPolygon(
        ally.pos,
        MAP.walls,
        GAME_CONFIG.playerVisionRadius
      ).map((p) => new Phaser.Math.Vector2(p.x, p.y));
      this.fogMaskGraphics.fillStyle(0xffffff, 0.9);
      this.fogMaskGraphics.fillPoints(allyPolygon, true);
    }

    const ownFlag = MAP.flags.find((flag) => flag.team === view.self.team);
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

  private drawMinimap(view: Snapshot) {
    const size = 118;
    const pad = 8;
    const scale = size / GAME_CONFIG.worldWidth;
    const originX = GAME_CONFIG.viewportWidth - size - pad;
    const originY = GAME_CONFIG.viewportHeight - size - pad;
    const g = this.minimapGraphics;

    g.clear();
    g.fillStyle(0x0b1220, 0.85);
    g.fillRect(originX, originY, size, size);
    g.lineStyle(1, 0x334155, 1);
    g.strokeRect(originX, originY, size, size);

    for (const wall of MAP.walls) {
      const { rect, blocksShots } = wall;
      g.fillStyle(blocksShots ? 0x64748b : 0x3f6212, blocksShots ? 0.9 : 0.7);
      g.fillRect(
        originX + rect.left * scale,
        originY + rect.top * scale,
        Math.max(1, (rect.right - rect.left) * scale),
        Math.max(1, (rect.bottom - rect.top) * scale)
      );
    }

    for (const flag of MAP.flags) {
      const atBase = view.flagsAtBase[flag.team];
      g.lineStyle(1, TEAM_COLORS[flag.team], 1);
      g.strokeCircle(originX + flag.x * scale, originY + flag.y * scale, 3);
      if (atBase) {
        g.fillStyle(TEAM_COLORS[flag.team], 1);
        g.fillCircle(originX + flag.x * scale, originY + flag.y * scale, 2);
      }
    }

    const dot = (pos: Vec2, color: number, self: boolean) => {
      g.fillStyle(color, 1);
      g.fillCircle(originX + pos.x * scale, originY + pos.y * scale, self ? 3 : 2.5);
      if (self) {
        g.lineStyle(1, 0xffffff, 1);
        g.strokeCircle(originX + pos.x * scale, originY + pos.y * scale, 4);
      }
    };

    if (view.self.alive) dot(view.self.pos, TEAM_COLORS[view.self.team], true);
    for (const ally of view.allies) {
      if (ally.alive) dot(ally.pos, TEAM_COLORS[ally.team], false);
    }
    // Enemies come from the perception filter — the minimap can't wallhack.
    for (const enemy of view.visibleEnemies) {
      dot(enemy.pos, TEAM_COLORS[enemy.team], false);
    }

    // Viewport rectangle.
    const camera = this.cameras.main;
    g.lineStyle(1, 0xe2e8f0, 0.5);
    g.strokeRect(
      originX + camera.scrollX * scale,
      originY + camera.scrollY * scale,
      GAME_CONFIG.viewportWidth * scale,
      GAME_CONFIG.viewportHeight * scale
    );
  }

  private updateHud(view: Snapshot) {
    const totalSeconds = Math.max(0, Math.ceil(view.remainingMs / 1000));
    this.timerText.setText(
      `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, '0')}`
    );

    const self = view.self;
    const cooldownMs = Math.max(
      0,
      GAME_CONFIG.shotCooldownMs - (view.tick - self.lastShotAtTick) * TICK_MS
    );
    let lockLabel = 'none';
    if (self.lock !== null) {
      const lockTargetId = self.lock.targetId;
      const lockTarget = view.visibleEnemies.find((enemy) => enemy.id === lockTargetId);
      lockLabel =
        lockTarget !== undefined ? lockTarget.label : `${lockTargetId.toUpperCase()} (hidden)`;
    }

    this.debugText.setText(
      [
        `${this.session.mode} tick=${view.tick}`,
        `cooldown=${Math.round(cooldownMs)}ms`,
        `lock=${lockLabel}`,
        `score RED ${view.scores.red} — ${view.scores.blue} BLUE${
          view.carrierIds.red === self.id || view.carrierIds.blue === self.id
            ? '  [CARRYING FLAG]'
            : ''
        }`,
      ].join('\n')
    );

    this.updateCampText(view);
  }

  private updateCampText(view: Snapshot) {
    const self = view.self;
    if (!self.alive || self.campStartedTick === null) {
      this.campText.setText('');
      return;
    }

    if (self.campExitedTick !== null) {
      const outsideMs = (view.tick - self.campExitedTick) * TICK_MS;
      const resetRemaining = Math.ceil((GAME_CONFIG.campResetMs - outsideMs) / 1000);
      this.campText.setText(`Camp timer resetting in ${Math.max(0, resetRemaining)}s`);
      return;
    }

    const elapsedMs = (view.tick - self.campStartedTick) * TICK_MS;
    if (elapsedMs >= GAME_CONFIG.campGraceMs) {
      const remaining = Math.ceil(
        (GAME_CONFIG.campGraceMs + GAME_CONFIG.campWarningMs - elapsedMs) / 1000
      );
      this.campText.setText(`LEAVE YOUR FLAG — death in ${Math.max(0, remaining)}s`);
    } else {
      const safeRemaining = Math.ceil((GAME_CONFIG.campGraceMs - elapsedMs) / 1000);
      this.campText.setText(`Own flag zone: ${safeRemaining}s until warning`);
    }
  }

  private showMatchEnd(view: Snapshot) {
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

    const result = view.match.result;
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
        `RED ${view.scores.red} — ${view.scores.blue} BLUE`,
        { color: '#e2e8f0', fontSize: '20px', fontFamily: 'monospace' }
      )
      .setOrigin(0.5)
      .setDepth(201)
      .setScrollFactor(0);

    this.add
      .text(
        GAME_CONFIG.viewportWidth / 2,
        GAME_CONFIG.viewportHeight / 2 + 40,
        this.session.mode === 'practice'
          ? 'Press R or tap to play again'
          : 'Press R or tap for menu',
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
  scene: [MenuScene, GameScene],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: GAME_CONFIG.viewportWidth,
    height: GAME_CONFIG.viewportHeight,
  },
};

new Phaser.Game(config);
