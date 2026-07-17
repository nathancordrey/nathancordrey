import './style.css';
import Phaser from 'phaser';

const GAME_CONFIG = {
  worldWidth: 960,
  worldHeight: 640,

  playerSpeed: 180,
  playerRadius: 14,
  playerSpawnX: 140,
  playerSpawnY: 320,

  shotCooldownMs: 600,
  shotRange: 900,

  targetRadius: 13,
  targetRespawnMs: 2000,

  flagVisionRadius: 325,
  ownFlagCampRadius: 375,
  campGraceMs: 10_000,
  campWarningMs: 3_000,
  campResetMs: 4_000,
  respawnTimeMs: 2_500,

  mobileJoystickMaxDistance: 60,
};

type Team = 'red' | 'blue';

type Point = {
  x: number;
  y: number;
};

type Wall = {
  rect: Phaser.GameObjects.Rectangle;
  bounds: Phaser.Geom.Rectangle;
};

type Target = {
  body: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  x: number;
  y: number;
  radius: number;
  alive: boolean;
};

type FlagZone = {
  team: Team;
  x: number;
  y: number;
  visionRadius: number;
  campRadius: number;
};

class GameScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Arc;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;

  private walls: Wall[] = [];
  private targets: Target[] = [];
  private flagZones: FlagZone[] = [];

  private debugText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private campText!: Phaser.GameObjects.Text;

  private aimGraphics!: Phaser.GameObjects.Graphics;
  private shotGraphics!: Phaser.GameObjects.Graphics;
  private mobileControlGraphics!: Phaser.GameObjects.Graphics;

  private playerTeam: Team = 'red';
  private playerAlive = true;
  private respawnAt = 0;

  private ownFlagCampStartedAt: number | null = null;
  private ownFlagExitedAt: number | null = null;

  private lastShotAt = -Infinity;
  private shotVisibleUntil = 0;
  private activeShot: { start: Point; end: Point } | null = null;
  private hitCount = 0;

  private mobileMovePointerId: number | null = null;
  private mobileMoveOrigin: Point | null = null;
  private mobileMoveCurrent: Point | null = null;
  private mobileMoveVector: Point = { x: 0, y: 0 };

  constructor() {
    super('GameScene');
  }

  create() {
    this.cameras.main.setBackgroundColor('#111827');

    this.add.text(24, 24, 'Sniper Locks prototype', {
      color: '#ffffff',
      fontSize: '24px',
      fontFamily: 'system-ui, sans-serif',
    });

    this.add.text(24, 58, 'Desktop: WASD/arrows + mouse • Phone: left drag + right tap', {
      color: '#cbd5e1',
      fontSize: '16px',
      fontFamily: 'system-ui, sans-serif',
    });

    this.debugText = this.add.text(24, 88, '', {
      color: '#94a3b8',
      fontSize: '14px',
      fontFamily: 'monospace',
    });

    this.statusText = this.add.text(24, 150, '', {
      color: '#fef3c7',
      fontSize: '16px',
      fontFamily: 'system-ui, sans-serif',
    });

    this.campText = this.add.text(24, 176, '', {
      color: '#fecaca',
      fontSize: '16px',
      fontFamily: 'system-ui, sans-serif',
    });

    this.createArena();

    this.player = this.add.circle(
      GAME_CONFIG.playerSpawnX,
      GAME_CONFIG.playerSpawnY,
      GAME_CONFIG.playerRadius,
      0x38bdf8
    );

    this.aimGraphics = this.add.graphics();
    this.shotGraphics = this.add.graphics();
    this.mobileControlGraphics = this.add.graphics();

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

    if (!this.playerAlive) {
      this.mobileMoveVector = { x: 0, y: 0 };

      if (time >= this.respawnAt) {
        this.respawnPlayer();
      }

      this.aimGraphics.clear();
      this.drawActiveShot(time);
      this.drawMobileControls();
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

      const moveX = dx * GAME_CONFIG.playerSpeed * dt;
      const moveY = dy * GAME_CONFIG.playerSpeed * dt;

      this.movePlayer(moveX, 0);
      this.movePlayer(0, moveY);
    }

    this.drawAimLine();
    this.drawActiveShot(time);
    this.drawMobileControls();
    this.updateCampTimer(time);

    const cooldownRemaining = Math.max(
      0,
      GAME_CONFIG.shotCooldownMs - (time - this.lastShotAt)
    );

    const aliveTargets = this.targets.filter((target) => target.alive).length;

    this.debugText.setText(
      [
        `x=${this.player.x.toFixed(0)} y=${this.player.y.toFixed(0)}`,
        `shot cooldown=${cooldownRemaining.toFixed(0)}ms`,
        `targets alive=${aliveTargets}/${this.targets.length}`,
        `hits=${this.hitCount}`,
        `mobile move=${this.mobileMoveVector.x.toFixed(2)}, ${this.mobileMoveVector.y.toFixed(2)}`,
      ].join('\n')
    );
  }

  private createArena() {
    this.addWall(480, 90, 760, 24);
    this.addWall(480, 550, 760, 24);
    this.addWall(90, 320, 24, 460);
    this.addWall(870, 320, 24, 460);

    this.addWall(350, 245, 180, 28);
    this.addWall(610, 395, 180, 28);
    this.addWall(480, 320, 32, 160);

    this.addFlagZone('red', 160, 320, 0xef4444);
    this.addFlagZone('blue', 800, 320, 0x3b82f6);

    this.addTarget(720, 250, 'T1');
    this.addTarget(720, 320, 'T2');
    this.addTarget(720, 390, 'T3');
  }

  private addWall(x: number, y: number, width: number, height: number) {
    const rect = this.add.rectangle(x, y, width, height, 0x475569);
    const bounds = rect.getBounds();

    this.walls.push({ rect, bounds });
  }

  private addTarget(x: number, y: number, labelText: string) {
    const body = this.add.circle(x, y, GAME_CONFIG.targetRadius, 0xf97316);
    body.setStrokeStyle(2, 0xffedd5, 0.9);

    const label = this.add.text(x - 9, y - 32, labelText, {
      color: '#fed7aa',
      fontSize: '13px',
      fontFamily: 'monospace',
    });

    this.targets.push({
      body,
      label,
      x,
      y,
      radius: GAME_CONFIG.targetRadius,
      alive: true,
    });
  }

  private addFlagZone(team: Team, x: number, y: number, color: number) {
    this.flagZones.push({
      team,
      x,
      y,
      visionRadius: GAME_CONFIG.flagVisionRadius,
      campRadius: GAME_CONFIG.ownFlagCampRadius,
    });

    this.add.circle(x, y, GAME_CONFIG.flagVisionRadius, color, 0.08);

    const visionRing = this.add.circle(x, y, GAME_CONFIG.flagVisionRadius);
    visionRing.setStrokeStyle(2, color, 0.22);

    if (team === this.playerTeam) {
      const campRing = this.add.circle(x, y, GAME_CONFIG.ownFlagCampRadius);
      campRing.setStrokeStyle(2, 0xfca5a5, 0.32);
    }

    this.add.circle(x, y, 28, color, 0.35);
    this.add.circle(x, y, 8, color, 0.9);

    this.add.text(x - 24, y + 34, team.toUpperCase(), {
      color: team === 'red' ? '#fecaca' : '#bfdbfe',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
    });
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer) {
    const pointerEvent = pointer.event as Event & { pointerType?: string };
    const isTouch =
      (pointer as unknown as { wasTouch?: boolean }).wasTouch === true ||
      pointerEvent.pointerType === 'touch';

    const isLeftHalf = pointer.worldX < GAME_CONFIG.worldWidth / 2;

    if (isTouch && isLeftHalf) {
      this.mobileMovePointerId = pointer.id;
      this.mobileMoveOrigin = { x: pointer.worldX, y: pointer.worldY };
      this.mobileMoveCurrent = { x: pointer.worldX, y: pointer.worldY };
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

    this.mobileMoveCurrent = { x: pointer.worldX, y: pointer.worldY };
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

    const rawDx = pointer.worldX - this.mobileMoveOrigin.x;
    const rawDy = pointer.worldY - this.mobileMoveOrigin.y;
    const distance = Math.hypot(rawDx, rawDy);

    if (distance < 6) {
      this.mobileMoveVector = { x: 0, y: 0 };
      return;
    }

    const clampedDistance = Math.min(distance, GAME_CONFIG.mobileJoystickMaxDistance);
    const strength = clampedDistance / GAME_CONFIG.mobileJoystickMaxDistance;

    this.mobileMoveVector = {
      x: (rawDx / distance) * strength,
      y: (rawDy / distance) * strength,
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

  private movePlayer(dx: number, dy: number) {
    const nextX = this.player.x + dx;
    const nextY = this.player.y + dy;

    if (!this.collidesWithWall(nextX, nextY)) {
      this.player.x = nextX;
      this.player.y = nextY;
    }
  }

  private collidesWithWall(x: number, y: number) {
    return this.walls.some((wall) =>
      Phaser.Geom.Intersects.CircleToRectangle(
        new Phaser.Geom.Circle(x, y, GAME_CONFIG.playerRadius),
        wall.bounds
      )
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

  private tryShoot(time: number, aimPoint: Point) {
    if (!this.playerAlive) {
      return;
    }

    if (time - this.lastShotAt < GAME_CONFIG.shotCooldownMs) {
      return;
    }

    this.lastShotAt = time;

    const angle = Phaser.Math.Angle.Between(
      this.player.x,
      this.player.y,
      aimPoint.x,
      aimPoint.y
    );

    const start = {
      x: this.player.x,
      y: this.player.y,
    };

    const maxEnd = {
      x: this.player.x + Math.cos(angle) * GAME_CONFIG.shotRange,
      y: this.player.y + Math.sin(angle) * GAME_CONFIG.shotRange,
    };

    const wallHit = this.findNearestWallHit(start, maxEnd);
    const blockedEnd = wallHit ?? maxEnd;

    const targetHit = this.findNearestTargetHit(start, blockedEnd);
    const end = targetHit?.point ?? blockedEnd;

    if (targetHit) {
      this.killTarget(targetHit.target);
    } else {
      this.statusText.setText('MISS');
      this.time.delayedCall(500, () => this.statusText.setText(''));
    }

    this.activeShot = { start, end };
    this.shotVisibleUntil = time + 120;
  }

  private killTarget(target: Target) {
    target.alive = false;
    target.body.setVisible(false);
    target.label.setVisible(false);
    this.hitCount += 1;

    this.statusText.setText('HIT');

    const hitText = this.add.text(target.x - 16, target.y - 8, 'HIT', {
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
      target.alive = true;
      target.body.setVisible(true);
      target.label.setVisible(true);
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

    this.statusText.setText(`${reason} — respawning...`);
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

    const ownFlag = this.flagZones.find((flag) => flag.team === this.playerTeam);

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

  private findNearestWallHit(start: Point, end: Point): Point | null {
    let nearest: { point: Point; t: number } | null = null;

    for (const wall of this.walls) {
      const edges = this.getRectangleEdges(wall.bounds);

      for (const edge of edges) {
        const hit = this.getSegmentIntersection(start, end, edge.start, edge.end);

        if (!hit) continue;

        if (!nearest || hit.t < nearest.t) {
          nearest = {
            point: hit.point,
            t: hit.t,
          };
        }
      }
    }

    return nearest?.point ?? null;
  }

  private findNearestTargetHit(
    start: Point,
    end: Point
  ): { target: Target; point: Point; t: number } | null {
    let nearest: { target: Target; point: Point; t: number } | null = null;

    for (const target of this.targets) {
      if (!target.alive) continue;

      const hit = this.getSegmentCircleIntersection(
        start,
        end,
        { x: target.body.x, y: target.body.y },
        target.radius
      );

      if (!hit) continue;

      if (!nearest || hit.t < nearest.t) {
        nearest = {
          target,
          point: hit.point,
          t: hit.t,
        };
      }
    }

    return nearest;
  }

  private getRectangleEdges(rect: Phaser.Geom.Rectangle) {
    const left = rect.left;
    const right = rect.right;
    const top = rect.top;
    const bottom = rect.bottom;

    return [
      { start: { x: left, y: top }, end: { x: right, y: top } },
      { start: { x: right, y: top }, end: { x: right, y: bottom } },
      { start: { x: right, y: bottom }, end: { x: left, y: bottom } },
      { start: { x: left, y: bottom }, end: { x: left, y: top } },
    ];
  }

  private getSegmentIntersection(
    a: Point,
    b: Point,
    c: Point,
    d: Point
  ): { point: Point; t: number } | null {
    const rX = b.x - a.x;
    const rY = b.y - a.y;
    const sX = d.x - c.x;
    const sY = d.y - c.y;

    const denominator = rX * sY - rY * sX;

    if (Math.abs(denominator) < 0.000001) {
      return null;
    }

    const cMinusAX = c.x - a.x;
    const cMinusAY = c.y - a.y;

    const t = (cMinusAX * sY - cMinusAY * sX) / denominator;
    const u = (cMinusAX * rY - cMinusAY * rX) / denominator;

    if (t < 0 || t > 1 || u < 0 || u > 1) {
      return null;
    }

    return {
      point: {
        x: a.x + t * rX,
        y: a.y + t * rY,
      },
      t,
    };
  }

  private getSegmentCircleIntersection(
    start: Point,
    end: Point,
    center: Point,
    radius: number
  ): { point: Point; t: number } | null {
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    const fx = start.x - center.x;
    const fy = start.y - center.y;

    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - radius * radius;

    const discriminant = b * b - 4 * a * c;

    if (discriminant < 0) {
      return null;
    }

    const sqrtDiscriminant = Math.sqrt(discriminant);

    const t1 = (-b - sqrtDiscriminant) / (2 * a);
    const t2 = (-b + sqrtDiscriminant) / (2 * a);

    const t = [t1, t2].find((value) => value >= 0 && value <= 1);

    if (t === undefined) {
      return null;
    }

    return {
      point: {
        x: start.x + dx * t,
        y: start.y + dy * t,
      },
      t,
    };
  }
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: GAME_CONFIG.worldWidth,
  height: GAME_CONFIG.worldHeight,
  parent: 'app',
  backgroundColor: '#111827',
  scene: GameScene,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: GAME_CONFIG.worldWidth,
    height: GAME_CONFIG.worldHeight,
  },
};

new Phaser.Game(config);
