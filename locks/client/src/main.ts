import Phaser from 'phaser';

const GAME_CONFIG = {
  playerSpeed: 180,
  playerRadius: 14,
  shotCooldownMs: 600,
  shotRange: 900,
};

type Wall = {
  rect: Phaser.GameObjects.Rectangle;
  bounds: Phaser.Geom.Rectangle;
};

type Point = {
  x: number;
  y: number;
};

class GameScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Arc;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private walls: Wall[] = [];
  private debugText!: Phaser.GameObjects.Text;

  private aimGraphics!: Phaser.GameObjects.Graphics;
  private shotGraphics!: Phaser.GameObjects.Graphics;
  private lastShotAt = -Infinity;
  private shotVisibleUntil = 0;
  private activeShot: { start: Point; end: Point } | null = null;

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

    this.add.text(24, 58, 'WASD/arrows to move • Mouse to aim • Click to shoot', {
      color: '#cbd5e1',
      fontSize: '16px',
      fontFamily: 'system-ui, sans-serif',
    });

    this.debugText = this.add.text(24, 88, '', {
      color: '#94a3b8',
      fontSize: '14px',
      fontFamily: 'monospace',
    });

    this.createArena();

    this.player = this.add.circle(140, 320, GAME_CONFIG.playerRadius, 0x38bdf8);

    this.aimGraphics = this.add.graphics();
    this.shotGraphics = this.add.graphics();

    this.cursors = this.input.keyboard!.createCursorKeys();

    this.keys = this.input.keyboard!.addKeys({
      w: Phaser.Input.Keyboard.KeyCodes.W,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<string, Phaser.Input.Keyboard.Key>;

    this.input.on('pointerdown', () => {
      this.tryShoot(this.time.now);
    });
  }

  update(time: number, delta: number) {
    const dt = delta / 1000;

    let dx = 0;
    let dy = 0;

    if (this.cursors.left.isDown || this.keys.a.isDown) dx -= 1;
    if (this.cursors.right.isDown || this.keys.d.isDown) dx += 1;
    if (this.cursors.up.isDown || this.keys.w.isDown) dy -= 1;
    if (this.cursors.down.isDown || this.keys.s.isDown) dy += 1;

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

    const cooldownRemaining = Math.max(
      0,
      GAME_CONFIG.shotCooldownMs - (time - this.lastShotAt)
    );

    this.debugText.setText(
      [
        `x=${this.player.x.toFixed(0)} y=${this.player.y.toFixed(0)}`,
        `shot cooldown=${cooldownRemaining.toFixed(0)}ms`,
      ].join('\n')
    );
  }

  private createArena() {
    // Outer border
    this.addWall(480, 90, 760, 24);
    this.addWall(480, 550, 760, 24);
    this.addWall(90, 320, 24, 460);
    this.addWall(870, 320, 24, 460);

    // Midfield test walls / sightline blockers
    this.addWall(350, 245, 180, 28);
    this.addWall(610, 395, 180, 28);
    this.addWall(480, 320, 32, 160);

    // Rough flag placeholders
    this.add.circle(160, 320, 28, 0xef4444, 0.35);
    this.add.circle(800, 320, 28, 0x3b82f6, 0.35);

    this.add.text(136, 354, 'RED', {
      color: '#fecaca',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
    });

    this.add.text(774, 354, 'BLUE', {
      color: '#bfdbfe',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
    });
  }

  private addWall(x: number, y: number, width: number, height: number) {
    const rect = this.add.rectangle(x, y, width, height, 0x475569);
    const bounds = rect.getBounds();

    this.walls.push({ rect, bounds });
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

    // Tiny facing dot
    this.aimGraphics.fillStyle(0xffffff, 0.7);
    this.aimGraphics.fillCircle(endX, endY, 3);
  }

  private tryShoot(time: number) {
    if (time - this.lastShotAt < GAME_CONFIG.shotCooldownMs) {
      return;
    }

    this.lastShotAt = time;

    const pointer = this.input.activePointer;
    const angle = Phaser.Math.Angle.Between(
      this.player.x,
      this.player.y,
      pointer.worldX,
      pointer.worldY
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
    const end = wallHit ?? maxEnd;

    this.activeShot = { start, end };
    this.shotVisibleUntil = time + 120;
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
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 960,
  height: 640,
  parent: 'app',
  scene: GameScene,
};

new Phaser.Game(config);
