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
import { isDev } from "./utils.ts";
import { connectToOpenAI } from "./models/openai.ts";
import { connectToGemini } from "./models/gemini.ts";
import { connectToElevenLabs } from "./models/elevenlabs.ts";

const server = createServer();

const wss: _WebSocketServer = new WebSocketServer({ noServer: true });

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
        supabase as any,
        user.user_id,
        user.personality?.key ?? null,
        false,
    );
    const firstMessage = createFirstMessage(payload as any);
    const systemPrompt = createSystemPrompt(chatHistory as any, payload as any);

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
        case "openai": {
            await connectToOpenAI(
                ws as any,
                payload as any,
                connectionPcmFile as any,
                firstMessage as any,
                systemPrompt as any,
            );
            break;
        }
        case "gemini": {
            await connectToGemini(
                ws as any,
                payload as any,
                connectionPcmFile as any,
                firstMessage as any,
                systemPrompt as any,
            );
            break;
        }
        case "elevenlabs": {
            const agentId = user.personality?.oai_voice ?? "";

            if (!elevenLabsApiKey) {
                throw new Error("ELEVENLABS_API_KEY environment variable is required");
            }

            await connectToElevenLabs(
                ws as any,
                payload as any,
                connectionPcmFile as any,
                agentId,
                elevenLabsApiKey,
            );
            break;
        }
        default: {
            throw new Error(`Unknown provider: ${provider}`);
        }
    }
});

server.on("upgrade", async (req, socket, head) => {
    // Debug: incoming upgrade request
    try {
        // socket is a Duplex / net.Socket; cast to any to avoid strict type errors when accessing remoteAddress/remotePort
        const s: any = socket;
        const remoteAddr = (s && s.remoteAddress) ? `${s.remoteAddress}:${s.remotePort}` : 'unknown';
        console.log(`[upgrade] incoming upgrade request from ${remoteAddr} url=${req.url} headLen=${head ? head.length : 0}`);
        console.log('[upgrade] request headers:', req.headers);
    } catch (e) {
        console.log('[upgrade] debug print error', e);
    }
    let user: IUser;
    // getSupabaseClient may return differing SupabaseClient types depending on dependencies; use a relaxed type here for debugging logs
    let supabase: any;
    let authToken: string;
    try {
        const { authorization: authHeader, "x-wifi-rssi": rssi } = req.headers;
        authToken = authHeader?.replace("Bearer ", "") ?? "";
        const wifiStrength = parseInt(rssi as string); // Convert to number

        // Debug print extracted values (non-functional)
        console.log('[upgrade] authHeader present=', !!authHeader, ' authTokenLen=', (authToken || '').length);
        console.log('[upgrade] x-wifi-rssi header=', rssi, ' parsed=', isNaN(wifiStrength) ? 'NaN' : wifiStrength);

        if (!authToken) {
            console.log('[upgrade] Missing Authorization header or token - rejecting upgrade (401)');
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }

        supabase = getSupabaseClient(authToken as string);
        user = await authenticateUser(supabase, authToken as string);
        console.log('[upgrade] authenticateUser result user=', user ? (user.user_id ?? 'unknown') : 'null');
    } catch (err: any) {
        console.log('[upgrade] authentication error:', err && err.message ? err.message : err);
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
    }

    console.log('[upgrade] calling wss.handleUpgrade for user=', user ? (user.user_id ?? 'unknown') : 'unknown');
    wss.handleUpgrade(req, socket, head, (ws) => {
        try {
            console.log('[upgrade] handleUpgrade callback - emitting connection for user=', user ? (user.user_id ?? 'unknown') : 'unknown');
        } catch (e) {
            console.log('[upgrade] handleUpgrade callback debug error', e);
        }
        wss.emit("connection", ws, {
            user,
            supabase,
            timestamp: new Date().toISOString(),
        });
    });
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
