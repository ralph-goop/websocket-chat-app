// Edge Chat Demo with Room Registry and Stats - HIGH PERFORMANCE VERSION
// Optimized for scale: handles thousands of rooms and users efficiently

import HTML from "./chat.html";

// Constants for performance tuning
const CONFIG = {
  MAX_ROOMS_LISTED: 50,           // Pagination: only show top 50 rooms
  MAX_CONNECTIONS_PER_ROOM: 100,  // Prevent resource exhaustion
  MAX_MESSAGES_STORED: 1000,      // Retention: keep last 1000 messages per room
  RATE_LIMIT_WINDOW: 2,           // Seconds between messages
  RATE_LIMIT_GRACE: 15,           // Grace period in seconds
  ROOM_CACHE_TTL: 5000,           // Registry cache TTL in ms
  STATS_BATCH_INTERVAL: 30000,    // Batch stats updates every 30s
  MESSAGE_BATCH_SIZE: 100,        // Load last 100 messages initially
};

// Error handling utility
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

// Simple hash function for IP-based rate limiting
function hashIP(ip) {
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    const char = ip.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

// Main Worker export
export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

      switch (path[0]) {
        case "api":
          return handleApiRequest(path.slice(1), request, env);
        default:
          return new Response("Not found", {status: 404});
      }
    });
  }
}

// API request handler
async function handleApiRequest(path, request, env) {
  switch (path[0]) {
    case "rooms": {
      // Get room registry for listing all rooms
      let registryId = env.roomRegistry.idFromName("global");
      let registry = env.roomRegistry.get(registryId);
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(1).join("/");
      return registry.fetch(newUrl, request);
    }

    case "room": {
      if (!path[1]) {
        if (request.method == "POST") {
          let id = env.rooms.newUniqueId();
          return new Response(id.toString(), {headers: {"Access-Control-Allow-Origin": "*"}});
        } else if (request.method == "GET") {
          // Return list of public rooms from registry
          let registryId = env.roomRegistry.idFromName("global");
          let registry = env.roomRegistry.get(registryId);
          return registry.fetch(new URL("/list", request.url));
        } else {
          return new Response("Method not allowed", {status: 405});
        }
      }

      let name = path[1];
      let id;
      if (name.match(/^[0-9a-f]{64}$/)) {
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
        id = env.rooms.idFromName(name);
      } else {
        return new Response("Name too long", {status: 404});
      }

      let roomObject = env.rooms.get(id);
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");

      // Track room access in registry (fire and forget)
      if (path[2] === "websocket") {
        trackRoomAccess(env, name, id).catch(() => {});
      }

      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", {status: 404});
  }
}

// Track room access in registry (best effort, don't await)
async function trackRoomAccess(env, roomName, roomId) {
  try {
    let registryId = env.roomRegistry.idFromName("global");
    let registry = env.roomRegistry.get(registryId);
    await registry.fetch("https://internal/track", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        roomName: roomName,
        roomId: roomId.toString(),
        timestamp: Date.now()
      })
    });
  } catch (err) {
    // Silently fail - tracking is best-effort
  }
}

// RoomRegistry Durable Object - Tracks all rooms and their statistics
export class RoomRegistry {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    
    // In-memory cache for fast reads
    this.roomsCache = null;
    this.cacheExpiry = 0;
    this.lastCleanup = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/list": {
          // Get rooms with pagination - use cache for performance
          const now = Date.now();
          if (!this.roomsCache || now > this.cacheExpiry) {
            const rooms = await this.getTopRooms(CONFIG.MAX_ROOMS_LISTED);
            this.roomsCache = rooms;
            this.cacheExpiry = now + CONFIG.ROOM_CACHE_TTL;
            
            // Periodic cleanup of old room entries
            if (now - this.lastCleanup > 3600000) { // 1 hour
              this.lastCleanup = now;
              this.cleanupOldRooms().catch(() => {});
            }
          }
          
