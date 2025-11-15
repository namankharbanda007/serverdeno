// API Routes for Bhajan Management
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { getSupabaseClient } from "../supabase.ts";
import { authenticateUser } from "../utils.ts";
import {
    getAllBhajans,
    getDeviceBhajanStatus,
    playBhajanOnDevice,
    controlBhajanPlayback,
    setDefaultBhajan,
    getPlaybackHistory
} from "../bhajans.ts";

// CORS headers
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

// Handle OPTIONS requests
function handleOptions() {
    return new Response(null, {
        status: 200,
        headers: corsHeaders,
    });
}

// Main handler
async function handler(req: Request): Promise<Response> {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return handleOptions();
    }
    
    const url = new URL(req.url);
    const path = url.pathname;
    
    try {
        // Extract auth token
        const authHeader = req.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return new Response(
                JSON.stringify({ error: 'Unauthorized' }),
                {
                    status: 401,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                }
            );
        }
        
        const authToken = authHeader.replace('Bearer ', '');
        const supabase = getSupabaseClient(authToken);
        const user = await authenticateUser(supabase, authToken);
        
        // Route handling
        if (path === '/api/bhajans' && req.method === 'GET') {
            return await handleGetBhajans(supabase);
        }
        
        if (path === '/api/bhajans/play' && req.method === 'POST') {
            return await handlePlayBhajan(supabase, req, user.user_id);
        }
        
        if (path === '/api/bhajans/control' && req.method === 'POST') {
            return await handleControlBhajan(supabase, req, user.user_id);
        }
        
        if (path === '/api/bhajans/default' && req.method === 'POST') {
            return await handleSetDefaultBhajan(supabase, req, user.user_id);
        }
        
        if (path === '/api/bhajans/history' && req.method === 'GET') {
            return await handleGetPlaybackHistory(supabase, url, user.user_id);
        }
        
        if (path === '/api/bhajans/status' && req.method === 'GET') {
            return await handleGetDeviceStatus(supabase, url, user.user_id);
        }
        
        // Not found
        return new Response(
            JSON.stringify({ error: 'Not found' }),
            {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        );
        
    } catch (error) {
        console.error('API Error:', error);
        return new Response(
            JSON.stringify({ 
                error: error instanceof Error ? error.message : 'Internal server error' 
            }),
            {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        );
    }
}

// GET /api/bhajans - Get all available bhajans
async function handleGetBhajans(supabase: any): Promise<Response> {
    try {
        const bhajans = await getAllBhajans(supabase);
        
        return new Response(
            JSON.stringify({ bhajans }),
            {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Error in handleGetBhajans:', error);
        throw error;
    }
}

// POST /api/bhajans/play - Play a bhajan on device
async function handlePlayBhajan(
    supabase: any, 
    req: Request, 
    userId: string
): Promise<Response> {
    try {
        const body = await req.json();
        const { deviceId, bhajanId } = body;
        
        if (!deviceId || !bhajanId) {
            return new Response(
                JSON.stringify({ error: 'Device ID and Bhajan ID are required' }),
                {
                    status: 400,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                }
            );
        }
        
        await playBhajanOnDevice(supabase, deviceId, bhajanId, userId);
        
        return new Response(
            JSON.stringify({ success: true, message: 'Bhajan started playing' }),
            {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Error in handlePlayBhajan:', error);
        throw error;
    }
}

// POST /api/bhajans/control - Control bhajan playback
async function handleControlBhajan(
    supabase: any, 
    req: Request, 
    userId: string
): Promise<Response> {
    try {
        const body = await req.json();
        const { deviceId, action } = body;
        
        if (!deviceId || !action) {
            return new Response(
                JSON.stringify({ error: 'Device ID and action are required' }),
                {
                    status: 400,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                }
            );
        }
        
        if (!['play', 'pause', 'stop', 'resume'].includes(action)) {
            return new Response(
                JSON.stringify({ error: 'Invalid action' }),
                {
                    status: 400,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                }
            );
        }
        
        await controlBhajanPlayback(supabase, deviceId, action, userId);
        
        return new Response(
            JSON.stringify({ success: true, message: `Bhajan ${action} successful` }),
            {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Error in handleControlBhajan:', error);
        throw error;
    }
}

// POST /api/bhajans/default - Set default bhajan
async function handleSetDefaultBhajan(
    supabase: any, 
    req: Request, 
    userId: string
): Promise<Response> {
    try {
        const body = await req.json();
        const { deviceId, bhajanId } = body;
        
        if (!deviceId || !bhajanId) {
            return new Response(
                JSON.stringify({ error: 'Device ID and Bhajan ID are required' }),
                {
                    status: 400,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                }
            );
        }
        
        await setDefaultBhajan(supabase, deviceId, bhajanId, userId);
        
        return new Response(
            JSON.stringify({ success: true, message: 'Default bhajan set successfully' }),
            {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Error in handleSetDefaultBhajan:', error);
        throw error;
    }
}

// GET /api/bhajans/history - Get playback history
async function handleGetPlaybackHistory(
    supabase: any, 
    url: URL, 
    userId: string
): Promise<Response> {
    try {
        const deviceId = url.searchParams.get('deviceId');
        const limit = parseInt(url.searchParams.get('limit') || '50');
        
        if (!deviceId) {
            return new Response(
                JSON.stringify({ error: 'Device ID is required' }),
                {
                    status: 400,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                }
            );
        }
        
        const history = await getPlaybackHistory(supabase, deviceId, userId, limit);
        
        return new Response(
            JSON.stringify({ history }),
            {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Error in handleGetPlaybackHistory:', error);
        throw error;
    }
}

// GET /api/bhajans/status - Get device bhajan status
async function handleGetDeviceStatus(
    supabase: any, 
    url: URL, 
    userId: string
): Promise<Response> {
    try {
        const deviceId = url.searchParams.get('deviceId');
        
        if (!deviceId) {
            return new Response(
                JSON.stringify({ error: 'Device ID is required' }),
                {
                    status: 400,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                }
            );
        }
        
        const status = await getDeviceBhajanStatus(supabase, deviceId);
        
        return new Response(
            JSON.stringify({ status }),
            {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Error in handleGetDeviceStatus:', error);
        throw error;
    }
}

// Start the server
if (import.meta.main) {
    console.log('Bhajan API server starting...');
    serve(handler, { port: 8001 });
}