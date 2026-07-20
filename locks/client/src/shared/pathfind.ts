  // A* pathfinding for bot travel (getting to a flag, returning home). Pure and
// deterministic: the grid is static (only walls block, and walls never move),
// tie-breaking is fixed, no Math.random(). Combat chase still uses straight-
// line lock tracking — this is only for crossing the map around obstacles.

import type { Vec2 } from './geometry';
import { TILE, MAP } from './config';
import type { WallDef } from './config';

const COLS = 64;
const ROWS = 64;

// A cell is blocked if any wall (hard OR soft) overlaps it, then blocked cells
// are inflated by one so a unit hugging a corner doesn't clip it. Bots route
// around soft cover for movement even though shots pass through it.
function buildBlockedGrid(walls: WallDef[]): boolean[][] {
  const raw: boolean[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => false)
  );

  for (const wall of walls) {
    const minCol = Math.max(0, Math.floor(wall.rect.left / TILE));
    const maxCol = Math.min(COLS - 1, Math.floor((wall.rect.right - 1e-6) / TILE));
    const minRow = Math.max(0, Math.floor(wall.rect.top / TILE));
    const maxRow = Math.min(ROWS - 1, Math.floor((wall.rect.bottom - 1e-6) / TILE));
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) raw[row][col] = true;
    }
  }

  // Inflate by one cell (Chebyshev) for player-radius clearance.
  const inflated: boolean[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => false)
  );
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!raw[row][col]) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r >= 0 && r < ROWS && c >= 0 && c < COLS) inflated[r][c] = true;
        }
      }
    }
  }

  return inflated;
}

// Built once from the map; walls are static so the grid never changes.
const BLOCKED: boolean[][] = buildBlockedGrid(MAP.walls);

export function isCellBlocked(col: number, row: number): boolean {
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return true;
  return BLOCKED[row][col];
}

function worldToCell(pos: Vec2): { col: number; row: number } {
  return {
    col: Math.max(0, Math.min(COLS - 1, Math.floor(pos.x / TILE))),
    row: Math.max(0, Math.min(ROWS - 1, Math.floor(pos.y / TILE))),
  };
}

export function cellCenter(col: number, row: number): Vec2 {
  return { x: (col + 0.5) * TILE, y: (row + 0.5) * TILE };
}

// If a target sits inside an inflated-blocked cell (e.g. a flag near a wall),
// snap the goal to the nearest free cell so a path can exist.
function nearestFreeCell(col: number, row: number): { col: number; row: number } {
  if (!isCellBlocked(col, row)) return { col, row };
  for (let radius = 1; radius < Math.max(COLS, ROWS); radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
        const c = col + dc;
        const r = row + dr;
        if (!isCellBlocked(c, r)) return { col: c, row: r };
      }
    }
  }
  return { col, row };
}

const NEIGHBORS: Array<{ dc: number; dr: number; cost: number }> = [
  { dc: 1, dr: 0, cost: 1 },
  { dc: -1, dr: 0, cost: 1 },
  { dc: 0, dr: 1, cost: 1 },
  { dc: 0, dr: -1, cost: 1 },
  { dc: 1, dr: 1, cost: Math.SQRT2 },
  { dc: 1, dr: -1, cost: Math.SQRT2 },
  { dc: -1, dr: 1, cost: Math.SQRT2 },
  { dc: -1, dr: -1, cost: Math.SQRT2 },
];

function octileHeuristic(c0: number, r0: number, c1: number, r1: number): number {
  const dc = Math.abs(c0 - c1);
  const dr = Math.abs(r0 - r1);
  return Math.max(dc, dr) + (Math.SQRT2 - 1) * Math.min(dc, dr);
}

// Returns a list of world-space waypoints (cell centers) from start to goal,
// excluding the start cell, or null if no path exists. Deterministic:
// neighbor order is fixed and ties never consult a random source.
export function findPath(start: Vec2, goal: Vec2): Vec2[] | null {
  const startCell = worldToCell(start);
  const goalRaw = worldToCell(goal);
  const goalCell = nearestFreeCell(goalRaw.col, goalRaw.row);

  const startKey = startCell.row * COLS + startCell.col;
  const goalKey = goalCell.row * COLS + goalCell.col;
  if (startKey === goalKey) return [];

  const gScore = new Map<number, number>();
  const fScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const open = new Set<number>();

  gScore.set(startKey, 0);
  fScore.set(startKey, octileHeuristic(startCell.col, startCell.row, goalCell.col, goalCell.row));
  open.add(startKey);

  while (open.size > 0) {
    // Pick the open node with the lowest f, ties broken by lowest key (fixed).
    let current = -1;
    let best = Infinity;
    for (const key of open) {
      const f = fScore.get(key) ?? Infinity;
      if (f < best || (f === best && key < current)) {
        best = f;
        current = key;
      }
    }

    if (current === goalKey) return reconstruct(cameFrom, current);

    open.delete(current);
    const col = current % COLS;
    const row = Math.floor(current / COLS);

    for (const step of NEIGHBORS) {
      const nc = col + step.dc;
      const nr = row + step.dr;
      if (isCellBlocked(nc, nr)) continue;

      // No corner-cutting: a diagonal step requires both orthogonal cells free.
      if (step.dc !== 0 && step.dr !== 0) {
        if (isCellBlocked(col + step.dc, row) || isCellBlocked(col, row + step.dr)) continue;
      }

      const neighborKey = nr * COLS + nc;
      const tentative = (gScore.get(current) ?? Infinity) + step.cost;
      if (tentative < (gScore.get(neighborKey) ?? Infinity)) {
        cameFrom.set(neighborKey, current);
        gScore.set(neighborKey, tentative);
        fScore.set(neighborKey, tentative + octileHeuristic(nc, nr, goalCell.col, goalCell.row));
        open.add(neighborKey);
      }
    }
  }

  return null;
}

function reconstruct(cameFrom: Map<number, number>, current: number): Vec2[] {
  const cells: number[] = [current];
  let node = current;
  while (cameFrom.has(node)) {
    node = cameFrom.get(node)!;
    cells.push(node);
  }
  cells.reverse();
  // Drop the start cell; return centers of the rest as travel waypoints.
  return cells.slice(1).map((key) => cellCenter(key % COLS, Math.floor(key / COLS)));
}