          return new Response(JSON.stringify(this.roomsCache), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=5"
            }
          });
        }

        case "/track": {
          if (request.method !== "POST") {
            return new Response("Method not allowed", {status: 405});
          }
          
          let data = await request.json();
          await this.trackRoom(data.roomName, data.roomId);
          return new Response("OK");
        }

        case "/update-stats": {
          if (request.method !== "POST") {
            return new Response("Method not allowed", {status: 405});
          }
          
          let data = await request.json();
          await this.updateRoomStats(data.roomId, data.stats);
          return new Response("OK");
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  async trackRoom(roomName, roomId) {
    let roomKey = `room:${roomId}`;
    let existing = await this.storage.get(roomKey);
    
    const now = Date.now();
    if (!existing) {
      await this.storage.put(roomKey, {
        name: roomName,
        id: roomId,
        createdAt: now,
        lastActivity: now,
        totalMessages: 0,
        uniquePosters: [], // Store as array for JSON serialization
        activeConnections: 0
      });
    } else {
      existing.lastActivity = now;
      await this.storage.put(roomKey, existing);
    }
    
    // Invalidate cache
    this.roomsCache = null;
  }

  async updateRoomStats(roomId, stats) {
    let roomKey = `room:${roomId}`;
    let room = await this.storage.get(roomKey);
    
    if (room) {
      room.totalMessages = stats.totalMessages || room.totalMessages;
      room.activeConnections = stats.activeConnections || room.activeConnections;
      
      // Merge unique posters efficiently
      const posterSet = new Set([...room.uniquePosters, ...stats.uniquePosters]);
      room.uniquePosters = Array.from(posterSet);
      
      room.lastActivity = Date.now();
      await this.storage.put(roomKey, room);
    }
    
    // Invalidate cache
    this.roomsCache = null;
  }

  async getTopRooms(limit) {
    // Get all room entries - this is O(n) but n should be manageable with cleanup
    let entries = await this.storage.list({prefix: "room:"});
    let rooms = [];
    
    for (let [key, room] of entries) {
      rooms.push({
        name: room.name,
        id: room.id,
        createdAt: room.createdAt,
        lastActivity: room.lastActivity,
        totalMessages: room.totalMessages || 0,
        uniquePosterCount: room.uniquePosters ? room.uniquePosters.length : 0,
        activeConnections: room.activeConnections || 0
      });
    }
    
    // Sort by last activity (most recent first)
    rooms.sort((a, b) => b.lastActivity - a.lastActivity);
    
    // Return only top N rooms for pagination
    return rooms.slice(0, limit);
  }

  async cleanupOldRooms() {
    // Remove rooms that haven't been active in 7 days
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let entries = await this.storage.list({prefix: "room:"});
    
    for (let [key, room] of entries) {
      if (room.lastActivity < cutoff && room.activeConnections === 0) {
        await this.storage.delete(key);
      }
    }
  }
}

