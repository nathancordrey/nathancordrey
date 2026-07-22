import type Phaser from 'phaser';

import type { Vec2 } from './shared/geometry';

export type CameraMode = 'follow' | 'free';

type CameraControllerOptions = {
  worldWidth: number;
  worldHeight: number;
  deadzoneWidthFraction?: number;
  deadzoneHeightFraction?: number;
  followLerp?: number;
};

/**
 * Owns the two intentional camera states used by waypoint controls:
 * soft follow until the player pans, then free camera until explicit recenter.
 */
export class CameraController {
  private readonly camera: Phaser.Cameras.Scene2D.Camera;
  private readonly target: Phaser.GameObjects.Rectangle;
  private readonly worldWidth: number;
  private readonly worldHeight: number;
  private readonly deadzoneWidthFraction: number;
  private readonly deadzoneHeightFraction: number;
  private readonly followLerp: number;
  private currentMode: CameraMode = 'follow';
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
    this.deadzoneWidthFraction = options.deadzoneWidthFraction ?? 0.46;
    this.deadzoneHeightFraction = options.deadzoneHeightFraction ?? 0.44;
    this.followLerp = options.followLerp ?? 0.14;

    this.camera.setBounds(0, 0, this.worldWidth, this.worldHeight);
    this.applyDeadzone();
  }

  mode(): CameraMode {
    return this.currentMode;
  }

  setTarget(point: Vec2): void {
    this.target.setPosition(point.x, point.y);
  }

  /** Start follow mode and optionally snap to the player immediately. */
  recenter(point?: Vec2, immediate = true): void {
    if (point !== undefined) this.setTarget(point);
    this.camera.stopFollow();
    this.applyDeadzone();
    if (immediate) this.camera.centerOn(this.target.x, this.target.y);
    this.camera.startFollow(this.target, true, this.followLerp, this.followLerp);
    this.currentMode = 'follow';
    this.followingStarted = true;
  }

  /** Pan in screen-space pixels. Dragging right reveals world space to the left. */
  panBy(screenDeltaX: number, screenDeltaY: number): boolean {
    const becameFree = this.currentMode !== 'free';
    if (becameFree) {
      this.camera.stopFollow();
      this.currentMode = 'free';
    }

    const zoom = Math.max(0.001, this.camera.zoom);
    this.setClampedScroll(
      this.camera.scrollX - screenDeltaX / zoom,
      this.camera.scrollY - screenDeltaY / zoom
    );
    return becameFree;
  }

  handleResize(): void {
    this.camera.setBounds(0, 0, this.worldWidth, this.worldHeight);
    this.applyDeadzone();
    if (this.currentMode === 'free') {
      this.setClampedScroll(this.camera.scrollX, this.camera.scrollY);
    } else if (this.followingStarted) {
      // Re-applying follow keeps Phaser's deadzone and bounds coherent after
      // orientation or parent-size changes without moving the world target.
      this.camera.stopFollow();
      this.camera.startFollow(this.target, true, this.followLerp, this.followLerp);
    }
  }

  private applyDeadzone(): void {
    this.camera.setDeadzone(
      this.camera.width * this.deadzoneWidthFraction,
      this.camera.height * this.deadzoneHeightFraction
    );
  }

  private setClampedScroll(scrollX: number, scrollY: number): void {
    const zoom = Math.max(0.001, this.camera.zoom);
    const visibleWidth = this.camera.width / zoom;
    const visibleHeight = this.camera.height / zoom;
    const maxX = Math.max(0, this.worldWidth - visibleWidth);
    const maxY = Math.max(0, this.worldHeight - visibleHeight);
    this.camera.setScroll(
      Math.max(0, Math.min(maxX, scrollX)),
      Math.max(0, Math.min(maxY, scrollY))
    );
  }
}
