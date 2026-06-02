#!/bin/bash

# Start WebMiner dengan WSS (WebSocket Secure)

echo "╔════════════════════════════════════════╗"
echo "║   Starting WSS WebSocket Server        ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Load environment
if [ -f .env ]; then
    export $(cat .env | grep -v '#' | xargs)
fi

TUNNEL_NAME="${TUNNEL_NAME:-websocket}"

echo "Starting WebMiner Server..."
pm2 start ecosystem.config.js

# Wait for server to start
sleep 2

# Check if server is running
if pm2 list | grep -q "webminer"; then
    echo "✓ WebMiner server started"
else
    echo "✗ Failed to start WebMiner server"
    pm2 logs webminer
    exit 1
fi

echo ""
echo "Starting Cloudflare Tunnel (WSS)..."
echo "Tunnel: $TUNNEL_NAME"
echo ""

# Start Cloudflare Tunnel
cloudflared tunnel run "$TUNNEL_NAME" &

sleep 3

echo ""
echo "╔════════════════════════════════════════╗"
echo "║   ✓ WSS Server Running!                ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Access:"
echo "  WebSocket: wss://$TUNNEL_NAME.yourdomain.com"
echo "  Health:    https://$TUNNEL_NAME.yourdomain.com/health"
echo "  Stats:     https://$TUNNEL_NAME.yourdomain.com/api/stats"
echo ""
echo "Logs:"
echo "  WebMiner: pm2 logs webminer"
echo "  Tunnel:   above (Ctrl+C to stop)"
echo ""

wait
