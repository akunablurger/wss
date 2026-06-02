#!/bin/bash

# Setup WSS (WebSocket Secure) dengan Cloudflare Tunnel

set -e

echo "╔════════════════════════════════════════╗"
echo "║   WSS (WebSocket Secure) Setup         ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo "Installing Cloudflare Tunnel..."
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
        sudo dpkg -i cloudflared.deb
        rm cloudflared.deb
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        brew install cloudflare/cloudflare/cloudflared
    fi
fi

echo "✓ Cloudflared installed"
echo ""

# Authenticate
echo "Step 1: Authenticate dengan Cloudflare"
cloudflared tunnel login

echo ""
echo "Step 2: Create tunnel untuk WebSocket"
read -p "Enter tunnel name (default: websocket): " TUNNEL_NAME
TUNNEL_NAME=${TUNNEL_NAME:-websocket}

cloudflared tunnel create "$TUNNEL_NAME"

echo ""
echo "Step 3: Configure tunnel untuk WSS"
read -p "Enter domain (e.g., yourdomain.com): " DOMAIN
read -p "Enter subdomain (default: websocket): " SUBDOMAIN
SUBDOMAIN=${SUBDOMAIN:-websocket}
FULL_HOSTNAME="${SUBDOMAIN}.${DOMAIN}"

# Create config file
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << EOF
tunnel: $TUNNEL_NAME
credentials-file: ~/.cloudflared/${TUNNEL_NAME}.json
ingress:
  - hostname: $FULL_HOSTNAME
    service: http://localhost:3000
  - service: http_status:404
EOF

echo "✓ Config created: ~/.cloudflared/config.yml"
echo ""

# Route the tunnel
echo "Step 4: Route tunnel to Cloudflare DNS..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$FULL_HOSTNAME"

# Update .env file
cat > .env << EOF
PORT=3000
USE_SSL=false
NODE_ENV=production
TUNNEL_DOMAIN=$FULL_HOSTNAME
EOF

echo ""
echo "╔════════════════════════════════════════╗"
echo "║   ✓ WSS Setup Complete!                ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Your WebSocket Server:"
echo "  WSS: wss://$FULL_HOSTNAME"
echo "  HTTP: http://localhost:3000"
echo "  API Stats: https://$FULL_HOSTNAME/api/stats"
echo ""
echo "Update client code:"
echo "  socket = io(\"wss://$FULL_HOSTNAME\", { "
echo "      transports: ['websocket']"
echo "  });"
echo ""
echo "To start:"
echo "  1. Start server:  pm2 start ecosystem.config.js"
echo "  2. Start tunnel:  cloudflared tunnel run $TUNNEL_NAME"
echo ""
echo "Or combined:"
echo "  ./start-wss.sh"
echo ""
