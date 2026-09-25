import { useEffect, useRef, useState } from 'react';
import type { WsMessage } from '@shared/types';

export interface SocketState { connected: boolean }

const DISCONNECT_GRACE_MS = 3000;

/** Opens the /ws socket with automatic reconnection and delivers typed messages. */
export function useSdrSocket(onMessage: (m: WsMessage) => void): SocketState {
  // `connected` only turns false after a grace period, so the initial handshake and quick reconnects don't flicker.
  const [connected, setConnected] = useState(true);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let grace: ReturnType<typeof setTimeout> | null = setTimeout(() => setConnected(false), DISCONNECT_GRACE_MS);
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        if (grace) { clearTimeout(grace); grace = null; }
        setConnected(true);
      };
      ws.onmessage = (e) => {
        try {
          handler.current(JSON.parse(String(e.data)) as WsMessage);
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        if (!closed) {
          if (!grace) grace = setTimeout(() => setConnected(false), DISCONNECT_GRACE_MS);
          timer = setTimeout(connect, 1500);
        }
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      ws?.close();
    };
  }, []);

  return { connected };
}
