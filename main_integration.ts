// Integration Guide for server-deno/main.ts
// Add these modifications to your existing main.ts file

// 1. Add import for bhajan functions
import { sendBhajanCommandToDevice } from "./bhajans.ts";

// 2. Add bhajan message handling in the WebSocket connection handler
// Find the switch(provider) block and add bhajan support before it:

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
            // Add bhajan support
            selected_bhajan_id: user.device?.selected_bhajan_id ?? null,
            current_bhajan_status: user.device?.current_bhajan_status ?? 'stopped',
        }),
    );

    // Add bhajan status update function
    const sendBhajanStatus = (status: any) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: "bhajan_status",
                ...status
            }));
        }
    };

    switch (provider) {
        // Existing cases remain the same
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
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
});

// 3. Add bhajan message handling in the server upgrade handler
// Add this after the existing authentication but before wss.handleUpgrade:

server.on("upgrade", async (req, socket, head) => {
    console.log("upgrade");
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

    // Add bhajan-specific handling
    const url = new URL(req.url);
    if (url.pathname.startsWith('/ws/device/') && url.pathname.includes('/bhajan')) {
        // Handle bhajan WebSocket connections
        const deviceId = url.pathname.split('/')[3];
        
        wss.handleUpgrade(req, socket, head, (ws) => {
            // Handle bhajan-specific WebSocket connection
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    if (message.type === 'bhajan_command') {
                        // Forward bhajan commands to device
                        sendBhajanCommandToDevice(deviceId, message.command, message.bhajan_id);
                    }
                } catch (error) {
                    console.error('Error handling bhajan message:', error);
                }
            });
        });
    } else {
        // Handle normal AI WebSocket connections
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, {
                user,
                supabase,
                timestamp: new Date().toISOString(),
            });
        });
    }
});