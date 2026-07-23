import './style.css';
import Phaser from 'phaser';

import { CameraController } from './cameraController';
import { PointerGestureController } from './pointerGestureController';
import { GAME_CONFIG, MAP } from './shared/config';
import type { ExecutablePlayerCommand, PlayerCommand } from './shared/commands';
import { collidesWithWalls } from './shared/movement';
import type { Team } from './shared/config';
import type { Vec2 } from './shared/geometry';
import { computeVisionPolygon } from './shared/sim';
import { TICK_MS } from './shared/state';
import type { GameEvent, Intent, Unit } from './shared/state';
import type { CommandResultMessage, CommandResultReason, Snapshot } from './shared/protocol';
import { LocalSession, OnlineSession } from './session';
import {
  ensureAudio,
  playCapture,
  playFlagGrab,
  playKill,
  playRespawn,
  playShot,
  playUiClick,
} from './sound';
import type { Frame, GameSession, SessionConnectionStatus } from './session';

const TEAM_COLORS: Record<Team, number> = { red: 0xef4444, blue: 0x3b82f6 };
const TEAM_LIGHT: Record<Team, number> = { red: 0xfecaca, blue: 0xbfdbfe };

const ROOT_HOST = window.location.hostname.replace(/^www\./, '');

const DEFAULT_SERVER = (() => {
  const override = new URLSearchParams(window.location.search).get('server');
  if (override !== null && override !== '') return override;
  const fromEnv = (import.meta as { env?: Record<string, string> }).env?.VITE_LOCKS_SERVER;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return window.location.protocol === 'https:'
    ? `wss://game.${ROOT_HOST}`
    : `ws://${window.location.hostname}:2567`;
})();

const DEFAULT_LOBBY = (() => {
  const override = new URLSearchParams(window.location.search).get('lobby');
  if (override !== null && override !== '') return override;
  const fromEnv = (import.meta as { env?: Record<string, string> }).env?.VITE_LOCKS_LOBBY;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return window.location.protocol === 'https:'
    ? `https://lobby.${ROOT_HOST}`
    : `http://${window.location.hostname}:2568`;
})();

