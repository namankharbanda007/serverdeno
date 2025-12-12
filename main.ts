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

    ws.on("message", async (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.type === "action" && data.command === "play_bhajan") {
                console.log("Received play_bhajan command");

                ws.send(JSON.stringify({
                    type: "server",
                    msg: "Playing Bhajan..."
                }));

                try {
                    console.log("Reading file: ./bhajan.wav");
                    // Assuming user renamed it or we are reading the org file, let's stick to known org file for now or bhajan.wav if they made it
                    // The user request was "implement", implying I should do the resampling.
                    // Let's read the ORIGINAL 16k file
                    const inputFilename = "./GayatriMantra_G711.org_.wav";
                    console.log(`Reading file: ${inputFilename}`);
                    const fileData = await Deno.readFile(inputFilename);
                    console.log(`File read successfully. Size: ${fileData.length} bytes`);

                    // Skip the 44-byte WAV header to get raw 16kHz PCM
                    const startOffset = 44;
                    const raw16k = fileData.subarray(startOffset);
                    console.log(`Skipped header. Raw 16k size: ${raw16k.length} bytes`);

                    // RESAMPLE TO 24k
                    console.log("Resampling from 16000 Hz to 24000 Hz...");
                    const resampledBuffer = resample16kTo24k(raw16k);
                    console.log(`Resampling complete. New size: ${resampledBuffer.length} bytes`);

                    const chunkSize = 1024; // Send in 1KB chunks
                    let chunksSent = 0;

                    // Send audio in chunks
                    for (let i = 0; i < resampledBuffer.length; i += chunkSize) {
                        const chunk = resampledBuffer.subarray(i, i + chunkSize);
                        ws.send(chunk);
                        chunksSent++;
                        if (chunksSent % 100 === 0) console.log(`Sent ${chunksSent} chunks...`);

                        // Small delay to prevent flooding
                        // 24000 Hz * 16 bit (2 bytes) = 48000 bytes/sec
                        // 1024 bytes = ~21.3 ms
                        // Wait 15ms is safe
                        await new Promise(resolve => setTimeout(resolve, 15));
                    }

                    console.log(`Finished streaming Bhajan. Total chunks: ${chunksSent}`);
                } catch (err) {
                    console.error("Error playing bhajan:", err);
                    ws.send(JSON.stringify({
                        type: "server",
                        msg: "Error playing audio file"
                    }));
                }
            }
        } catch (e) {
            // Ignore non-JSON messages or errors
        }
    });
});

// Helper: Linear Interpolation Resampler (16k -> 24k)
function resample16kTo24k(inputBuffer: Uint8Array): Uint8Array {
    // 1. Convert Uint8Buffer (Bytes) to Int16Array (Samples)
    const inputSamples = new Int16Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.byteLength / 2);

    // 2. Calculate New Size (Ratio 1.5)
    // 16000 * 1.5 = 24000
    const ratio = 1.5;
    const outputLength = Math.floor(inputSamples.length * ratio);
    const outputSamples = new Int16Array(outputLength);

    // 3. Linear Interpolation
    for (let i = 0; i < outputLength; i++) {
        const position = i / ratio;
        const index = Math.floor(position);
        const fraction = position - index;

        if (index + 1 < inputSamples.length) {
            const val1 = inputSamples[index];
            const val2 = inputSamples[index + 1];
            // Linear interp formula: y = y1 + (y2 - y1) * fraction
            outputSamples[i] = val1 + (val2 - val1) * fraction;
        } else {
            // Edge case: last sample
            outputSamples[i] = inputSamples[index] || 0;
        }
    }

    // 4. Convert back to Uint8Array (Bytes)
    return new Uint8Array(outputSamples.buffer);
}

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
