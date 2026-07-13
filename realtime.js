const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const url = require("url");

const connections = new Map(); // userId -> Set of ws sockets

function setupRealtime(server) {
  const wss = new WebSocketServer({ server, path: "/v1/realtime" });

  wss.on("connection", (ws, req) => {
    const { query } = url.parse(req.url, true);
    let userId = null;
    try {
      const payload = jwt.verify(query.token, process.env.JWT_ACCESS_SECRET);
      userId = payload.sub;
    } catch {
      ws.close(4001, "توکن نامعتبر");
      return;
    }

    if (!connections.has(userId)) connections.set(userId, new Set());
    connections.get(userId).add(ws);

    ws.on("close", () => {
      connections.get(userId)?.delete(ws);
    });
  });

  return wss;
}

function broadcastToUser(userId, type, payload) {
  const sockets = connections.get(userId?.toString());
  if (!sockets) return;
  const message = JSON.stringify({ type, payload });
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(message);
  }
}

module.exports = { setupRealtime, broadcastToUser };
