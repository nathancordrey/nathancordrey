import Phaser from 'phaser';

const GAME_CONFIG = {
  playerSpeed: 180,
  playerRadius: 14,
};

type Wall = {
  rect: Phaser.GameObjects.Rectangle;
  bounds: Phaser.Geom.Rectangle;
};

class GameScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Arc;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private walls: Wall[] = [];
  private debugText!: Phaser.GameObjects.Text;

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

    this.add.text(24, 58, 'WASD or arrows to move', {
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
    this.cursors = this.input.keyboard!.createCursorKeys();

    this.keys = this.input.keyboard!.addKeys({
      w: Phaser.Input.Keyboard.KeyCodes.W,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<string, Phaser.Input.Keyboard.Key>;
  }

  update(_time: number, delta: number) {
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

    this.debugText.setText(
      `x=${this.player.x.toFixed(0)} y=${this.player.y.toFixed(0)}`
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
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 960,
  height: 640,
  parent: 'app',
  scene: GameScene,
};

new Phaser.Game(config);
