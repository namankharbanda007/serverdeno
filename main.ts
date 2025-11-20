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
import { sendBhajanCommandToDevice } from "./bhajans.ts";
import { addConnection, removeConnection } from "./realtime/connections.ts";

const server = createServer();

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
      selected_bhajan_id: user.device?.selected_bhajan_id ?? null,
      current_bhajan_status: user.device?.current_bhajan_status ?? 'stopped',
    }),
  );

  const sendBhajanStatus = (status: any) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "bhajan_status",
        ...status
      }));
    }
  };

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

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/ws/device/') && url.pathname.includes('/bhajan')) {
    // Handle bhajan WebSocket connections
    const deviceId = url.pathname.split('/')[3];

    wss.handleUpgrade(req, socket, head, (ws: WSWebSocket) => {
      // Register this ws under a bhajan-specific key so server can target it
      const connKey = `${deviceId}-bhajan`;
      try {
        addConnection(connKey, ws as any);
        console.log(`Registered bhajan websocket for ${connKey}`);
      } catch (e) {
        console.warn('Failed to add connection to map:', e);
      }

      ws.on('message', (data: any) => {
        try {
          const message = JSON.parse(data.toString());
          // Accept forwarded bhajan commands from other parts of the system
          if (message.type === 'bhajan_play') {
            // Device is informing server or other peers; handle if needed
            // (No-op for now)
          } else if (message.type === 'bhajan_control') {
            // No-op server-side; device control comes from server
          }
        } catch (error) {
          console.error('Error handling bhajan incoming message:', error);
        }
      });

      ws.on('close', () => {
        try {
          removeConnection(connKey);
          console.log(`Removed bhajan websocket for ${connKey}`);
        } catch (e) {
          console.warn('Failed to remove connection:', e);
        }
      });
    });
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, {
        user,
        supabase,
        timestamp: new Date().toISOString(),
      });
    });
  }
});

if (isDev) { // deno run -A --env-file=.env main.ts
  const HOST = Deno.env.get("HOST") || "0.0.0.0";
  const PORT = Deno.env.get("PORT") || "8000";
  server.listen(Number(PORT), HOST, () => {
    console.log(`Audio capture server running on ws://${HOST}:${PORT}`);
  });
} else {
  server.listen(8080);
}