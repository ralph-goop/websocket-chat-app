// API request handler
export async function handleApiRequest(path, request, env) {
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
        const { trackRoomAccess } = await import('./roomTracker.mjs');
        trackRoomAccess(env, name, id).catch(() => {});
      }

      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", {status: 404});
  }
}
