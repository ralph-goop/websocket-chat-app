// Constants for performance tuning
export const CONFIG = {
  MAX_ROOMS_LISTED: 50,           // Pagination: only show top 50 rooms
  MAX_CONNECTIONS_PER_ROOM: 100,  // Prevent resource exhaustion
  MAX_MESSAGES_STORED: 1000,      // Retention: keep last 1000 messages per room
  RATE_LIMIT_WINDOW: 2,           // Seconds between messages
  RATE_LIMIT_GRACE: 15,           // Grace period in seconds
  ROOM_CACHE_TTL: 5000,           // Registry cache TTL in ms
  STATS_BATCH_INTERVAL: 30000,    // Batch stats updates every 30s
  MESSAGE_BATCH_SIZE: 100,        // Load last 100 messages initially
};
