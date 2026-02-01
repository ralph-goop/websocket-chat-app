// Edge Chat Demo with Room Registry and Stats
// This is an enhanced version of the Cloudflare Workers chat demo with room listings and statistics

import HTML from "./chat.html";

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

      // Track room access in registry
      if (path[2] === "websocket") {
        await trackRoomAccess(env, name, id);
      }

      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", {status: 404});
  }
}

// Track room access in registry
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
    console.error("Failed to track room access:", err);
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
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/list": {
          // Get all rooms with stats - use cache for performance
          const now = Date.now();
          if (!this.roomsCache || now > this.cacheExpiry) {
            const rooms = await this.getAllRoomsWithStats();
            this.roomsCache = rooms;
            this.cacheExpiry = now + 5000; // Cache for 5 seconds
          }
          
          return new Response(JSON.stringify(this.roomsCache), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-cache"
            }
          });
        }

        case "/track": {
          // Track that a room is being accessed
          if (request.method !== "POST") {
            return new Response("Method not allowed", {status: 405});
          }
          
          let data = await request.json();
          await this.trackRoom(data.roomName, data.roomId);
          return new Response("OK");
        }

        case "/update-stats": {
          // Update room statistics from ChatRoom
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
    
    if (!existing) {
      await this.storage.put(roomKey, {
        name: roomName,
        id: roomId,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        totalMessages: 0,
        uniquePosters: new Set(),
        activeConnections: 0
      });
    } else {
      existing.lastActivity = Date.now();
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
      room.uniquePosters = new Set([...(room.uniquePosters || []), ...(stats.uniquePosters || [])]);
      room.lastActivity = Date.now();
      await this.storage.put(roomKey, room);
    }
    
    // Invalidate cache
    this.roomsCache = null;
  }

  async getAllRoomsWithStats() {
    // Get all room entries
    let rooms = [];
    let entries = await this.storage.list({prefix: "room:"});
    
    for (let [key, room] of entries) {
      // Get real-time stats from the actual room
      try {
        let roomObject = this.env.rooms.get(this.env.rooms.idFromString(room.id));
        let statsResponse = await roomObject.fetch("https://internal/stats");
        if (statsResponse.ok) {
          let liveStats = await statsResponse.json();
          room.activeConnections = liveStats.activeConnections || 0;
          room.totalMessages = liveStats.totalMessages || room.totalMessages;
          room.uniquePosters = new Set([...(room.uniquePosters || []), ...(liveStats.uniquePosters || [])]);
        }
      } catch (err) {
        // Room might not exist yet, use stored stats
      }
      
      rooms.push({
        name: room.name,
        id: room.id,
        createdAt: room.createdAt,
        lastActivity: room.lastActivity,
        totalMessages: room.totalMessages || 0,
        uniquePosterCount: room.uniquePosters ? room.uniquePosters.size : 0,
        activeConnections: room.activeConnections || 0
      });
    }
    
    // Sort by last activity (most recent first)
    rooms.sort((a, b) => b.lastActivity - a.lastActivity);
    
    return rooms;
  }
}

// ChatRoom Durable Object - Enhanced with stats tracking
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map();
    
    // Restore sessions from hibernation
    this.state.getWebSockets().forEach((webSocket) => {
      let meta = webSocket.deserializeAttachment();
      let limiterId = this.env.limiters.idFromString(meta.limiterId);
      let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));
      let blockedMessages = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
    });

    this.lastTimestamp = 0;
    
    // Stats tracking
    this.totalMessages = 0;
    this.uniquePosters = new Set();
    this.messageHistory = [];
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }

          let ip = request.headers.get("CF-Connecting-IP");
          let pair = new WebSocketPair();
          await this.handleSession(pair[1], ip);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        case "/stats": {
          // Return current stats for this room
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
    this.state.acceptWebSocket(webSocket);

    let limiterId = this.env.limiters.idFromName(ip);
    let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));

    let session = { limiterId, limiter, blockedMessages: [] };
    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), limiterId: limiterId.toString() });
    this.sessions.set(webSocket, session);

    // Queue join messages for existing users
    for (let otherSession of this.sessions.values()) {
      if (otherSession.name && otherSession !== session) {
        session.blockedMessages.push(JSON.stringify({joined: otherSession.name}));
      }
    }

    // Load last 100 messages
    let storage = await this.storage.list({reverse: true, limit: 100});
    let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    });

    // Report stats update to registry
    await this.reportStatsToRegistry();
  }

  async webSocketMessage(webSocket, msg) {
    try {
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
        session.name = "" + (data.name || "anonymous");
        webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });

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
        
        // Report stats update
        await this.reportStatsToRegistry();
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

      data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = data.timestamp;

      let dataStr = JSON.stringify(data);
      this.broadcast(dataStr);

      // Save message
      let key = new Date(data.timestamp).toISOString();
      await this.storage.put(key, dataStr);
      
      // Report stats update
      await this.reportStatsToRegistry();
    } catch (err) {
      webSocket.send(JSON.stringify({error: err.stack}));
    }
  }

  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(webSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
    if (session.name) {
      this.broadcast({quit: session.name});
    }
    // Report stats update
    await this.reportStatsToRegistry();
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
      // Get room ID from state
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
      // Silently fail - registry updates are best-effort
      console.error("Failed to report stats:", err);
    }
  }
}

// RateLimiter Durable Object
export class RateLimiter {
  constructor(state, env) {
    this.nextAllowedTime = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;
      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

      if (request.method == "POST") {
        this.nextAllowedTime += 5;
      }

      let cooldown = Math.max(0, this.nextAllowedTime - now - 20);
      return new Response(cooldown);
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
