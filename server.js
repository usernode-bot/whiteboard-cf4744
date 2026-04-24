const express = require('express');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 10000,
});
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// JWT auth middleware for HTTP
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// JWT auth middleware for Socket.IO
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token && JWT_SECRET) {
    try {
      socket.user = jwt.verify(token, JWT_SECRET);
      return next();
    } catch {}
  }
  next(new Error('Not authenticated'));
});

// Track connected users: socketId -> { id, username, color, cursor }
const connectedUsers = new Map();

// Assign a color to each user based on a palette
const USER_COLORS = [
  '#f472b6', '#a78bfa', '#60a5fa', '#34d399', '#fbbf24',
  '#fb923c', '#f87171', '#e879f9', '#22d3ee', '#a3e635',
];
let colorIndex = 0;

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/iq-1000', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'iq-1000.html'));
});

// Get all strokes for initial canvas load
app.get('/api/strokes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, username, color, width, points, tool, emoji
       FROM strokes ORDER BY id ASC`
    );
    // Parse points from JSON string
    const strokes = rows.map(r => ({
      ...r,
      points: typeof r.points === 'string' ? JSON.parse(r.points) : r.points,
    }));
    res.json({ strokes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all strokes
app.post('/api/clear', async (req, res) => {
  try {
    await pool.query('DELETE FROM strokes');
    io.emit('board-cleared');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  const user = socket.user;
  const userColor = USER_COLORS[colorIndex % USER_COLORS.length];
  colorIndex++;

  connectedUsers.set(socket.id, {
    id: user.id,
    username: user.username,
    color: userColor,
  });

  // Broadcast updated user list
  io.emit('users-updated', Array.from(connectedUsers.values()));

  // Handle drawing - receive stroke segments and broadcast to others
  socket.on('draw-start', (data) => {
    socket.broadcast.emit('draw-start', {
      socketId: socket.id,
      username: user.username,
      ...data,
    });
  });

  socket.on('draw-move', (data) => {
    socket.broadcast.emit('draw-move', {
      socketId: socket.id,
      ...data,
    });
  });

  socket.on('draw-end', async (data) => {
    socket.broadcast.emit('draw-end', { socketId: socket.id });

    // Persist the completed stroke
    if (data && data.points && data.points.length > 0) {
      try {
        await pool.query(
          `INSERT INTO strokes (user_id, username, color, width, points, tool)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [user.id, user.username, data.color, data.width, JSON.stringify(data.points), data.tool || 'pen']
        );
      } catch (err) {
        console.error('Failed to save stroke:', err.message);
      }
    }
  });

  // Cursor position updates
  socket.on('cursor-move', (data) => {
    socket.broadcast.emit('cursor-move', {
      socketId: socket.id,
      username: user.username,
      color: userColor,
      x: data.x,
      y: data.y,
    });
  });

  socket.on('emoji-place', async (data) => {
    socket.broadcast.emit('emoji-place', { socketId: socket.id, ...data });
    try {
      await pool.query(
        `INSERT INTO strokes (user_id, username, color, width, points, tool, emoji)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [user.id, user.username, '#000000', data.size || 36,
         JSON.stringify([{ x: data.x, y: data.y }]), 'emoji', data.emoji]
      );
    } catch (err) {
      console.error('Failed to save emoji stamp:', err.message);
    }
  });

  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    io.emit('users-updated', Array.from(connectedUsers.values()));
    socket.broadcast.emit('cursor-remove', { socketId: socket.id });
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://usernode.evanshapiro.dev" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS presses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS strokes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      color VARCHAR(32) NOT NULL DEFAULT '#000000',
      width REAL NOT NULL DEFAULT 3,
      points JSONB NOT NULL,
      tool VARCHAR(32) NOT NULL DEFAULT 'pen',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE strokes ADD COLUMN IF NOT EXISTS emoji TEXT`);

  server.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
