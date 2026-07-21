export type LobbyLifecycleEvent =
  | { type: 'room_created'; roomId: string; humanCount: number }
  | { type: 'player_joined'; roomId: string; humanCount: number }
  | { type: 'player_left'; roomId: string; humanCount: number }
  | {
      type: 'match_ended';
      roomId: string;
      humanCount: number;
      result: 'red' | 'blue' | 'draw';
      scoreRed: number;
      scoreBlue: number;
    }
  | { type: 'room_disposed'; roomId: string; humanCount: number };

const endpoint =
  process.env.LOBBY_INTERNAL_URL ??
  'http://127.0.0.1:2568/internal/game-events';
const sharedSecret =
  process.env.SERVICE_SHARED_SECRET ??
  (process.env.NODE_ENV === 'production' ? '' : 'locks-dev-secret-change-me');

export async function reportLobbyEvent(event: LobbyLifecycleEvent): Promise<void> {
  if (sharedSecret.length === 0) return;

  let delayMs = 150;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_500);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-locks-secret': sharedSecret,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (response.ok) return;
      const body = await response.text().catch(() => '');
      throw new Error(`lobby ${response.status}: ${body || response.statusText}`);
    } catch (error) {
      if (attempt === 3) {
        console.warn('[locks-game] lobby report failed', event.type, error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    } finally {
      clearTimeout(timeout);
    }
  }
}
