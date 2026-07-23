import type Phaser from 'phaser';

import type { Vec2 } from './shared/geometry';

type CameraControllerOptions = {
  worldWidth: number;
  worldHeight: number;
  followLerp?: number;
};

/**
 * Owns the single production camera mode: a smooth, always-on follow of the
 * local player's interpolated render position.
 */
export class CameraController {
  private readonly camera: Phaser.Cameras.Scene2D.Camera;
  private readonly target: Phaser.GameObjects.Rectangle;
  private readonly worldWidth: number;
  private readonly worldHeight: number;
  private readonly followLerp: number;
  private followingStarted = false;

  constructor(
    camera: Phaser.Cameras.Scene2D.Camera,
    target: Phaser.GameObjects.Rectangle,
    options: CameraControllerOptions
  ) {
    this.camera = camera;
    this.target = target;
    this.worldWidth = options.worldWidth;
    this.worldHeight = options.worldHeight;
    this.followLerp = options.followLerp ?? 0.1;

    this.camera.setBounds(0, 0, this.worldWidth, this.worldHeight);
    // Removing the deadzone avoids the stop/start motion of the previous
    // soft-follow box. The interpolated render target and lerp provide smoothing.
    this.camera.setDeadzone();
  }

  setTarget(point: Vec2): void {
    this.target.setPosition(point.x, point.y);
  }

  /** Begin or restore smooth follow, optionally centering immediately once. */
  recenter(point?: Vec2, immediate = true): void {
    if (point !== undefined) this.setTarget(point);
    this.camera.stopFollow();
    this.camera.setDeadzone();
    if (immediate) this.camera.centerOn(this.target.x, this.target.y);
    // Do not round pixels: the target already uses interpolated render motion,
    // and sub-pixel camera movement is less jittery on scaled mobile canvases.
    this.camera.startFollow(this.target, false, this.followLerp, this.followLerp);
    this.followingStarted = true;
  }

  handleResize(): void {
    this.camera.setBounds(0, 0, this.worldWidth, this.worldHeight);
    this.camera.setDeadzone();
    if (!this.followingStarted) return;

    // Re-applying follow keeps Phaser's bounds coherent after an orientation or
    // parent-size change without introducing a free-camera state.
    this.camera.stopFollow();
    this.camera.startFollow(this.target, false, this.followLerp, this.followLerp);
  }
}
