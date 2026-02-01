// Track room access in registry (best effort, don't await)
export async function trackRoomAccess(env, roomName, roomId) {
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