// Waypoint commands are the public default. The unlinked `?controls=wasd`
// query flag preserves direct movement as a developer comparison tool. It is
// intentionally not advertised in the menu and is not a security boundary.
type ControlMode = 'waypoint' | 'wasd';
const CONTROL_MODE: ControlMode =
  new URLSearchParams(window.location.search).get('controls') === 'wasd'
    ? 'wasd'
    : 'waypoint';

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
      .text(cx, 54, 'LOCKS', {
        color: '#ffffff',
        fontSize: '42px',
        fontFamily: 'system-ui, sans-serif',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, 94, 'capture the flag in the fog', {
        color: '#94a3b8',
        fontSize: '14px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setOrigin(0.5);

    this.createNameInput(cx, 140);

    // Primary: PLAY drops you online under your chosen name.
    this.makeButton(cx, 200, 'PLAY', async () => {
      if (this.busy) return;
      this.busy = true;
      this.errorText.setText('Connecting...');
      try {
        const session = await OnlineSession.create(
          DEFAULT_LOBBY,
          DEFAULT_SERVER,
          this.playerName()
        );
        this.removeNameInput();
        this.scene.start('GameScene', { session });
      } catch (error) {
        this.busy = false;
        const message = error instanceof Error ? error.message : 'Connection failed';
        this.errorText.setText(message.slice(0, 64));
        console.error(error);
      }
    });

    // Secondary: offline practice against bots.
    this.makeButton(cx, 258, 'PRACTICE — EASY', () => {
      this.removeNameInput();
      this.scene.start('GameScene', { session: new LocalSession('easy') });
    });
    this.makeButton(cx, 310, 'PRACTICE — NORMAL', () => {
      this.removeNameInput();
      this.scene.start('GameScene', { session: new LocalSession('normal') });
    });

    this.errorText = this.add
      .text(cx, 356, '', {
        color: '#fca5a5',
        fontSize: '12px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setOrigin(0.5);

    // Clean up the DOM input if the scene shuts down.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.removeNameInput());
  }

  private nameInput: HTMLInputElement | null = null;

  private createNameInput(centerX: number, y: number) {
    const canvas = this.game.canvas;
    const saved = (() => {
      try {
        return localStorage.getItem('locks.name') ?? '';
      } catch {
        return '';
      }
    })();

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 16;
    input.placeholder = 'your name';
    input.value = saved || `Guest${Math.floor(Math.random() * 900 + 100)}`;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    Object.assign(input.style, {
      position: 'absolute',
      width: '180px',
      padding: '8px 10px',
      fontSize: '16px',
      fontFamily: 'system-ui, sans-serif',
      textAlign: 'center',
      color: '#e2e8f0',
      background: '#0b1220',
      border: '2px solid #38bdf8',
      borderRadius: '6px',
      outline: 'none',
      zIndex: '10',
    });
    document.body.appendChild(input);
    this.nameInput = input;

    const reposition = () => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width / GAME_CONFIG.viewportWidth;
      const scaleY = rect.height / GAME_CONFIG.viewportHeight;
      input.style.left = `${rect.left + centerX * scaleX - 90}px`;
      input.style.top = `${rect.top + y * scaleY - 18}px`;
    };
    reposition();
    this.scale.on('resize', reposition);
    window.addEventListener('scroll', reposition, { passive: true });
    (input as unknown as { _reposition: () => void })._reposition = reposition;
  }

  private playerName(): string {
    const raw = (this.nameInput?.value ?? '').trim();
    const name = raw.length > 0 ? raw.slice(0, 16) : `Guest${Math.floor(Math.random() * 900 + 100)}`;
    try {
      localStorage.setItem('locks.name', name);
    } catch {
      /* ignore */
    }
    return name;
  }

  private removeNameInput() {
    if (this.nameInput === null) return;
    const reposition = (this.nameInput as unknown as { _reposition?: () => void })._reposition;
    if (reposition) {
      this.scale.off('resize', reposition);
      window.removeEventListener('scroll', reposition);
    }
    this.nameInput.remove();
    this.nameInput = null;
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
    button.on('pointerdown', () => {
      // First user gesture unlocks the AudioContext (autoplay policy).
      void ensureAudio().then(() => playUiClick());
      onClick();
    });
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

type ContextualCommandOptions = {
  queue: boolean;
  allowGround?: boolean;
  touch?: boolean;
};

type CommandGestureContext = {
  commandOptions: ContextualCommandOptions;
};

type TapFeedback = {
  point: Vec2;
  kind: 'move' | 'attack' | 'invalid';
  targetId?: string;
  startedAt: number;
  until: number;
  confirmedAt: number | null;
  commandId: number | null;
};

type CommandMarkerSnapshot = {
  key: string;
  kind: 'move' | 'attack';
  point: Vec2;
  hidden: boolean;
  active: boolean;
  queueNumber: number | null;
};

type FadingCommandMarker = Omit<CommandMarkerSnapshot, 'key' | 'queueNumber'> & {
  startedAt: number;
  until: number;
};

class GameScene extends Phaser.Scene {
  private session!: GameSession;
  private started = false;

  private unitViews: Map<string, UnitView> = new Map();
  private flagMarkers: Partial<Record<Team, Phaser.GameObjects.Arc[]>> = {};
  private cameraTarget!: Phaser.GameObjects.Rectangle;
  private cameraController!: CameraController;
  private cameraInitialized = false;

  private connectingText!: Phaser.GameObjects.Text;
  private debugText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private campText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private orderText!: Phaser.GameObjects.Text;

  private aimGraphics!: Phaser.GameObjects.Graphics;
  private shotGraphics!: Phaser.GameObjects.Graphics;
  private mobileControlGraphics!: Phaser.GameObjects.Graphics;
  private commandGraphics!: Phaser.GameObjects.Graphics;
  private commandLabelTexts: Phaser.GameObjects.Text[] = [];
  private previousCommandMarkers: Map<string, CommandMarkerSnapshot> = new Map();
  private fadingCommandMarkers: FadingCommandMarker[] = [];
  private tapFeedbackGraphics!: Phaser.GameObjects.Graphics;
  private minimapGraphics!: Phaser.GameObjects.Graphics;

  private fogRect!: Phaser.GameObjects.Rectangle;
  private fogMaskGraphics!: Phaser.GameObjects.Graphics;
  private fogPolygonCache: Map<number, Phaser.Math.Vector2[]> = new Map();

  private tracers: Tracer[] = [];
  private matchEndShown = false;

  private connectionOverlay: Phaser.GameObjects.Container | null = null;
  private connectionHeadlineText: Phaser.GameObjects.Text | null = null;
  private connectionDetailText: Phaser.GameObjects.Text | null = null;
  private connectionRetryBusy = false;
  private connectionRetryError: string | null = null;

  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;

  private pendingLockTargetId: string | null = null;
  private pendingCancelLock = false;
  private lastView: Snapshot | null = null;

  private mobileMovePointerId: number | null = null;
  private mobileMoveOrigin: Vec2 | null = null;
  private mobileMoveCurrent: Vec2 | null = null;
  private mobileMoveVector: Vec2 = { x: 0, y: 0 };

  private gestureController = new PointerGestureController<CommandGestureContext>();
  private queueEnabled = false;
  private queueButtonBg: Phaser.GameObjects.Rectangle | null = null;
  private queueButtonText: Phaser.GameObjects.Text | null = null;
  private queueButtonRenderKey = '';
  private tapFeedbacks: TapFeedback[] = [];

  private statusClearEvent: Phaser.Time.TimerEvent | null = null;

  private readonly handleWindowBlur = () => this.cancelPointerGestures();
  private readonly handleVisibilityChange = () => {
    if (document.visibilityState !== 'visible') this.cancelPointerGestures();
  };
  private readonly handleScaleResize = () => this.cameraController.handleResize();

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
    this.cameraInitialized = false;
    this.connectionOverlay = null;
    this.connectionHeadlineText = null;
    this.connectionDetailText = null;
    this.connectionRetryBusy = false;
    this.connectionRetryError = null;
    this.pendingLockTargetId = null;
    this.pendingCancelLock = false;
    this.lastView = null;
    this.mobileMovePointerId = null;
    this.mobileMoveOrigin = null;
    this.mobileMoveCurrent = null;
    this.mobileMoveVector = { x: 0, y: 0 };
    this.gestureController = new PointerGestureController<CommandGestureContext>();
    this.queueEnabled = false;
    this.queueButtonBg = null;
    this.queueButtonText = null;
    this.queueButtonRenderKey = '';
    this.commandLabelTexts = [];
    this.previousCommandMarkers = new Map();
    this.fadingCommandMarkers = [];
    this.tapFeedbacks = [];
    this.statusClearEvent = null;

    this.cameras.main.setBackgroundColor('#111827');

    this.createArena();
    this.createFog();
    this.createHud();

    this.cameraTarget = this.add.rectangle(0, 0, 2, 2, 0x000000, 0);
    this.cameraController = new CameraController(this.cameras.main, this.cameraTarget, {
      worldWidth: GAME_CONFIG.worldWidth,
      worldHeight: GAME_CONFIG.worldHeight,
    });
    this.createMobileCommandButtons();

    this.input.mouse?.disableContextMenu();

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keys = this.input.keyboard!.addKeys({
      w: Phaser.Input.Keyboard.KeyCodes.W,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<string, Phaser.Input.Keyboard.Key>;

    this.input.keyboard!.on('keydown-R', () => {
      if (this.connectionOverlay !== null && this.session.mode === 'online') {
        void this.retryOnlineMatch();
      } else if (this.lastView?.match.phase === 'ended') {
        this.exitOrRestart();
      }
    });
    this.input.keyboard!.on('keydown-X', () => {
      this.pendingCancelLock = true;
    });
    this.input.keyboard!.on('keydown-ESC', () => {
      this.issueStopCommand();
    });

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) =>
      this.handlePointerDown(pointer)
    );
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (this.mobileMovePointerId === pointer.id) {
        this.mobileMoveCurrent = { x: pointer.x, y: pointer.y };
        this.updateMobileMoveVector(pointer);
      }

      // Continue classifying tap versus drag, but the camera always follows.
      // Once a gesture becomes a drag, releasing it never issues a command.
      this.gestureController.move(pointer.id, {
        x: pointer.x,
        y: pointer.y,
      });
    });
    const release = (pointer: Phaser.Input.Pointer) => {
      if (this.mobileMovePointerId === pointer.id) {
        this.resetMobileMovePointer();
      }

      const result = this.gestureController.end(
        pointer.id,
        { x: pointer.x, y: pointer.y },
        performance.now()
      );
      if (result?.kind === 'tap') {
        const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        this.issueContextualCommand(
          { x: worldPoint.x, y: worldPoint.y },
          result.context.commandOptions
        );
      }
    };
    this.input.on('pointerup', release);
    this.input.on('pointerupoutside', release);
    this.input.on('pointercancel', (pointer: Phaser.Input.Pointer) => {
      this.gestureController.cancel(pointer.id);
      if (this.mobileMovePointerId === pointer.id) this.resetMobileMovePointer();
    });

    window.addEventListener('blur', this.handleWindowBlur);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.scale.on('resize', this.handleScaleResize);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener('blur', this.handleWindowBlur);
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      this.scale.off('resize', this.handleScaleResize);
      this.cancelPointerGestures();
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
    this.commandGraphics = this.add.graphics();
    this.commandGraphics.setDepth(55);
    this.tapFeedbackGraphics = this.add.graphics();
    this.tapFeedbackGraphics.setDepth(65);
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
      .text(
        12,
        30,
        CONTROL_MODE === 'waypoint'
          ? 'Command: right-click/tap • Queue: Shift/QUEUE • Stop: Esc'
          : 'Move: WASD/drag • Lock: click enemy • X: cancel',
        {
          color: '#cbd5e1',
          fontSize: '11px',
          fontFamily: 'system-ui, sans-serif',
        }
      )
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

    this.orderText = this.add
      .text(GAME_CONFIG.viewportWidth - 12, 10, 'ORDER  IDLE', {
        color: '#e2e8f0',
        fontSize: '11px',
        fontFamily: 'monospace',
        align: 'right',
        backgroundColor: '#0b1220',
        padding: { x: 6, y: 4 },
      })
      .setOrigin(1, 0)
      .setDepth(100)
      .setScrollFactor(0);
  }

  private createMobileCommandButtons() {
    const hasTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
    if (CONTROL_MODE !== 'waypoint' || !hasTouch) return;

    const y = GAME_CONFIG.viewportHeight - 32;
    const height = 52;

    this.queueButtonBg = this.add
      .rectangle(60, y, 104, height, 0x1f2937, 0.9)
      .setStrokeStyle(2, 0x64748b, 0.9)
      .setScrollFactor(0)
      .setDepth(120)
      .setInteractive({ useHandCursor: true });
    this.queueButtonText = this.add
      .text(60, y, 'QUEUE OFF', {
        color: '#cbd5e1',
        fontSize: '12px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(121);

    this.queueButtonBg.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: { stopPropagation(): void }
      ) => {
        event.stopPropagation();
        this.queueEnabled = !this.queueEnabled;
        this.refreshQueueButton();
        this.setStatus(this.queueEnabled ? 'Queue mode on' : 'Queue mode off', 650);
      }
    );

    const stopBg = this.add
      .rectangle(157, y, 78, height, 0x3f1d1d, 0.9)
      .setStrokeStyle(2, 0xf87171, 0.8)
      .setScrollFactor(0)
      .setDepth(120)
      .setInteractive({ useHandCursor: true });
    this.add
      .text(157, y, 'STOP', {
        color: '#fecaca',
        fontSize: '12px',
        fontFamily: 'system-ui, sans-serif',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(121);
    stopBg.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: { stopPropagation(): void }
      ) => {
        event.stopPropagation();
        this.issueStopCommand();
      }
    );

    this.refreshQueueButton();
  }

  private refreshQueueButton() {
    if (this.queueButtonBg === null || this.queueButtonText === null) return;
    const pending = this.lastView?.commands.queue.length ?? 0;
    const renderKey = `${this.queueEnabled}:${pending}`;
    if (renderKey === this.queueButtonRenderKey) return;
    this.queueButtonRenderKey = renderKey;

    this.queueButtonBg.setFillStyle(this.queueEnabled ? 0x0369a1 : 0x1f2937, 0.94);
    this.queueButtonBg.setStrokeStyle(2, this.queueEnabled ? 0x7dd3fc : 0x64748b, 0.95);
    this.queueButtonText.setText(
      this.queueEnabled && pending > 0
        ? `QUEUE ON · ${pending}`
        : this.queueEnabled
          ? 'QUEUE ON'
          : 'QUEUE OFF'
    );
    this.queueButtonText.setColor(this.queueEnabled ? '#f0f9ff' : '#cbd5e1');
    this.queueButtonText.setFontStyle(this.queueEnabled ? 'bold' : 'normal');
  }


  // ------------------------------------------------------------------ input

  private handlePointerDown(pointer: Phaser.Input.Pointer) {
    if (this.connectionOverlay !== null) return;

    if (this.lastView?.match.phase === 'ended') {
      this.exitOrRestart();
      return;
    }

    const pointerEvent = pointer.event as Event & {
      pointerType?: string;
      shiftKey?: boolean;
    };
    const isTouch = this.isTouchPointer(pointer, pointerEvent.pointerType);

    if (CONTROL_MODE === 'wasd') {
      if (isTouch && pointer.x < GAME_CONFIG.viewportWidth / 2) {
        this.mobileMovePointerId = pointer.id;
        this.mobileMoveOrigin = { x: pointer.x, y: pointer.y };
        this.mobileMoveCurrent = { x: pointer.x, y: pointer.y };
        this.updateMobileMoveVector(pointer);
        return;
      }
      this.issueContextualCommand(
        { x: pointer.worldX, y: pointer.worldY },
        { queue: false, allowGround: false }
      );
      return;
    }

    if (pointer.rightButtonDown()) {
      this.issueContextualCommand(
        { x: pointer.worldX, y: pointer.worldY },
        { queue: pointerEvent.shiftKey === true, allowGround: true }
      );
      return;
    }

    if (!isTouch && !pointer.leftButtonDown()) return;

    this.gestureController.begin(
      pointer.id,
      { x: pointer.x, y: pointer.y },
      performance.now(),
      {
        commandOptions: {
          queue: isTouch ? this.queueEnabled : false,
          allowGround: isTouch,
          touch: isTouch,
        },
      }
    );
  }

  private isTouchPointer(pointer: Phaser.Input.Pointer, pointerType?: string): boolean {
    const deviceHasTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
    return (
      (pointer as unknown as { wasTouch?: boolean }).wasTouch === true ||
      pointerType === 'touch' ||
      (deviceHasTouch && pointerType !== 'mouse')
    );
  }

  private issueContextualCommand(point: Vec2, options: ContextualCommandOptions) {
    if (this.lastView === null || !this.lastView.self.alive) return;

    const touchPadding = options.touch ? this.touchTargetPaddingWorld() : 0;
    let bestId: string | null = null;
    let bestDistance = Infinity;
    let bestPosition: Vec2 | null = null;
    for (const enemy of this.lastView.visibleEnemies) {
      const d = Math.hypot(point.x - enemy.pos.x, point.y - enemy.pos.y);
      const hitRadius =
        GAME_CONFIG.playerRadius + GAME_CONFIG.lockClickTolerance + touchPadding;
      if (d <= hitRadius && d < bestDistance) {
        bestDistance = d;
        bestId = enemy.id;
        bestPosition = enemy.pos;
      }
    }

    if (bestId !== null) {
      if (CONTROL_MODE === 'waypoint') {
        const commandId = this.session.issueCommand(
          { type: 'attack', targetId: bestId },
          options.queue
        );
        if (commandId === null) {
          this.setStatus('Command unavailable', 800);
          return;
        }
        this.setStatus(options.queue ? 'Attack queued' : 'Attack order', 650);
        if (options.touch && bestPosition !== null) {
          this.addTapFeedback(bestPosition, 'attack', bestId, commandId);
        }
      } else {
        this.pendingLockTargetId = bestId;
      }
      return;
    }
    if (options.allowGround !== true || CONTROL_MODE !== 'waypoint') return;

    const radius = GAME_CONFIG.playerRadius;
    const valid =
      point.x >= radius &&
      point.y >= radius &&
      point.x <= GAME_CONFIG.worldWidth - radius &&
      point.y <= GAME_CONFIG.worldHeight - radius &&
      !collidesWithWalls(point.x, point.y, radius, MAP.walls);
    if (!valid) {
      this.setStatus('Cannot move there', 800);
      if (options.touch) this.addTapFeedback(point, 'invalid');
      return;
    }

    const command: PlayerCommand = { type: 'move', x: point.x, y: point.y };
    const commandId = this.session.issueCommand(command, options.queue);
    if (commandId === null) {
      this.setStatus('Command unavailable', 800);
      return;
    }
    this.setStatus(options.queue ? 'Move queued' : 'Move order', 650);
    if (options.touch) this.addTapFeedback(point, 'move', undefined, commandId);
  }

  private touchTargetPaddingWorld(): number {
    const rect = this.game.canvas.getBoundingClientRect();
    if (rect.width <= 0) return 16;
    const logicalPerCssPixel = GAME_CONFIG.viewportWidth / rect.width;
    const worldPerLogicalPixel = 1 / Math.max(0.001, this.cameras.main.zoom);
    return Math.max(12, Math.min(30, 15 * logicalPerCssPixel * worldPerLogicalPixel));
  }

  private addTapFeedback(
    point: Vec2,
    kind: TapFeedback['kind'],
    targetId?: string,
    commandId: number | null = null
  ) {
    const startedAt = this.time.now;
    this.tapFeedbacks.push({
      point: { ...point },
      kind,
      targetId,
      startedAt,
      until: startedAt + (kind === 'invalid' ? 320 : 900),
      confirmedAt: null,
      commandId,
    });
  }

  private issueStopCommand() {
    this.session.issueCommand({ type: 'stop' }, false);
    this.pendingCancelLock = true;
    this.disableQueue();
    this.setStatus('Orders cleared', 650);
  }

  private disableQueue() {
    if (!this.queueEnabled) return;
    this.queueEnabled = false;
    this.refreshQueueButton();
  }


  private cancelPointerGestures() {
    this.gestureController.cancel();
    this.resetMobileMovePointer();
  }

  private resetMobileMovePointer() {
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
    if (CONTROL_MODE === 'wasd') {
      if (this.cursors.left.isDown || this.keys.a.isDown) dx -= 1;
      if (this.cursors.right.isDown || this.keys.d.isDown) dx += 1;
      if (this.cursors.up.isDown || this.keys.w.isDown) dy -= 1;
      if (this.cursors.down.isDown || this.keys.s.isDown) dy += 1;
      dx += this.mobileMoveVector.x;
      dy += this.mobileMoveVector.y;
    }

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
      this.disableQueue();
      this.cancelPointerGestures();
      if (!this.matchEndShown) this.showMatchEnd(this.lastView);
      return;
    }

    const connection = this.session.connectionStatus();
    if (
      connection.state === 'stale' ||
      connection.state === 'closed' ||
      connection.state === 'error'
    ) {
      this.showConnectionOverlay(connection);
      if (connection.state !== 'stale') {
        this.disableQueue();
        this.cancelPointerGestures();
        return;
      }
    } else if (connection.state === 'connected' && !this.connectionRetryBusy) {
      this.clearConnectionOverlay();
    }

    this.session.update(delta, this.buildPlayerIntent());
    const frame = this.session.frame();
    if (frame === null) return;

    if (!this.started) {
      this.started = true;
      this.connectingText.setVisible(false);
    }

    this.lastView = frame.view;
    this.processCommandResults(frame.commandResults, time);
    this.processEvents(frame.events, time, frame.view);
    this.render(frame, time);
  }

  private processCommandResults(results: CommandResultMessage[], time: number) {
    for (const result of results) {
      const feedback = this.tapFeedbacks.find(
        (candidate) => candidate.commandId === result.requestId
      );

      if (result.outcome === 'accepted') {
        if (feedback !== undefined && feedback.kind !== 'invalid') {
          feedback.confirmedAt = time;
          feedback.until = Math.min(feedback.until, time + 140);
        }
        continue;
      }

      if (result.outcome === 'superseded') {
        if (feedback !== undefined) feedback.until = Math.min(feedback.until, time + 90);
        continue;
      }

      if (feedback !== undefined) {
        feedback.kind = 'invalid';
        feedback.confirmedAt = null;
        feedback.startedAt = time;
        feedback.until = time + 360;
      }
      this.setStatus(this.commandRejectionLabel(result.reason), 1_000);
    }
  }

  private commandRejectionLabel(reason?: CommandResultReason): string {
    switch (reason) {
      case 'dead':
        return 'Cannot command while respawning';
      case 'match-ended':
        return 'Match has ended';
      case 'invalid-destination':
        return 'Cannot move there';
      case 'target-unavailable':
        return 'Target no longer available';
      case 'queue-full':
        return 'Command queue full';
      case 'input-buffer-full':
        return 'Too many commands at once';
      case 'invalid-command':
      default:
        return 'Command rejected';
    }
  }

  private processEvents(events: GameEvent[], time: number, view: Snapshot) {
    for (const event of events) {
      switch (event.type) {
        case 'shot': {
          this.tracers.push({ from: event.from, to: event.to, until: time + 120 });
          const selfPos = view.self.pos;
          const d = Math.hypot(event.from.x - selfPos.x, event.from.y - selfPos.y);
          playShot(d);
          break;
        }
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
          const isSelf = event.unitId === this.session.playerId;
          const dKill = Math.hypot(event.at.x - view.self.pos.x, event.at.y - view.self.pos.y);
          playKill(isSelf, dKill);
          if (isSelf) {
            this.cancelPointerGestures();
            this.disableQueue();
            this.setStatus(
              event.reason === 'camping' ? 'CAMPING — respawning...' : 'YOU DIED — respawning...',
              GAME_CONFIG.respawnTimeMs
            );
          }
          break;
        }
        case 'flag-grab':
          playFlagGrab(event.byId === this.session.playerId);
          this.setStatus(
            event.byId === this.session.playerId
              ? 'ENEMY FLAG TAKEN — bring it home'
              : `${event.flagTeam.toUpperCase()} flag taken`,
            1500
          );
          break;
        case 'flag-capture':
          playCapture(event.scoringTeam === view.self.team);
          this.setStatus(`${event.scoringTeam.toUpperCase()} CAPTURES! +1`, 1500);
          break;
        case 'flag-return':
          this.setStatus(`${event.flagTeam.toUpperCase()} flag returned`, 1200);
          break;
        case 'respawn':
          if (event.unitId === this.session.playerId) {
            playRespawn();
            this.disableQueue();
            this.setStatus('RESPAWNED', 700);
          }
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

    // The camera always follows the interpolated player position. There is no
    // free-camera state, deadzone, drag pan, or manual recenter control.
    const selfView = this.unitViews.get(selfId);
    if (selfView !== undefined) {
      const cameraPoint = { x: selfView.body.x, y: selfView.body.y };
      this.cameraController.setTarget(cameraPoint);
      if (!this.cameraInitialized) {
        this.cameraController.recenter(cameraPoint, true);
        this.cameraInitialized = true;
      }
    }

    for (const flag of MAP.flags) {
      const atBase = view.flagsAtBase[flag.team];
      for (const marker of this.flagMarkers[flag.team] ?? []) marker.setVisible(atBase);
    }

    this.drawCommandQueue(view, time);
    this.reconcileTapFeedback(view, time);
    this.drawTapFeedback(time);
    this.drawAim(self);
    this.drawTracers(time);
    this.drawFog(view);
    this.drawMobileControls();
    this.drawMinimap(view);
    this.updateHud(view);
  }

  private drawCommandQueue(view: Snapshot, time: number) {
    this.commandGraphics.clear();
    for (const label of this.commandLabelTexts) label.setVisible(false);

    if (CONTROL_MODE !== 'waypoint' || !view.self.alive) {
      this.previousCommandMarkers.clear();
      this.fadingCommandMarkers = [];
      return;
    }

    const markers = this.commandMarkers(view);
    this.updateFadingCommandMarkers(markers, time);

    for (const fading of this.fadingCommandMarkers) {
      const life = Math.max(1, fading.until - fading.startedAt);
      const alpha = Math.max(0, (fading.until - time) / life);
      this.drawCommandMarker(fading, 0.45 * alpha);
    }

    const selfView = this.unitViews.get(view.self.id);
    let from =
      selfView === undefined
        ? { ...view.self.pos }
        : { x: selfView.body.x, y: selfView.body.y };

    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index];
      const lineColor = marker.kind === 'move' ? 0x38bdf8 : 0xfb923c;
      this.commandGraphics.lineStyle(
        marker.active ? 3 : 2,
        lineColor,
        marker.active ? 0.7 : 0.25
      );
      this.commandGraphics.beginPath();
      this.commandGraphics.moveTo(from.x, from.y);
      this.commandGraphics.lineTo(marker.point.x, marker.point.y);
      this.commandGraphics.strokePath();

      this.drawCommandMarker(marker, 1);
      this.positionCommandLabel(index, marker);
      from = { ...marker.point };
    }
  }

  private commandMarkers(view: Snapshot): CommandMarkerSnapshot[] {
    const entries: Array<{
      command: ExecutablePlayerCommand;
      active: boolean;
      queueNumber: number | null;
    }> = [];
    if (view.commands.active !== null) {
      entries.push({ command: view.commands.active, active: true, queueNumber: null });
    }
    view.commands.queue.forEach((command, index) => {
      entries.push({ command, active: false, queueNumber: index + 1 });
    });

    const occurrences = new Map<string, number>();
    return entries.map(({ command, active, queueNumber }) => {
      const visibleTarget =
        command.type === 'attack'
          ? view.visibleEnemies.find((enemy) => enemy.id === command.targetId)
          : undefined;
      const point =
        command.type === 'move'
          ? { x: command.x, y: command.y }
          : visibleTarget?.pos ?? command.lastKnownPosition;
      const baseKey =
        command.type === 'move'
          ? `move:${command.x.toFixed(2)}:${command.y.toFixed(2)}`
          : `attack:${command.targetId}`;
      const occurrence = occurrences.get(baseKey) ?? 0;
      occurrences.set(baseKey, occurrence + 1);

      return {
        key: `${baseKey}:${occurrence}`,
        kind: command.type,
        point: { ...point },
        hidden: command.type === 'attack' && visibleTarget === undefined,
        active,
        queueNumber,
      };
    });
  }

  private updateFadingCommandMarkers(markers: CommandMarkerSnapshot[], time: number) {
    const currentKeys = new Set(markers.map((marker) => marker.key));
    for (const previous of this.previousCommandMarkers.values()) {
      if (currentKeys.has(previous.key)) continue;
      this.fadingCommandMarkers.push({
        kind: previous.kind,
        point: { ...previous.point },
        hidden: previous.hidden,
        active: previous.active,
        startedAt: time,
        until: time + 180,
      });
    }

    this.fadingCommandMarkers = this.fadingCommandMarkers.filter((marker) => time <= marker.until);
    this.previousCommandMarkers = new Map(
      markers.map((marker) => [marker.key, { ...marker, point: { ...marker.point } }])
    );
  }

  private drawCommandMarker(
    marker: Pick<CommandMarkerSnapshot, 'kind' | 'point' | 'hidden' | 'active'>,
    alphaScale: number
  ) {
    const { point, kind, hidden, active } = marker;
    if (kind === 'move') {
      this.commandGraphics.fillStyle(
        active ? 0x7dd3fc : 0x38bdf8,
        (active ? 0.95 : 0.5) * alphaScale
      );
      this.commandGraphics.fillCircle(point.x, point.y, active ? 8 : 5);
      this.commandGraphics.lineStyle(
        active ? 3 : 2,
        0xe0f2fe,
        (active ? 0.95 : 0.42) * alphaScale
      );
      this.commandGraphics.strokeCircle(point.x, point.y, active ? 12 : 8);
      return;
    }

    const radius = active ? 14 : 10;
    const alpha = (hidden ? (active ? 0.62 : 0.38) : active ? 0.98 : 0.52) * alphaScale;
    this.commandGraphics.lineStyle(
      active ? 3 : 2,
      active ? 0xfdba74 : 0xfb923c,
      alpha
    );
    this.commandGraphics.strokeCircle(point.x, point.y, radius);
    this.commandGraphics.beginPath();
    if (hidden) {
      const gap = 4;
      this.commandGraphics.moveTo(point.x - radius - 4, point.y);
      this.commandGraphics.lineTo(point.x - gap, point.y);
      this.commandGraphics.moveTo(point.x + gap, point.y);
      this.commandGraphics.lineTo(point.x + radius + 4, point.y);
      this.commandGraphics.moveTo(point.x, point.y - radius - 4);
      this.commandGraphics.lineTo(point.x, point.y - gap);
      this.commandGraphics.moveTo(point.x, point.y + gap);
      this.commandGraphics.lineTo(point.x, point.y + radius + 4);
    } else {
      this.commandGraphics.moveTo(point.x - radius - 4, point.y);
      this.commandGraphics.lineTo(point.x + radius + 4, point.y);
      this.commandGraphics.moveTo(point.x, point.y - radius - 4);
      this.commandGraphics.lineTo(point.x, point.y + radius + 4);
    }
    this.commandGraphics.strokePath();
    if (hidden) {
      this.commandGraphics.fillStyle(0xfb923c, 0.55 * alphaScale);
      this.commandGraphics.fillCircle(point.x, point.y, 2.5);
    }
  }

  private positionCommandLabel(index: number, marker: CommandMarkerSnapshot) {
    const label = this.ensureCommandLabel(index);
    label.setText(marker.active ? '▶' : String(marker.queueNumber ?? ''));
    label.setColor(marker.kind === 'move' ? '#e0f2fe' : '#ffedd5');
    label.setAlpha(marker.active ? 1 : 0.8);
    const offset = marker.kind === 'move' ? 15 : marker.active ? 19 : 15;
    label.setPosition(marker.point.x + offset, marker.point.y - offset);
    label.setVisible(true);
  }

  private ensureCommandLabel(index: number): Phaser.GameObjects.Text {
    while (this.commandLabelTexts.length <= index) {
      const label = this.add
        .text(0, 0, '', {
          color: '#ffffff',
          fontSize: '11px',
          fontFamily: 'monospace',
          fontStyle: 'bold',
          backgroundColor: '#0f172a',
          padding: { x: 3, y: 1 },
        })
        .setOrigin(0.5)
        .setDepth(58)
        .setVisible(false);
      this.commandLabelTexts.push(label);
    }
    return this.commandLabelTexts[index];
  }

  private reconcileTapFeedback(view: Snapshot, time: number) {
    const commands = [
      ...(view.commands.active === null ? [] : [view.commands.active]),
      ...view.commands.queue,
    ];

    for (const feedback of this.tapFeedbacks) {
      if (feedback.kind === 'invalid' || feedback.confirmedAt !== null) continue;
      const confirmed = commands.some((command) => {
        if (feedback.kind === 'attack') {
          return command.type === 'attack' && command.targetId === feedback.targetId;
        }
        return (
          command.type === 'move' &&
          Math.hypot(command.x - feedback.point.x, command.y - feedback.point.y) <= 1
        );
      });
      if (confirmed) {
        feedback.confirmedAt = time;
        feedback.until = Math.min(feedback.until, time + 140);
      }
    }
  }

  private drawTapFeedback(time: number) {
    this.tapFeedbackGraphics.clear();
    this.tapFeedbacks = this.tapFeedbacks.filter((feedback) => time <= feedback.until);

    for (const feedback of this.tapFeedbacks) {
      const life = Math.max(1, feedback.until - feedback.startedAt);
      const remaining = Math.max(0, feedback.until - time) / life;
      const confirmed = feedback.confirmedAt !== null;
      const radius = confirmed ? 10 + (1 - remaining) * 4 : 9 + (1 - remaining) * 7;
      const color =
        feedback.kind === 'attack' ? 0xfb923c : feedback.kind === 'invalid' ? 0xf87171 : 0x38bdf8;
      this.tapFeedbackGraphics.lineStyle(confirmed ? 3 : 2, color, 0.25 + remaining * 0.7);
      this.tapFeedbackGraphics.strokeCircle(feedback.point.x, feedback.point.y, radius);
      if (confirmed && feedback.kind !== 'invalid') {
        this.tapFeedbackGraphics.fillStyle(color, 0.35 + remaining * 0.45);
        this.tapFeedbackGraphics.fillCircle(feedback.point.x, feedback.point.y, 3);
      }
      if (feedback.kind !== 'move') {
        this.tapFeedbackGraphics.beginPath();
        this.tapFeedbackGraphics.moveTo(feedback.point.x - radius, feedback.point.y);
        this.tapFeedbackGraphics.lineTo(feedback.point.x + radius, feedback.point.y);
        this.tapFeedbackGraphics.moveTo(feedback.point.x, feedback.point.y - radius);
        this.tapFeedbackGraphics.lineTo(feedback.point.x, feedback.point.y + radius);
        this.tapFeedbackGraphics.strokePath();
      }
    }
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
      (camera.width / Math.max(0.001, camera.zoom)) * scale,
      (camera.height / Math.max(0.001, camera.zoom)) * scale
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
        `orders=${view.commands.active?.type ?? 'none'}+${view.commands.queue.length}`,
        `score RED ${view.scores.red} — ${view.scores.blue} BLUE${
          view.carrierIds.red === self.id || view.carrierIds.blue === self.id
            ? '  [CARRYING FLAG]'
            : ''
        }`,
      ].join('\n')
    );

    this.updateOrderText(view);
    this.refreshQueueButton();
    this.updateCampText(view);
  }

  private updateOrderText(view: Snapshot) {
    if (!view.self.alive) {
      this.orderText.setText('ORDER  RESPAWNING');
      this.orderText.setColor('#cbd5e1');
      return;
    }

    const active = view.commands.active;
    let primary = 'ORDER  IDLE';
    let color = '#cbd5e1';
    if (active?.type === 'move') {
      primary = 'ORDER  ▶ MOVE';
      color = '#e0f2fe';
    } else if (active?.type === 'attack') {
      const visible = view.visibleEnemies.find((enemy) => enemy.id === active.targetId);
      primary =
        visible === undefined
          ? 'ORDER  ▶ ATTACK LAST SEEN'
          : `ORDER  ▶ ATTACK ${visible.label}`;
      color = '#ffedd5';
    }

    const secondary: string[] = [];
    if (view.commands.queue.length > 0) secondary.push(`NEXT ${view.commands.queue.length}`);
    if (this.queueEnabled) secondary.push('QUEUE MODE ON');
    this.orderText.setText(
      secondary.length > 0 ? `${primary}\n${secondary.join('  •  ')}` : primary
    );
    this.orderText.setColor(color);
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

  private showConnectionOverlay(status: SessionConnectionStatus) {
    if (
      status.state !== 'stale' &&
      status.state !== 'closed' &&
      status.state !== 'error'
    ) {
      return;
    }

    if (this.connectionOverlay === null) {
      const blocker = this.add
        .rectangle(
          GAME_CONFIG.viewportWidth / 2,
          GAME_CONFIG.viewportHeight / 2,
          GAME_CONFIG.viewportWidth,
          GAME_CONFIG.viewportHeight,
          0x000000,
          0.78
        )
        .setInteractive();

      const headline = this.add
        .text(GAME_CONFIG.viewportWidth / 2, GAME_CONFIG.viewportHeight / 2 - 76, '', {
          color: '#f8fafc',
          fontSize: '30px',
          fontFamily: 'system-ui, sans-serif',
        })
        .setOrigin(0.5);

      const detail = this.add
        .text(GAME_CONFIG.viewportWidth / 2, GAME_CONFIG.viewportHeight / 2 - 26, '', {
          color: '#cbd5e1',
          fontSize: '13px',
          fontFamily: 'system-ui, sans-serif',
          align: 'center',
          wordWrap: { width: 380 },
        })
        .setOrigin(0.5);

      const retryBg = this.add
        .rectangle(GAME_CONFIG.viewportWidth / 2 - 82, GAME_CONFIG.viewportHeight / 2 + 46, 140, 42, 0x164e63)
        .setStrokeStyle(2, 0x38bdf8, 0.9)
        .setInteractive({ useHandCursor: true });
      const retryText = this.add
        .text(GAME_CONFIG.viewportWidth / 2 - 82, GAME_CONFIG.viewportHeight / 2 + 46, 'PLAY AGAIN', {
          color: '#e0f2fe',
          fontSize: '14px',
          fontFamily: 'system-ui, sans-serif',
        })
        .setOrigin(0.5);

      const menuBg = this.add
        .rectangle(GAME_CONFIG.viewportWidth / 2 + 82, GAME_CONFIG.viewportHeight / 2 + 46, 140, 42, 0x1f2937)
        .setStrokeStyle(2, 0x64748b, 0.9)
        .setInteractive({ useHandCursor: true });
      const menuText = this.add
        .text(GAME_CONFIG.viewportWidth / 2 + 82, GAME_CONFIG.viewportHeight / 2 + 46, 'MENU', {
          color: '#e2e8f0',
          fontSize: '14px',
          fontFamily: 'system-ui, sans-serif',
        })
        .setOrigin(0.5);

      retryBg.on(
        'pointerdown',
        (
          _pointer: Phaser.Input.Pointer,
          _localX: number,
          _localY: number,
          event: { stopPropagation(): void }
        ) => {
          event.stopPropagation();
          void this.retryOnlineMatch();
        }
      );
      menuBg.on(
        'pointerdown',
        (
          _pointer: Phaser.Input.Pointer,
          _localX: number,
          _localY: number,
          event: { stopPropagation(): void }
        ) => {
          event.stopPropagation();
          if (this.connectionRetryBusy) return;
          this.scene.start('MenuScene');
        }
      );

      this.connectionOverlay = this.add
        .container(0, 0, [blocker, headline, detail, retryBg, retryText, menuBg, menuText])
        .setDepth(300)
        .setScrollFactor(0);
      this.connectionHeadlineText = headline;
      this.connectionDetailText = detail;
    }

    let headline = 'CONNECTION INTERRUPTED';
    let detail = '';
    if (status.state === 'stale') {
      const seconds = Math.max(3, Math.floor(status.staleForMs / 1000));
      detail = `No game updates for ${seconds}s. Waiting for the server…`;
    } else if (status.state === 'error') {
      headline = 'GAME SERVER ERROR';
      detail = `${status.message} (code ${status.code})`;
    } else {
      headline = status.expected ? 'MATCH ENDED' : 'CONNECTION LOST';
      detail = `${status.message} (close code ${status.code})`;
    }

    this.connectionHeadlineText?.setText(headline);
    this.connectionDetailText?.setText(
      this.connectionRetryBusy
        ? 'Connecting to a new match…'
        : this.connectionRetryError ?? detail
    );
  }

  private clearConnectionOverlay() {
    if (this.connectionOverlay === null) return;
    this.connectionOverlay.destroy(true);
    this.connectionOverlay = null;
    this.connectionHeadlineText = null;
    this.connectionDetailText = null;
    this.connectionRetryError = null;
  }

  private async retryOnlineMatch() {
    if (this.session.mode !== 'online' || this.connectionRetryBusy) return;
    this.connectionRetryBusy = true;
    this.connectionRetryError = null;
    this.connectionDetailText?.setText('Connecting to a new match…');
    this.session.dispose();

    try {
      const session = await OnlineSession.create(
        DEFAULT_LOBBY,
        DEFAULT_SERVER,
        this.savedOnlineName()
      );
      this.scene.restart({ session });
    } catch (error) {
      this.connectionRetryBusy = false;
      const message = error instanceof Error ? error.message : 'Could not join a new match.';
      this.connectionRetryError = `Retry failed: ${message}`;
      this.connectionDetailText?.setText(this.connectionRetryError.slice(0, 160));
      console.error('[locks] retry failed', error);
    }
  }

  private savedOnlineName(): string {
    try {
      const saved = localStorage.getItem('locks.name')?.trim();
      if (saved) return saved.slice(0, 16);
    } catch {
      /* ignore */
    }
    return `Guest${Math.floor(Math.random() * 900 + 100)}`;
  }

  private showMatchEnd(view: Snapshot) {
    this.matchEndShown = true;
    this.disableQueue();
    this.cancelPointerGestures();
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
