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
                    // Try the original file
                    const inputFilename = "./GayatriMantra_G711.org_.wav";
                    console.log(`Reading file: ${inputFilename}`);
                    const fileData = await Deno.readFile(inputFilename);
                    console.log(`File read successfully. Size: ${fileData.length} bytes`);

                    // PARSE WAV HEADER
                    const view = new DataView(fileData.buffer);
                    const audioFormat = view.getUint16(20, true); // Offset 20, LE
                    const channels = view.getUint16(22, true);
                    const sampleRate = view.getUint32(24, true);
                    const byteRate = view.getUint32(28, true);
                    const blockAlign = view.getUint16(32, true);
                    const bitsPerSample = view.getUint16(34, true);

                    console.log(`WAV Header: Format=${audioFormat}, Channels=${channels}, Rate=${sampleRate}, Bits=${bitsPerSample}`);

                    let raw16k: Uint8Array;
                    const startOffset = 44; // Standard header size assumption, but lets stick to it for now

                    if (audioFormat === 1) {
                        // PCM
                        console.log("Format is PCM. Proceeding...");
                        raw16k = fileData.subarray(startOffset);
                    } else if (audioFormat === 6 || audioFormat === 7) {
                        // G.711 A-law (6) or u-law (7)
                        console.log(`Format is G.711 (${audioFormat}). Decoding to PCM...`);
                        const g711Data = fileData.subarray(startOffset);
                        raw16k = decodeG711(g711Data, audioFormat === 6); // Implement decodeG711 helper
                        console.log(`Decoded G.711. New PCM size: ${raw16k.length}`);
                    } else if (audioFormat === 65534) {
                        // Extensible, likely PCM but we warn
                        console.log("Format is WAVE_FORMAT_EXTENSIBLE. Assuming PCM...");
                        raw16k = fileData.subarray(startOffset);
                    } else {
                        console.warn(`WARNING: Unknown WAV format ${audioFormat}. sending as is...`);
                        raw16k = fileData.subarray(startOffset);
                    }

                    // RESAMPLE TO 24k
                    console.log("Resampling from 16000 Hz to 24000 Hz...");
                    // Note: If G.711 was 8000Hz (typical), we might need to double resample or change ratio
                    // But user said it was converted to 16kHz

                    let resampledBuffer;
                    if (sampleRate === 8000) {
                        console.log("Source is 8kHz. Upsampling 8k -> 24k (3x)");
                        resampledBuffer = resample8kTo24k(raw16k);
                    } else {
                        // Assume 16k
                        resampledBuffer = resample16kTo24k(raw16k);
                    }

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
                        // 1024 bytes = ~21.33 ms of audio
                        // Sending every 20ms keeps buffer full but prevents overflow
                        await new Promise(resolve => setTimeout(resolve, 20));
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
