import { useEffect, useRef, useState } from 'react';
import type { WsMessage } from '@shared/types';

export interface SocketState { connected: boolean }

/** Opens the /ws socket with automatic reconnection and delivers typed messages. */
export function useSdrSocket(onMessage: (m: WsMessage) => void): SocketState {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        try {
          handler.current(JSON.parse(String(e.data)) as WsMessage);
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { connected };
}
