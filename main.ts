import { createServer } from "node:http";
import { WebSocketServer } from "npm:ws";
import type {
  WebSocket as WSWebSocket,
  WebSocketServer as _WebSocketServer,
} from "npm:@types/ws";
import { authenticateUser, elevenLabsApiKey } from "./utils.ts";
import {
  createFirstMessage,
  createSystemPrompt,
  getChatHistory,
  getSupabaseClient,
} from "./supabase.ts";
import { SupabaseClient } from "@supabase/supabase-js";
import { isDev } from "./utils.ts";
import { connectToOpenAI } from "./models/openai.ts";
import { connectToGemini } from "./models/gemini.ts";
import { connectToElevenLabs } from "./models/elevenlabs.ts";
import { connectToHume } from "./models/hume.ts";
// Bhajan imports
import {
  playBhajanOnDevice,
  controlBhajanPlayback,
  setDefaultBhajan,
  getDeviceBhajanStatus
} from './bhajans.ts';

const server = createServer((req, res) => {
  // CRITICAL: Skip WebSocket upgrade requests - let them go to 'upgrade' event handler
  if (req.headers.upgrade?.toLowerCase() === 'websocket') {
    return;
  }

  // Handle Bhajan API HTTP requests
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/bhajans')) {
    handleBhajanAPI(req, res);
    return;
  }

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  // Default response
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Dev Vani Server');
});

const wss: _WebSocketServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

wss.on('headers', (headers, req) => {
  // You should NOT see any "Sec-WebSocket-Extensions" here
  console.log('WS response headers :', headers);
});

wss.on("connection", async (ws: WSWebSocket, payload: IPayload) => {
  const { user, supabase } = payload;

  let connectionPcmFile: Deno.FsFile | null = null;
  if (isDev) {
    const filename = `debug_audio_${Date.now()}.pcm`;
    connectionPcmFile = await Deno.open(filename, {
      create: true,
      write: true,
      append: true,
    });
  }

  const chatHistory = await getChatHistory(
    supabase,
    user.user_id,
    user.personality?.key ?? null,
    false,
  );
  const firstMessage = createFirstMessage(payload);
  const systemPrompt = createSystemPrompt(chatHistory, payload);

  const provider = user.personality?.provider;

  // send user details to client
  // when DEV_MODE is true, we send the default values 100, false, false
  ws.send(
    JSON.stringify({
      type: "auth",
      volume_control: user.device?.volume ?? 20,
      is_ota: user.device?.is_ota ?? false,
      is_reset: user.device?.is_reset ?? false,
      pitch_factor: user.personality?.pitch_factor ?? 1,
    }),
  );

  switch (provider) {
    case "openai":
      await connectToOpenAI(
        ws,
        payload,
        connectionPcmFile,
        firstMessage,
        systemPrompt,
      );
      break;
    case "gemini":
      await connectToGemini(
        ws,
        payload,
        connectionPcmFile,
        firstMessage,
        systemPrompt,
      );
      break;
    case "elevenlabs":
      const agentId = user.personality?.oai_voice ?? "";

      if (!elevenLabsApiKey) {
        throw new Error("ELEVENLABS_API_KEY environment variable is required");
      }

      await connectToElevenLabs(
        ws,
        payload,
        connectionPcmFile,
        agentId,
        elevenLabsApiKey,
      );
      break;
    case "hume":
      await connectToHume(ws, payload,
        connectionPcmFile, firstMessage, systemPrompt, () => Promise.resolve());
      break;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
});

server.on("upgrade", async (req, socket, head) => {
  console.log('foobar upgrade', req.headers);
  let user: IUser;
  let supabase: SupabaseClient;
  let authToken: string;
  try {
    const { authorization: authHeader, "x-wifi-rssi": rssi } = req.headers;
    authToken = authHeader?.replace("Bearer ", "") ?? "";
    const wifiStrength = parseInt(rssi as string); // Convert to number

    // You can now use wifiStrength in your code
    console.log("WiFi RSSI:", wifiStrength); // Will log something like -50

    // Remove debug logging
    if (!authToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    supabase = getSupabaseClient(authToken as string);
    user = await authenticateUser(supabase, authToken as string);
  } catch (_e: any) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, {
      user,
      supabase,
      timestamp: new Date().toISOString(),
    });
  });
});

// Bhajan API handler
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

if (isDev) { // deno run -A --env-file=.env main.ts
  const HOST = Deno.env.get("HOST") || "0.0.0.0";
  const PORT = Deno.env.get("PORT") || "8000";
  server.listen(Number(PORT), HOST, () => {
    console.log(`Audio capture server running on ws://${HOST}:${PORT}`);
  });
} else {
  server.listen(8080);
}