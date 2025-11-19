// Helper to install a bhajan WebSocket upgrade handler.
// Usage: import { registerBhajanUpgradeHandler } from './ws_upgrade.ts';
// Then call registerBhajanUpgradeHandler({ server, wss, getSupabaseClient, authenticateUser, addConnection, removeConnection });

export function registerBhajanUpgradeHandler(opts: any) {
  const { server, wss, getSupabaseClient, authenticateUser, addConnection, removeConnection } = opts;

  if (!server || !wss) {
    console.warn('registerBhajanUpgradeHandler: server or wss not provided — skipping registration');
    return;
  }

  server.on('upgrade', async (req: any, socket: any, head: any) => {
    try {
      const url = new URL(req.url);

      // Only handle bhajan-specific websocket paths here
      if (!url.pathname.startsWith('/ws/device/') || !url.pathname.includes('/bhajan')) {
        return;
      }

      // Authenticate request if helpers are provided
      let user: any;
      let supabase: any;
      try {
        const authHeader = req.headers['authorization'] || req.headers['Authorization'];
        const authToken = authHeader ? authHeader.replace('Bearer ', '') : '';
        if (!authToken) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        if (getSupabaseClient && authenticateUser) {
          supabase = getSupabaseClient(authToken);
          user = await authenticateUser(supabase, authToken);
        }
      } catch (_e) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const deviceId = url.pathname.split('/')[3];
      const connKey = `${deviceId}-bhajan`;

      wss.handleUpgrade(req, socket, head, (ws: any) => {
        try {
          if (addConnection) addConnection(connKey, ws);
          console.log(`Registered bhajan websocket for ${connKey}`);
        } catch (e) {
          console.warn('Failed to add connection to map:', e);
        }

        ws.on('message', (data: any) => {
          try {
            const message = JSON.parse(data.toString());
            // Server-side handling of device-originated messages can go here.
            // For now we simply log device bhajan messages.
            if (message && message.type && message.type.startsWith('bhajan')) {
              console.log(`Device ${connKey} sent bhajan message:`, message.type);
            }
          } catch (error) {
            console.error('Error handling bhajan incoming message:', error);
          }
        });

        ws.on('close', () => {
          try {
            if (removeConnection) removeConnection(connKey);
            console.log(`Removed bhajan websocket for ${connKey}`);
          } catch (e) {
            console.warn('Failed to remove connection:', e);
          }
        });
      });
    } catch (err) {
      console.error('Error in upgrade handler:', err);
    }
  });
}

export default registerBhajanUpgradeHandler;
