// WebSocket messages are ordered, but this guard prevents any stale/duplicate
// transport or reconnect artifact from rolling the rendered state backward.
export function shouldAcceptSnapshotTick(
  currentTick: number | null,
  nextTick: number
): boolean {
  return Number.isFinite(nextTick) && (currentTick === null || nextTick > currentTick);
}
