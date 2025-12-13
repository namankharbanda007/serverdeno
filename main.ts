import { createServer } from "node:http";
import { WebSocketServer } from "npm:ws";
import type {
    WebSocket as WSWebSocket,
    WebSocketServer as _WebSocketServer,
} from "npm:@types/ws";
import { authenticateUser, elevenLabsApiKey, encoder, FRAME_SIZE, SAMPLE_RATE as TARGET_SAMPLE_RATE } from "./utils.ts";
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

    let activeStreamId = 0;

    ws.on("message", async (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.type === "action" && data.command === "play_bhajan") {
                console.log("Received play_bhajan command");

                // Cancel any previous loop
                activeStreamId++;
                const currentStreamId = activeStreamId;
                console.log(`Starting Stream ID: ${currentStreamId}`);

                ws.send(JSON.stringify({
                    type: "server",
                    msg: "Playing Bhajan..."
                }));

                try {
                    // GENERATE SYNTHETIC SINE WAVE (TESTING)
                    console.log("DEBUG: Generating synthetic 440Hz sine wave for testing...");
                    const durationSeconds = 5;
                    const sampleRate = TARGET_SAMPLE_RATE; // 24000
                    const totalSamples = sampleRate * durationSeconds;
                    const frequency = 440; // A4 note

                    // Create Int16Array for audio samples
                    const samples = new Int16Array(totalSamples);
                    for (let i = 0; i < totalSamples; i++) {
                        const t = i / sampleRate;
                        const sample = Math.sin(2 * Math.PI * frequency * t);
                        samples[i] = sample * 32767; // Scale to 16-bit PCM range
                    }

                    // Convert to Uint8Array for processing
                    const resampledBuffer = new Uint8Array(samples.buffer);
                    console.log(`Generated sine wave. Size: ${resampledBuffer.length} bytes`);

                    /* 
                    // DISABLE FILE READING FOR TEST
                    // console.log("Reading file: ./bhajan.wav");
                    // ... (rest of file reading logic commented out)
                    */


                    // ENCODE TO OPUS
                    // Use the EXACT SAME encoder instance and settings as Gemini (imported from utils)
                    // This maintains the continuous stream state the ESP32 Decoder expects.
                    console.log(`Encoding to Opus. Frame Size: ${FRAME_SIZE} bytes (120ms)`);

                    let chunksSent = 0;

                    // Loop through PCM buffer in correct Frame-sized chunks
                    for (let i = 0; i < resampledBuffer.length; i += FRAME_SIZE) {
                        // Check for cancellation
                        if (activeStreamId !== currentStreamId) {
                            console.log(`Stream ID ${currentStreamId} cancelled by new request.`);
                            break;
                        }

                        // Get PCM chunk
                        let pcmChunk = resampledBuffer.subarray(i, i + FRAME_SIZE);

                        // Pad last chunk if needed
                        if (pcmChunk.length < FRAME_SIZE) {
                            const padded = new Uint8Array(FRAME_SIZE);
                            padded.set(pcmChunk);
                            pcmChunk = padded;
                        }

                        try {
                            // Encode using SHARED encoder
                            const opusPacket = encoder.encode(pcmChunk);

                            // Send Opus Packet
                            ws.send(opusPacket);
                            chunksSent++;
                            if (chunksSent % 50 === 0) console.log(`[Stream ${currentStreamId}] Sent ${chunksSent} Opus frames...`);

                            // Throttle to real-time
                            // Frame duration is 120ms
                            // Wait slightly less to keep buffer full: 110ms
                            await new Promise(resolve => setTimeout(resolve, 110));
                        } catch (e) {
                            console.error("Opus encoding error:", e);
                        }
                    }

                    if (activeStreamId === currentStreamId) {
                        console.log(`Finished streaming Bhajan. Total frames: ${chunksSent}`);
                    }
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

    // DEBUG: Print first 5 samples
    console.log("DEBUG RESAMPLE: First 5 samples:", outputSamples.slice(0, 5));

    // 4. Convert back to Uint8Array (Bytes)
    return new Uint8Array(outputSamples.buffer);
}

function resample8kTo24k(inputBuffer: Uint8Array): Uint8Array {
    // 8k -> 24k is exactly 3x
    const inputSamples = new Int16Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.byteLength / 2);
    const ratio = 3;
    const outputLength = inputSamples.length * ratio;
    const outputSamples = new Int16Array(outputLength);

    for (let i = 0; i < inputSamples.length; i++) {
        const sample = inputSamples[i];
        // Simple sample repeat (Zero Order Hold) or Linear?
        // Linear:
        const nextSample = (i + 1 < inputSamples.length) ? inputSamples[i + 1] : sample;

        outputSamples[i * 3] = sample;
        outputSamples[i * 3 + 1] = Math.floor(sample + (nextSample - sample) * 0.33);
        outputSamples[i * 3 + 2] = Math.floor(sample + (nextSample - sample) * 0.66);
    }
    return new Uint8Array(outputSamples.buffer);
}

function decodeG711(data: Uint8Array, isALaw: boolean): Uint8Array {
    const pcms = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
        const val = data[i];
        pcms[i] = isALaw ? alaw2linear(val) : ulaw2linear(val);
    }
    return new Uint8Array(pcms.buffer);
}

// G.711 Lookup Tables / Algorithms
// Simplified for brevity, standard algorithms
function ulaw2linear(u_val: number): number {
    u_val = ~u_val;
    let t = ((u_val & 0x0F) << 3) + 0x84;
    t <<= (u_val & 0x70) >> 4;
    return ((u_val & 0x80) ? (0x84 - t) : (t - 0x84));
}

function alaw2linear(a_val: number): number {
    a_val ^= 0x55;
    let t = (a_val & 0x0F) << 4;
    let seg = (a_val & 0x70) >> 4;
    switch (seg) {
        case 0: t += 8; break;
        case 1: t += 0x108; break;
        default: t += 0x108; t <<= (seg - 1);
    }
    return ((a_val & 0x80) ? t : -t);
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
