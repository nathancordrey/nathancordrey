export type GameRoomStatus = {
  exists: boolean;
  roomId: string;
  joinable: boolean;
  humanCount: number;
  maxClients: number;
};

export interface GameApi {
  createRoom(): Promise<{ roomId: string }>;
  roomStatus(roomId: string): Promise<GameRoomStatus>;
}

export type GameApiConfig = {
  baseUrl: string;
  sharedSecret: string;
  timeoutMs?: number;
};

export function createGameApi(config: GameApiConfig): GameApi {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const timeoutMs = config.timeoutMs ?? 5_000;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-locks-secret': config.sharedSecret,
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`game service ${response.status}: ${body || response.statusText}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    createRoom() {
      return request<{ roomId: string }>('/internal/rooms', {
        method: 'POST',
        body: '{}',
      });
    },

    roomStatus(roomId: string) {
      return request<GameRoomStatus>(`/internal/rooms/${encodeURIComponent(roomId)}`);
    },
  };
}
