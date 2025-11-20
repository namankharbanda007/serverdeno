// Deno Deploy compatible server using Node.js http + npm:ws (ElatoAI pattern)
import { createServer } from "node:http";
import { WebSocketServer } from "npm:ws@8.18.0";
import type { WebSocket as WSWebSocket } from "npm:@types/ws@8.5.12";
import { getSupabaseClient } from './supabase.ts';
import { authenticateUser } from './utils.ts';
import {
  playBhajanOnDevice,
  controlBhajanPlayback,
  setDefaultBhajan,
  getDeviceBhajanStatus
} from './bhajans.ts';

// Create HTTP server
const server = createServer((req, res) => {
  // Handle regular HTTP requests
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  // Bhajan API endpoints
  if (url.pathname.startsWith('/api/bhajans')) {
    handleBhajanAPI(req, res);
    return;
  }

  // Root
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Dev Vani Server is running!');
});

// Create WebSocket server
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false  // CRITICAL for binary audio
});

// WebSocket upgrade handler
server.on("upgrade", async (req, socket, head) => {
  console.log('[WS] Upgrade request received');

  try {
    // Extract auth token
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    const token = authHeader?.replace('Bearer ', '') || '';

    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Authenticate
    const supabase = getSupabaseClient(token);
    const user = await authenticateUser(supabase, token);

    // Get device ID
    const { data: device } = await supabase
      .from('devices')
      .select('device_id, volume, is_ota, is_reset')
      .eq('user_id', user.id)
      .single();

    if (!device) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    console.log(`[WS] Authenticated device: ${device.device_id}`);

    // Upgrade to WebSocket
    wss.handleUpgrade(req, socket, head, (ws: WSWebSocket) => {
      wss.emit('connection', ws, {
        user,
        supabase,
        device,
        timestamp: new Date().toISOString()
      });
    });

  } catch (error) {
    console.error('[WS] Auth failed:', error);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

// WebSocket connection handler
wss.on('connection', async (ws: WSWebSocket, payload: any) => {
  const { user, supabase, device } = payload;
  const deviceId = device.device_id;

  console.log(`[WS] Device ${deviceId} connected`);

  // Send auth/config message to ESP32
  ws.send(JSON.stringify({
    type: 'auth',
    volume_control: device.volume ?? 20,
    is_ota: device.is_ota ?? false,
    is_reset: device.is_reset ?? false,
    pitch_factor: 1.0
  }));

  // Handle incoming messages
  ws.on('message', async (data: any, isBinary: boolean) => {
    try {
      if (isBinary) {
        // Binary audio data from ESP32
        // TODO: Forward to OpenAI Realtime API
        console.log(`[WS] Received binary audio data: ${data.length} bytes`);

      } else {
        // JSON messages
        const message = JSON.parse(data.toString('utf-8'));
        console.log(`[WS] Message from ${deviceId}:`, message.type || 'unknown');

        // Handle different message types
        if (message.type === 'bhajan_status') {
          // Update database with bhajan status
          await supabase
            .from('devices')
            .update({
              current_bhajan_status: message.status,
              current_bhajan_position: message.position,
              bhajan_playback_started_at: message.status === 'playing' ? new Date().toISOString() : null
            })
            .eq('device_id', deviceId);
        }
        else if (message.type === 'instruction') {
          // Handle instructions from ESP32 (e.g., end_of_speech, INTERRUPT)
          console.log(`[WS] Instruction from ${deviceId}:`, message.msg);
          // TODO: Forward to OpenAI Realtime API
        }
      }
    } catch (error) {
      console.error('[WS] Error processing message:', error);
    }
  });

  ws.on('close', (code: number, reason: string) => {
    console.log(`[WS] Device ${deviceId} disconnected: ${code} - ${reason}`);
  });

  ws.on('error', (error: any) => {
    console.error(`[WS] Error for device ${deviceId}:`, error);
  });
});

// Bhajan API handler (simplified)
async function handleBhajanAPI(req: any, res: any) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = url.pathname;

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Extract auth token
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    const token = authHeader?.replace('Bearer ', '') || '';

    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const supabase = getSupabaseClient(token);

    // Route to appropriate handler
    if (path === '/api/bhajans' && req.method === 'GET') {
      // Return list of bhajans
      const bhajans = [
        { id: 1, title: "Om Jai Jagadish Hare", artist: "Traditional", duration: "5:30" },
        { id: 2, title: "Hanuman Chalisa", artist: "Traditional", duration: "8:45" },
        { id: 3, title: "Gayatri Mantra", artist: "Traditional", duration: "3:15" }
      ];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: bhajans }));
    }
    else if (path === '/api/bhajans/play' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: any) => body += chunk);
      req.on('end', async () => {
        const { deviceId, bhajanId } = JSON.parse(body);
        await playBhajanOnDevice(supabase, deviceId, bhajanId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    }
    else if (path === '/api/bhajans/control' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: any) => body += chunk);
      req.on('end', async () => {
        const { deviceId, action } = JSON.parse(body);
        await controlBhajanPlayback(supabase, deviceId, action);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    }
    else if (path === '/api/bhajans/status' && req.method === 'GET') {
      const deviceId = url.searchParams.get('deviceId');
      if (!deviceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Device ID required' }));
        return;
      }

      const status = await getDeviceBhajanStatus(supabase, deviceId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, status }));
    }
    else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }

  } catch (error) {
    console.error('[API] Error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

// Start server
const PORT = parseInt(Deno.env.get('PORT') || '8000');
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`WebSocket ready for connections`);
});