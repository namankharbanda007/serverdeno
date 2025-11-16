import { SupabaseClient } from "@supabase/supabase-js";
import { sendToDevice } from "./realtime/connections.ts";

// Types
export interface Bhajan {
    id: number;
    name: string;
    url: string;
    created_at: string;
}

export interface DeviceBhajanStatus {
    device_id: string;
    current_bhajan_status: 'playing' | 'paused' | 'stopped';
    current_bhajan_position: number;
    bhajan_playback_started_at: string | null;
    selected_bhajan: Bhajan | null;
    default_bhajan: Bhajan | null;
}

// Get all available bhajans
export async function getAllBhajans(supabase: SupabaseClient): Promise<Bhajan[]> {
    const { data, error } = await supabase
        .from('bhajans')
        .select('*')
        .order('name');
    if (error) throw new Error(`Failed to fetch bhajans: ${error.message}`);
    return data || [];
}

// Get device bhajan status from the dedicated view
export async function getDeviceBhajanStatus(
    supabase: SupabaseClient,
    deviceId: string
): Promise<DeviceBhajanStatus | null> {
    const { data, error } = await supabase
        .from('device_bhajan_status')
        .select('*')
        .eq('device_id', deviceId)
        .single();

    if (error) {
        // If the view doesn't exist or row is missing, it might throw an error.
        // We can return a default/empty state instead of throwing.
        console.warn(`Could not fetch device bhajan status for ${deviceId}: ${error.message}`);
        return null;
    }
    return data;
}


// Play bhajan on device (upexport async function playBhajanOnDevice(
    supabase: SupabaseClient,
    deviceId: string,
    bhajanId: number,
): Promise<void> {t bhajan details to ensure it exists
    const { data: bhajan, error: bhajanError } = await supabase
        .from('bhajans')
        .select('id')
        .eq('id', bhajanId)
        .single();
    if (bhajanError || !bhajan) throw new Error('Bhajan not found');

    // Update device status
    const { error: updateError } = await supabase
        .from('devices')
        .update({
            selected_bhajan_id: bhajanId,
            current_bhajan_status: 'playing',
            bhajan_playback_started_at: new Date().toISOString(),
            // Reset position, assuming playback starts from the beginning
            current_bhajan_position: 0,
        })
        .eq('device_id', deviceId);

    if (updateError) throw new Error(`Failed to update device status for play: ${updateError.message}`);

    // Log playback start
    await supabase
        .from('bhajan_playback_history')
        .insert({
            device_id: deviceId,
            bhajan_id: bhajanId,
            event_type: 'play',
        });
}

// Control bhajan playback (updates Dexport async function controlBhajanPlayback(
    supabase: SupabaseClient,
    deviceId: string,
    action: 'play' | 'pause' | 'stop' | 'resume',
): Promise<void> {: device, error: deviceError } = await supabase
        .from('devices')
        .select('current_bhajan_status, selected_bhajan_id, bhajan_playback_started_at, current_bhajan_position')
        .eq('device_id', deviceId)
        .single();

    if (deviceError || !device) throw new Error('Device not found');

    let newStatus: 'playing' | 'paused' | 'stopped' = device.current_bhajan_status;
    let playbackStartedAt = device.bhajan_playback_started_at;
    let position = device.current_bhajan_position || 0;

    const now = new Date();

    // Calculate elapsed time if we are moving from playing to paused/stopped
    if (device.current_bhajan_status === 'playing' && playbackStartedAt) {
        position += Math.floor((now.getTime() - new Date(playbackStartedAt).getTime()) / 1000);
    }

    switch (action) {
        case 'play': // This might be used to start a bhajan without selecting a new one
        case 'resume':
            if (newStatus !== 'playing') {
                newStatus = 'playing';
                playbackStartedAt = now.toISOString();
            }
            break;
        case 'pause':
            if (newStatus === 'playing') {
                newStatus = 'paused';
            }
            break;
        case 'stop':
            newStatus = 'stopped';
            position = 0; // Reset position on stop
            break;
        default:
            throw new Error('Invalid action');
    }

    const { error: updateError } = await supabase
        .from('devices')
        .update({
            current_bhajan_status: newStatus,
            bhajan_playback_started_at: playbackStartedAt,
            current_bhajan_position: position,
        })
        .eq('device_id', deviceId);

    if (updateError) throw new Error(`Failed to update device status for control: ${updateError.message}`);

    // Log the event
    if (device.selected_bhajan_id) {
        await supabase.from('bhajan_playback_history').insert({
            device_id: deviceId,
            bhajan_id: device.selected_bhajan_id,
            event_type: action,
            duration_seconds: action === 'pause' || action === 'stop' ? position : undefined,
        });
    }
}


// Set defaulexport async function setDefaultBhajan(
    supabase: SupabaseClient,
    deviceId: string,
    bhajanId: number,
): Promise<void> {
    const { error: updateError } = await supabase
        .from('devices')
        .update({ default_bhajan_id: bhajanId })
        .eq('device_id', deviceId);

    if (updateError) throw new Error(`Failed to set default bhajan: ${updateError.message}`);
}

// Get playback historyexport async function getPlaybackHistory(
    supabase: SupabaseClient,
    deviceId: string,
    limit = 50
) {error } = await supabase
        .from('bhajan_playback_history_view') // Using a view to get bhajan names
        .select('*')
        .eq('device_id', deviceId)
        .order('event_timestamp', { ascending: false })
        .limit(limit);

    if (error) throw new Error(`Failed to fetch playback history: ${error.message}`);
    return data;
}

// WebSocket message sender for bhajan commands
export function sendBhajanCommandToDevice(
    deviceId: string,
    command: string,
    bhajanId?: number,
    url?: string
): boolean {
    console.log(`Attempting to send command '${command}' to device ${deviceId}`);
    const message: { type: string; command: string; timestamp: string; bhajan_id?: number; url?: string } = {
        type: 'bhajan_command',
        command: command,
        timestamp: new Date().toISOString(),
    };

    if (bhajanId) {
        message.bhajan_id = bhajanId;
    }
    if (url) {
        message.url = url;
    }

    // Try sending to the specific bhajan websocket first, then fallback to the main one
    const sentToBhajanSocket = sendToDevice(`${deviceId}-bhajan`, message);
    if (sentToBhajanSocket) {
        console.log(`Sent '${command}' to bhajan socket for ${deviceId}`);
        return true;
    }

    const sentToMainSocket = sendToDevice(deviceId, message);
    if (sentToMainSocket) {
        console.log(`Sent '${command}' to main AI socket for ${deviceId}`);
    } else {
        console.warn(`Device ${deviceId} not connected on any WebSocket.`);
    }
    return sentToMainSocket;
}