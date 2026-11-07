// Transport for the authoritative Node server: one WebSocket, auto-reconnect.
export function wsTransport({ room, onMessage, onStatus, onConnected }) {
  let ws = null, stopped = false;
  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
    ws.onopen = () => { onStatus(`room "${room}"`); onConnected(); };
    ws.onclose = () => { if (stopped) return; onStatus('disconnected - retrying…'); setTimeout(open, 1500); };
    ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch { /* ignore malformed */ } };
  }
  open();
  return {
    send: m => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); },
    stop: () => { stopped = true; ws?.close(); },
  };
}
