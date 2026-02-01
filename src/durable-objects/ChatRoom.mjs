import { CONFIG } from '../utils/config.mjs';
import { handleErrors } from '../utils/errors.mjs';
import { hashIP } from '../utils/hash.mjs';
import { RateLimiterClient } from './RateLimiter.mjs';

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
