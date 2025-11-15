
import { WebSocket } from "npm:ws";

const connections = new Map<string, WebSocket>();

export function addConnection(deviceId: string, ws: WebSocket) {
  connections.set(deviceId, ws);
}

export function removeConnection(deviceId: string) {
  connections.delete(deviceId);
}

export function getConnection(deviceId: string): WebSocket | undefined {
  return connections.get(deviceId);
}

export function sendToDevice(deviceId: string, message: any) {
  const ws = getConnection(deviceId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}