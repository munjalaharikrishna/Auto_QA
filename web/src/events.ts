import { useEffect, useRef } from 'react';
import type { ServerEvent } from '../../src/server/jobs.js';

/** Live events from the server (FR-RUN-02). Reconnects when the connection drops. */
export function useServerEvents(onEvent: (e: ServerEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    let socket: WebSocket | undefined;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`);
      socket.onmessage = (m) => handler.current(JSON.parse(String(m.data)) as ServerEvent);
      socket.onclose = () => {
        if (!stopped) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, []);
}
