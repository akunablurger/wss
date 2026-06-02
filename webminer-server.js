const express = require('express');
const http = require('http');
const https = require('https');
const socketIO = require('socket.io');
const net = require('net');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Determine if using SSL
const useSSL = process.env.USE_SSL === 'true';
let server;

if (useSSL) {
    // For SSL (WSS)
    try {
        const options = {
            key: fs.readFileSync(process.env.SSL_KEY || '/etc/letsencrypt/live/websocket.yourdomain/privkey.pem'),
            cert: fs.readFileSync(process.env.SSL_CERT || '/etc/letsencrypt/live/websocket.yourdomain/fullchain.pem')
        };
        server = https.createServer(options, app);
        console.log('✓ SSL/TLS enabled (WSS)');
    } catch (error) {
        console.error('SSL certificate not found:', error.message);
        console.log('Falling back to HTTP...');
        server = http.createServer(app);
    }
} else {
    server = http.createServer(app);
    console.log('✓ Running on HTTP/WS (no SSL)');
}

const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

// Stratum connection pool
const stratumPool = new Map();
let workers = new Map();

class StratumConnection {
    constructor(poolConfig) {
        this.config = poolConfig;
        this.socket = null;
        this.isConnected = false;
        this.currentWork = null;
        this.submittedShares = new Set();
        this.connect();
    }

    connect() {
        this.socket = net.createConnection({
            host: this.config.server,
            port: this.config.port
        });

        this.socket.on('connect', () => {
            console.log(`Connected to pool: ${this.config.server}:${this.config.port}`);
            this.isConnected = true;
            this.authenticate();
        });

        this.socket.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    try {
                        const message = JSON.parse(line);
                        this.handlePoolMessage(message);
                    } catch (e) {
                        console.error('Parse error:', e);
                    }
                }
            });
        });

        this.socket.on('error', (err) => {
            console.error('Pool connection error:', err);
            this.isConnected = false;
        });

        this.socket.on('close', () => {
            console.log('Pool connection closed');
            this.isConnected = false;
            setTimeout(() => this.connect(), 5000); // Reconnect after 5s
        });
    }

    authenticate() {
        const auth = {
            id: 1,
            method: "mining.subscribe",
            params: ["web-miner/1.0", null],
            jsonrpc: "2.0"
        };
        this.send(auth);

        const login = {
            id: 2,
            method: "mining.authorize",
            params: [this.config.worker, this.config.password || "x"],
            jsonrpc: "2.0"
        };
        this.send(login);
    }

    send(data) {
        if (this.socket && this.isConnected) {
            this.socket.write(JSON.stringify(data) + '\n');
        }
    }

    handlePoolMessage(message) {
        if (message.method === "mining.notify") {
            this.currentWork = {
                jobId: message.params[0],
                prevHash: message.params[1],
                coinb1: message.params[2],
                coinb2: message.params[3],
                merkleBranch: message.params[4],
                version: message.params[5],
                bits: message.params[6],
                time: message.params[7],
                clean: message.params[8]
            };
            // Broadcast work to all connected clients
            io.emit('work', this.currentWork);
        }

        if (message.method === "mining.set_difficulty") {
            const difficulty = message.params[0];
            io.emit('difficulty', { difficulty });
        }

        if (message.result && message.id === 2) {
            io.emit('can start');
        }
    }

    submitShare(shareData) {
        const submit = {
            id: Date.now(),
            method: "mining.submit",
            params: [
                this.config.worker,
                shareData.jobId,
                shareData.extraNonce2,
                shareData.ntime,
                shareData.nonce
            ],
            jsonrpc: "2.0"
        };
        this.send(submit);
    }
}

// Handle client connections
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    workers.set(socket.id, {
        id: socket.id,
        connectedAt: Date.now(),
        algo: null,
        hashrate: 0,
        sharesSubmitted: 0,
        sharesAccepted: 0,
        sharesFailed: 0
    });

    socket.on('start', (data) => {
        console.log('Start mining:', data);
        
        const poolKey = `${data.stratum.server}:${data.stratum.port}`;
        
        // Create or reuse pool connection
        if (!stratumPool.has(poolKey)) {
            stratumPool.set(poolKey, new StratumConnection(data.stratum));
        }

        const poolConn = stratumPool.get(poolKey);
        
        // Update worker info
        const worker = workers.get(socket.id);
        worker.algo = data.algo;
        worker.poolKey = poolKey;

        // Send current work if available
        if (poolConn.currentWork) {
            socket.emit('work', poolConn.currentWork);
        }
    });

    socket.on('submit', (data) => {
        console.log('Share submitted:', data);
        
        const worker = workers.get(socket.id);
        if (worker && worker.poolKey) {
            const poolConn = stratumPool.get(worker.poolKey);
            if (poolConn) {
                poolConn.submitShare(data);
                worker.sharesSubmitted++;
                worker.sharesAccepted++;
            }
        }
    });

    socket.on('hashrate', (data) => {
        const worker = workers.get(socket.id);
        if (worker) {
            worker.hashrate = data.hashrate;
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        workers.delete(socket.id);
    });

    socket.on('error', (error) => {
        console.log('Socket error:', error);
        socket.emit('error', { error: error.message });
    });
});

// REST API endpoints
app.get('/api/stats', (req, res) => {
    const stats = {
        connectedWorkers: workers.size,
        totalHashrate: Array.from(workers.values()).reduce((sum, w) => sum + parseFloat(w.hashrate || 0), 0),
        workers: Array.from(workers.values())
    };
    res.json(stats);
});

app.get('/api/worker/:id', (req, res) => {
    const worker = workers.get(req.params.id);
    if (worker) {
        res.json(worker);
    } else {
        res.status(404).json({ error: 'Worker not found' });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// Start server
const PORT = process.env.PORT || (useSSL ? 443 : 3000);
server.listen(PORT, () => {
    const protocol = useSSL ? 'WSS' : 'WS';
    console.log(`╔════════════════════════════════════════╗`);
    console.log(`║   ${protocol} Miner Server`);
    console.log(`║   Listening on port ${PORT}`);
    console.log(`╚════════════════════════════════════════╝`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    stratumPool.forEach(conn => conn.socket.destroy());
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
