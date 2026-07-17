import Phaser from 'phaser';

class GameScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Arc;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;

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

    this.player = this.add.circle(400, 300, 14, 0x38bdf8);
    this.cursors = this.input.keyboard!.createCursorKeys();

    this.keys = this.input.keyboard!.addKeys({
      w: Phaser.Input.Keyboard.KeyCodes.W,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<string, Phaser.Input.Keyboard.Key>;
  }

  update(_time: number, delta: number) {
    const speed = 180;
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

      this.player.x += dx * speed * dt;
      this.player.y += dy * speed * dt;
    }
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