// ChatRoom Durable Object - HIGH PERFORMANCE VERSION
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map();
    this.connectedUsers = new Set();
    
    // Restore sessions from hibernation
    this.state.getWebSockets().forEach((webSocket) => {
      let meta = webSocket.deserializeAttachment();
      if (meta.name) {
        this.connectedUsers.add(meta.name);
      }
      let limiterId = this.env.limiters.idFromName(meta.limiterId || "default");
      let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));
      let blockedMessages = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
    });

    this.lastTimestamp = 0;
    
    // Stats tracking - will be loaded from storage
    this.statsLoaded = false;
    this.totalMessages = 0;
    this.uniquePosters = new Set();
    
    // Batched stats reporting
    this.statsDirty = false;
    this.lastStatsReport = 0;
  }

  async loadStats() {
    if (this.statsLoaded) return;
    
    try {
      let stats = await this.storage.get("roomStats");
      if (stats) {
        this.totalMessages = stats.totalMessages || 0;
        this.uniquePosters = new Set(stats.uniquePosters || []);
      }
      this.statsLoaded = true;
    } catch (err) {
      this.statsLoaded = true;
    }
  }

  async saveStats() {
    try {
      await this.storage.put("roomStats", {
        totalMessages: this.totalMessages,
        uniquePosters: Array.from(this.uniquePosters),
        lastUpdated: Date.now()
      });
    } catch (err) {
      // Best effort
    }
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }

          // Check connection limit
          if (this.sessions.size >= CONFIG.MAX_CONNECTIONS_PER_ROOM) {
            return new Response("Room is full (max 100 users)", {status: 503});
          }

          let ip = request.headers.get("CF-Connecting-IP") || "unknown";
          let pair = new WebSocketPair();
          await this.handleSession(pair[1], ip);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        case "/stats": {
          await this.loadStats();
          let stats = {
            activeConnections: this.sessions.size,
            totalMessages: this.totalMessages,
            uniquePosters: Array.from(this.uniquePosters)
          };
          return new Response(JSON.stringify(stats), {
            headers: {"Content-Type": "application/json"}
          });
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  async handleSession(webSocket, ip) {
    await this.loadStats();
    
    this.state.acceptWebSocket(webSocket);

    // Use hashed IP for rate limiting to reduce DO count
    let hashedIP = hashIP(ip);
    let limiterId = this.env.limiters.idFromName(hashedIP);
    let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));

    let session = { limiterId: hashedIP, limiter, blockedMessages: [] };
    webSocket.serializeAttachment({ limiterId: hashedIP });
    this.sessions.set(webSocket, session);

    // Queue join messages for existing users
    for (let otherSession of this.sessions.values()) {
      if (otherSession.name && otherSession !== session) {
        session.blockedMessages.push(JSON.stringify({joined: otherSession.name}));
      }
    }

    // Load last N messages efficiently
    let storage = await this.storage.list({reverse: true, limit: CONFIG.MESSAGE_BATCH_SIZE});
    let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    });

    // Schedule stats update (batched)
    this.scheduleStatsUpdate();
  }

  async webSocketMessage(webSocket, msg) {
    try {
      await this.loadStats();
      
      let session = this.sessions.get(webSocket);
      if (session.quit) {
        webSocket.close(1011, "WebSocket broken.");
        return;
      }

      if (!session.limiter.checkLimit()) {
        webSocket.send(JSON.stringify({
          error: "Your IP is being rate-limited, please try again later."
        }));
        return;
      }

      let data = JSON.parse(msg);

      if (!session.name) {
        // First message - user info
        let requestedName = "" + (data.name || "anonymous");
        
        // Check if user with this name is already connected
        if (this.connectedUsers.has(requestedName)) {
          webSocket.send(JSON.stringify({error: "Username already in use. Please choose a different name."}));
          webSocket.close(1008, "Duplicate username");
          return;
        }
        
        session.name = requestedName;
        this.connectedUsers.add(session.name);
        webSocket.serializeAttachment({ 
          ...webSocket.deserializeAttachment(), 
          name: session.name 
        });

        if (session.name.length > 32) {
          webSocket.send(JSON.stringify({error: "Name too long."}));
          webSocket.close(1009, "Name too long.");
          return;
        }

        // Deliver queued messages
        session.blockedMessages.forEach(queued => {
          webSocket.send(queued);
        });
        delete session.blockedMessages;

        // Broadcast join
        this.broadcast({joined: session.name});
        webSocket.send(JSON.stringify({ready: true}));
        
        // Schedule stats update
        this.scheduleStatsUpdate();
        return;
      }

      // Regular chat message
      data = { name: session.name, message: "" + data.message };

      if (data.message.length > 256) {
        webSocket.send(JSON.stringify({error: "Message too long."}));
        return;
      }

      // Track stats
      this.totalMessages++;
      this.uniquePosters.add(session.name);
      this.statsDirty = true;

      data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = data.timestamp;

      let dataStr = JSON.stringify(data);
      
      // Broadcast immediately for speed
      this.broadcast(dataStr);

      // Save message asynchronously with retention
      this.saveMessageWithRetention(data.timestamp, dataStr);
      
      // Schedule stats update (batched)
      this.scheduleStatsUpdate();
    } catch (err) {
      webSocket.send(JSON.stringify({error: err.stack}));
    }
  }

  async saveMessageWithRetention(timestamp, dataStr) {
    try {
      let key = new Date(timestamp).toISOString();
      await this.storage.put(key, dataStr);
      
      // Enforce retention limit asynchronously
      this.enforceRetention().catch(() => {});
    } catch (err) {
      console.error("Failed to save message:", err);
    }
  }

  async enforceRetention() {
    try {
      // Count messages
      let count = 0;
      let oldestKeys = [];
      
      let entries = await this.storage.list();
      for (let [key, value] of entries) {
        if (key !== "roomStats") {
          count++;
          oldestKeys.push(key);
        }
      }
      
      // Sort to find oldest
      oldestKeys.sort();
      
      // Delete oldest if over limit
      while (count > CONFIG.MAX_MESSAGES_STORED && oldestKeys.length > 0) {
        let keyToDelete = oldestKeys.shift();
        await this.storage.delete(keyToDelete);
        count--;
      }
    } catch (err) {
      // Best effort
    }
  }

  scheduleStatsUpdate() {
    const now = Date.now();
    if (!this.statsDirty || now - this.lastStatsReport < CONFIG.STATS_BATCH_INTERVAL) {
      return;
    }
    
    this.statsDirty = false;
    this.lastStatsReport = now;
    
    // Save to storage and report to registry asynchronously
    this.saveStats().catch(() => {});
    this.reportStatsToRegistry().catch(() => {});
  }

  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(webSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
    if (session.name) {
      this.connectedUsers.delete(session.name);
      this.broadcast({quit: session.name});
    }
    
    // Schedule stats update
    this.scheduleStatsUpdate();
  }

  async webSocketClose(webSocket, code, reason, wasClean) {
    this.closeOrErrorHandler(webSocket);
  }

  async webSocketError(webSocket, error) {
    this.closeOrErrorHandler(webSocket);
  }

  broadcast(message) {
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    let quitters = [];
    this.sessions.forEach((session, webSocket) => {
      if (session.name) {
        try {
          webSocket.send(message);
        } catch (err) {
          session.quit = true;
          quitters.push(session);
          this.sessions.delete(webSocket);
        }
      } else {
        session.blockedMessages.push(message);
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({quit: quitter.name});
      }
    });
  }

  async reportStatsToRegistry() {
    try {
      let roomId = this.state.id.toString();
      let registryId = this.env.roomRegistry.idFromName("global");
      let registry = this.env.roomRegistry.get(registryId);
      
      await registry.fetch("https://internal/update-stats", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          roomId: roomId,
          stats: {
            totalMessages: this.totalMessages,
            activeConnections: this.sessions.size,
            uniquePosters: Array.from(this.uniquePosters)
          }
        })
      });
    } catch (err) {
      // Best effort
    }
  }
}

// RateLimiter Durable Object - Optimized with configurable limits
export class RateLimiter {
  constructor(state, env) {
    this.nextAllowedTime = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;
      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

      if (request.method == "POST") {
        this.nextAllowedTime += CONFIG.RATE_LIMIT_WINDOW;
      }

      let cooldown = Math.max(0, this.nextAllowedTime - now - CONFIG.RATE_LIMIT_GRACE);
      return new Response(cooldown.toString());
    });
  }
}

// RateLimiterClient
class RateLimiterClient {
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;
    this.limiter = getLimiterStub();
    this.inCooldown = false;
  }

  checkLimit() {
    if (this.inCooldown) {
      return false;
    }
    this.inCooldown = true;
    this.callLimiter();
    return true;
  }

  async callLimiter() {
    try {
      let response;
      try {
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      } catch (err) {
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      }

      let cooldown = +(await response.text());
      await new Promise(resolve => setTimeout(resolve, cooldown * 1000));
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
    }
  }
}
