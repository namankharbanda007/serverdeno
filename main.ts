import { createServer } from "node:http";
import { WebSocketServer } from "npm:ws";
import type {
    WebSocket as WSWebSocket,
    WebSocketServer as _WebSocketServer,
} from "npm:@types/ws";
import {
    checkAndResetUsage,
    createFirstMessage,
    createSystemPrompt,
    getChatHistory,
    getSupabaseClient,
    updateUserUsage,
} from "./supabase.ts";
import {
    authenticateUser,
    elevenLabsApiKey,
    FREE_LIMIT_SECONDS,
    PREMIUM_LIMIT_SECONDS,
    isDev
} from "./utils.ts";
import { SupabaseClient } from "@supabase/supabase-js";
import { connectToOpenAI } from "./models/openai.ts";
import { connectToGemini } from "./models/gemini.ts";
import { connectToElevenLabs } from "./models/elevenlabs.ts";
import { connectToHume } from "./models/hume.ts";

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
    const { supabase } = payload;
    let { user } = payload;

    // Check and reset usage if needed
    user = await checkAndResetUsage(supabase, user);

    // Check if user has exceeded their limit
    const limit = user.is_premium ? PREMIUM_LIMIT_SECONDS : FREE_LIMIT_SECONDS;
    if (user.session_time >= limit) {
        console.log(`User ${user.user_id} exceeded limit. Disconnecting.`);
        ws.send(JSON.stringify({
            type: "error",
            code: "LIMIT_EXCEEDED",
            message: "You have reached your monthly usage limit. Please upgrade to Premium for more time.",
        }));
        ws.close();
        return;
    }

    // Start tracking usage
    const sessionStartTime = Date.now();
    const initialSessionTime = user.session_time;

    // Update usage every 30 seconds
    const usageInterval = setInterval(async () => {
        const elapsedSeconds = Math.floor((Date.now() - sessionStartTime) / 1000);
        const currentTotal = initialSessionTime + elapsedSeconds;

        // Update DB
        await updateUserUsage(supabase, user.user_id, currentTotal);

        // Check Limit
        if (currentTotal >= limit) {
            console.log(`User ${user.user_id} reached limit during session.`);
            ws.send(JSON.stringify({
                type: "error",
                code: "LIMIT_EXCEEDED",
                message: "You have reached your monthly usage limit.",
            }));
            ws.close();
        }
    }, 30000); // 30 seconds

    ws.on("close", async () => {
        clearInterval(usageInterval);
        // Final update on close
        const elapsedSeconds = Math.floor((Date.now() - sessionStartTime) / 1000);
        const currentTotal = initialSessionTime + elapsedSeconds;
        if (currentTotal < limit) { // Don't verify limit here, just save, unless we want to prevent over-saving? 
            // Actually just save proper value.
            await updateUserUsage(supabase, user.user_id, currentTotal);
        }
    });


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

if (isDev) { // deno run -A --env-file=.env main.ts
    const HOST = Deno.env.get("HOST") || "0.0.0.0";
    const PORT = Deno.env.get("PORT") || "8000";
    server.listen(Number(PORT), HOST, () => {
        console.log(`Audio capture server running on ws://${HOST}:${PORT}`);
    });
} else {
    server.listen(8080);
}
