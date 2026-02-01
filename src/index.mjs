// Edge Chat Demo with Room Registry and Stats - HIGH PERFORMANCE VERSION
// Optimized for scale: handles thousands of rooms and users efficiently

import HTML from "./chat.html";
import { handleErrors } from './utils/errors.mjs';
import { handleApiRequest } from './handlers/api.mjs';
import { RoomRegistry } from './durable-objects/RoomRegistry.mjs';
import { ChatRoom } from './durable-objects/ChatRoom.mjs';
import { RateLimiter } from './durable-objects/RateLimiter.mjs';

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

// Export Durable Object classes
export { RoomRegistry, ChatRoom, RateLimiter };
