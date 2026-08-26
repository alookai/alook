export const USER_WS_CONNECTION_VALIDATION_NONCE_MAX_LENGTH = 64;

export type UserWsConnectionPing = {
  type: "connection.ping";
  nonce: string;
};

export type UserWsConnectionPong = {
  type: "connection.pong";
  nonce: string;
};

function isConnectionValidationFrame(
  value: unknown,
  type: UserWsConnectionPing["type"] | UserWsConnectionPong["type"],
): value is UserWsConnectionPing | UserWsConnectionPong {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return Object.keys(frame).length === 2
    && frame.type === type
    && typeof frame.nonce === "string"
    && frame.nonce.length > 0
    && frame.nonce.length <= USER_WS_CONNECTION_VALIDATION_NONCE_MAX_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(frame.nonce);
}

export function isUserWsConnectionPing(value: unknown): value is UserWsConnectionPing {
  return isConnectionValidationFrame(value, "connection.ping");
}

export function isUserWsConnectionPong(value: unknown): value is UserWsConnectionPong {
  return isConnectionValidationFrame(value, "connection.pong");
}
