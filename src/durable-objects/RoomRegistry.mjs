import { CONFIG } from '../utils/config.mjs';
import { handleErrors } from '../utils/errors.mjs';

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
