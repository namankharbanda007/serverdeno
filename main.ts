// Fixed server-deno main.ts for Deno Deploy compatibility
import { Hono } from "https://deno.land/x/hono@v3.11.7/mod.ts";
import { cors } from "https://deno.land/x/hono@v3.11.7/middleware.ts";
import { getSupabaseClient } from './supabase.ts';
import { authenticateUser } from './utils.ts';
import { addConnection, removeConnection } from './realtime/connections.ts';

const app = new Hono();

// Enable CORS for all origins (adjust for production)
app.use("*", cors());

// Health check endpoint
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// Root endpoint
app.get("/", (c) => c.text("Dev Vani Server is running!"));

// Bhajan feature endpoints
app.get("/api/bhajans", async (c) => {
  try {
    // Example bhajan data - in production, fetch from external source
    const bhajans = [
      {
        id: 1,
        title: "Om Jai Jagadish Hare",
        artist: "Traditional",
        duration: "5:30",
        category: "Aarti"
      },
      {
        id: 2,
        title: "Hanuman Chalisa",
        artist: "Traditional",
        duration: "8:45",
        category: "Stotra"
      },
      {
        id: 3,
        title: "Gayatri Mantra",
        artist: "Traditional",
        duration: "3:15",
        category: "Mantra"
      }
    ];

    return c.json({
      success: true,
      data: bhajans,
      count: bhajans.length
    });
  } catch (error) {
    console.error("Error fetching bhajans:", error);
    return c.json({
      success: false,
      error: "Failed to fetch bhajans",
      message: error.message
    }, 500);
  }
});

// Get specific bhajan by ID
app.get("/api/bhajans/:id", async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    
    // Example data - replace with actual database/API call
    const bhajan = {
      id: id,
      title: "Om Namah Shivaya",
      artist: "Traditional",
      duration: "4:20",
      category: "Mantra",
      lyrics: "Om Namah Shivaya Om Namah Shivaya...",
      audioUrl: "https://example.com/audio/om-namah-shivaya.mp3"
    };

    if (!bhajan) {
      return c.json({
        success: false,
        error: "Bhajan not found"
      }, 404);
    }

    return c.json({
      success: true,
      data: bhajan
    });
  } catch (error) {
    console.error("Error fetching bhajan:", error);
    return c.json({
      success: false,
      error: "Failed to fetch bhajan",
      message: error.message
    }, 500);
  }
});

// Search bhajans
app.get("/api/bhajans/search", async (c) => {
  try {
    const query = c.req.query("q") || "";
    const category = c.req.query("category") || "";
    
    // Example search logic - replace with actual search implementation
    const allBhajans = [
      { id: 1, title: "Om Jai Jagadish Hare", artist: "Traditional", category: "Aarti" },
      { id: 2, title: "Hanuman Chalisa", artist: "Traditional", category: "Stotra" },
      { id: 3, title: "Gayatri Mantra", artist: "Traditional", category: "Mantra" },
      { id: 4, title: "Sai Bhajan", artist: "Traditional", category: "Aarti" }
    ];

    let results = allBhajans;

    if (query) {
      results = results.filter(bhajan => 
        bhajan.title.toLowerCase().includes(query.toLowerCase()) ||
        bhajan.artist.toLowerCase().includes(query.toLowerCase())
      );
    }

    if (category) {
      results = results.filter(bhajan => 
        bhajan.category.toLowerCase() === category.toLowerCase()
      );
    }

    return c.json({
      success: true,
      data: results,
      query,
      category,
      count: results.length
    });
  } catch (error) {
    console.error("Error searching bhajans:", error);
    return c.json({
      success: false,
      error: "Failed to search bhajans",
      message: error.message
    }, 500);
  }
});

// Categories endpoint
app.get("/api/categories", async (c) => {
  try {
    const categories = ["Aarti", "Stotra", "Mantra", "Kirtan", "Bhajan"];
    
    return c.json({
      success: true,
      data: categories
    });
  } catch (error) {
    console.error("Error fetching categories:", error);
    return c.json({
      success: false,
      error: "Failed to fetch categories",
      message: error.message
    }, 500);
  }
});

// Export the Hono app for Deno Deploy
// This is the key fix - don't use app.listen(), just export the app
export default app;

// Deno Deploy compatible WebSocket endpoint for bhajan control
// Route: /ws/device/:deviceId/bhajan
app.get('/ws/device/:deviceId/bhajan', async (c) => {
  const deviceId = c.req.param('deviceId');
  const request = c.req;

  // Simple auth: check Authorization header and validate user. If you have different auth flow, adapt.
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');

  if (!token) {
    return c.text('Unauthorized', 401);
  }

  try {
    const supabase = getSupabaseClient(token);
    await authenticateUser(supabase, token);
  } catch (err) {
    console.warn('WebSocket auth failed', err);
    return c.text('Unauthorized', 401);
  }

  // Upgrade to WebSocket using WebSocketPair (supported in Deno Deploy)
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  // Accept the server side and register
  try {
    (server as any).accept?.();
  } catch (e) {
    // Some runtimes require server.accept(); ignore if not available
  }

  const connKey = `${deviceId}-bhajan`;
  addConnection(connKey, server);
  console.log(`Registered bhajan websocket for ${connKey}`);

  server.onmessage = (evt: any) => {
    try {
      const data = typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data);
      const msg = JSON.parse(data);
      if (msg && msg.type && msg.type.startsWith('bhajan')) {
        console.log(`Received bhajan message from device ${connKey}:`, msg.type);
      }
    } catch (e) {
      console.error('Error parsing ws message', e);
    }
  };

  server.onclose = () => {
    try {
      removeConnection(connKey);
      console.log(`Bhajan websocket closed for ${connKey}`);
    } catch (e) {
      console.warn('Error removing connection', e);
    }
  };

  // Return the client side to complete the upgrade
  return new Response(null, { status: 101, webSocket: client as any });
});