import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { SupabaseClient, createClient }from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { WebSocketServer, WebSocket } from "npm:ws";

import {
    authenticateUser,
    isDev,
    openaiApiKey,
    geminiApiKey,
    elevenLabsApiKey,
} from "./utils.ts";
import { getSupabaseClient } from "./supabase.ts";
import {
    addConnection,
    removeConnection,
    sendToDevice,
} from "./realtime/connections.ts";
import {
    connectToOpenAI,
    connectToGemini,
    connectToElevenLabs,
} from "./models/index.ts";
import {
    createFirstMessage,
    createSystemPrompt,
    getChatHistory,
} from "./realtime/conversation.ts";
import {
    getAllBhajans,
    getDeviceBhajanStatus,
    playBhajanOnDevice,
    controlBhajanPlayback,
    setDefaultBhajan,
    getPlaybackHistory,
    sendBhajanCommandToDevice,
} from "./bhajans.ts";
import type { IPayload, IUser } from "./types.d.ts";

const wss = new WebSocketServer({ noServer: true });

// CORS headers
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

// Main AI WebSocket connection handler
wss.on("connection", async (ws: WebSocket, payload: IPayload) => {
    const { user, supabase, deviceId } = payload;

    addConnection(deviceId, ws);

    ws.on("close", () => {
        removeConnection(deviceId);
    });

    ws.on("message", (data) => {
        // Handle incoming messages from the device if needed
        try {
            const message = JSON.parse(data.toString());
            console.log(`Received message from ${deviceId}:`, message);
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    const chatHistory = await getChatHistory(
        supabase,
        user.user_id,
        user.personality?.key ?? null,
        false,
    );
    const firstMessage = createFirstMessage(payload);
    const systemPrompt = createSystemPrompt(chatHistory, payload);

    ws.send(
        JSON.stringify({
            type: "auth_success",
            deviceId: deviceId,
            volume_control: user.device?.volume ?? 20,
            is_ota: user.device?.is_ota ?? false,
            is_reset: user.device?.is_reset ?? false,
            pitch_factor: user.personality?.pitch_factor ?? 1,
            selected_bhajan_id: user.device?.selected_bhajan_id ?? null,
            current_bhajan_status: user.device?.current_bhajan_status ?? 'stopped',
        }),
    );

    const provider = user.personality?.provider;
    switch (provider) {
        case "openai":
            if (!openaiApiKey) throw new Error("OPENAI_API_KEY is not set.");
            await connectToOpenAI(ws, payload, null, firstMessage, systemPrompt);
            break;
        case "gemini":
            if (!geminiApiKey) throw new Error("GEMINI_API_KEY is not set.");
            await connectToGemini(ws, payload, null, firstMessage, systemPrompt);
            break;
        case "elevenlabs":
            if (!elevenLabsApiKey) throw new Error("ELEVENLABS_API_KEY is not set.");
            const agentId = user.personality?.oai_voice ?? "";
            await connectToElevenLabs(ws, payload, null, agentId, elevenLabsApiKey);
            break;
        default:
            console.error(`Unknown provider: ${provider}`);
            ws.close(1011, `Unknown provider: ${provider}`);
    }
});


async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Handle WebSocket upgrade requests
    if (req.headers.get("upgrade") === "websocket") {
        const deviceIdMatch = pathname.match(/\/ws\/device\/([a-zA-Z0-9_-]+)/);
        const deviceId = deviceIdMatch ? deviceIdMatch[1] : null;

        if (!deviceId) {
            return new Response("Invalid WebSocket URL", { status: 400 });
        }

        let user: IUser;
        let supabase: SupabaseClient;
        try {
            const authHeader = req.headers.get("authorization");
            const authToken = authHeader?.replace("Bearer ", "") ?? "";
            if (!authToken) return new Response("Unauthorized", { status: 401 });

            supabase = getSupabaseClient(authToken);
            user = await authenticateUser(supabase, authToken);
        } catch (e) {
            console.error("Auth error:", e.message);
            return new Response("Authentication failed", { status: 401 });
        }

        const { socket, response } = Deno.upgradeWebSocket(req);

        // If it's a bhajan-specific WebSocket, just manage the connection
        if (pathname.endsWith("/bhajan")) {
            addConnection(`${deviceId}-bhajan`, socket);
            socket.onclose = () => removeConnection(`${deviceId}-bhajan`);
            console.log(`Bhajan WebSocket connected for device: ${deviceId}`);
        } else {
            // Otherwise, it's the main AI WebSocket
            const payload: IPayload = { user, supabase, deviceId, timestamp: new Date().toISOString() };
            wss.emit("connection", socket, payload);
            console.log(`AI WebSocket connected for device: ${deviceId}`);
        }

        return response;
    }

    // Handle regular HTTP API requests
    if (pathname.startsWith("/api/bhajans")) {
        return await handleBhajanApi(req, pathname);
    }

    return new Response("Not Found", { status: 404 });
}

async function handleBhajanApi(req: Request, path: string): Promise<Response> {
    try {
        const authHeader = req.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const authToken = authHeader.replace('Bearer ', '');
        const supabase = getSupabaseClient(authToken);
        const user = await authenticateUser(supabase, authToken);

        if (path === '/api/bhajans' && req.method === 'GET') {
            const bhajans = await getAllBhajans(supabase);
            return new Response(JSON.stringify({ bhajans }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        if (path === '/api/bhajans/status' && req.method === 'GET') {
            const deviceId = new URL(req.url).searchParams.get('deviceId');
            if (!deviceId) return new Response(JSON.stringify({ error: 'Device ID is required' }), { status: 400, headers: corsHeaders });
            const status = await getDeviceBhajanStatus(supabase, deviceId);
            return new Response(JSON.stringify({ status }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        if (req.method === 'POST') {
            const body = await req.json();
            const { deviceId } = body;
            if (!deviceId) return new Response(JSON.stringify({ error: 'Device ID is required' }), { status: 400, headers: corsHeaders });

            // Verify user owns the device
            const { data: device, error: deviceError } = await supabase.from('devices').select('device_id').eq('device_id', deviceId).eq('user_id', user.user_id).single();
            if (deviceError || !device) {
                return new Response(JSON.stringify({ error: 'Device not found or not owned by user' }), { status: 403, headers: corsHeaders });
            }

            if (path === '/api/bhajans/play') {
                const { bhajanId } = body;
                if (!bhajanId) return new Response(JSON.stringify({ error: 'Bhajan ID is required' }), { status: 400, headers: corsHeaders });
                
                // Get bhajan URL
                const { data: bhajan, error: bhajanError } = await supabase.from('bhajans').select('url').eq('id', bhajanId).single();
                if (bhajanError || !bhajan) {
                    return new Response(JSON.stringify({ error: 'Bhajan not found' }), { status: 404, headers: corsHeaders });
                }

                await playBhajanOnDevice(supabase, deviceId, bhajanId);
                await sendBhajanCommandToDevice(deviceId, 'play', bhajanId, bhajan.url);
                return new Response(JSON.stringify({ success: true, message: 'Play command sent' }), { status: 200, headers: corsHeaders });
            }

            if (path === '/api/bhajans/control') {
                const { action } = body;
                if (!action) return new Response(JSON.stringify({ error: 'Action is required' }), { status: 400, headers: corsHeaders });
                await controlBhajanPlayback(supabase, deviceId, action);
                await sendBhajanCommandToDevice(deviceId, action);
                return new Response(JSON.stringify({ success: true, message: `Control command '${action}' sent` }), { status: 200, headers: corsHeaders });
            }

            if (path === '/api/bhajans/default') {
                const { bhajanId } = body;
                if (!bhajanId) return new Response(JSON.stringify({ error: 'Bhajan ID is required' }), { status: 400, headers: corsHeaders });
                await setDefaultBhajan(supabase, deviceId, bhajanId);
                return new Response(JSON.stringify({ success: true, message: 'Default bhajan set' }), { status: 200, headers: corsHeaders });
            }
        }

        return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    } catch (error) {
        console.error('API Error:', error);
        return new Response(JSON.stringify({ error: error.message || 'Internal Server Error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}


const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on http://localhost:${port}`);
serve(handler, { port });