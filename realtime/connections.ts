
// Connections map stores WebSocket-like objects for both Node (`ws`) and Deno runtimes.
const connections = new Map<string, any>();

export function addConnection(deviceId: string, ws: any) {
  connections.set(deviceId, ws);
}

export function removeConnection(deviceId: string) {
  connections.delete(deviceId);
}

export function getConnection(deviceId: string): any | undefined {
  return connections.get(deviceId);
}

export function sendToDevice(deviceId: string, message: any) {
  const ws = getConnection(deviceId);
  if (!ws) return false;

  try {
    // Try to send as JSON string. Support both ws.send(...) (Node) and WebSocket.send(...) (Deno)
    if (typeof ws.send === 'function') {
      ws.send(JSON.stringify(message));
      return true;
    }

    // Deno's server WebSocket uses .send as well but may not have readyState constants; attempt send
    if (typeof ws.send === 'function') {
      ws.send(JSON.stringify(message));
      return true;
    }
  } catch (e) {
    console.warn('Failed to send message to device', deviceId, e);
    return false;
  }

  return false;
}
