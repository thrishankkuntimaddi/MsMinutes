/** Wire-format version carried in every envelope (`v`). Bump only for breaking changes. */
export const PROTOCOL_VERSION = 1 as const;

/** Application-defined WebSocket close codes (4000–4999 range). */
export const CloseCode = {
  ProtocolError: 4000,
  HelloTimeout: 4001,
  Replaced: 4002,
  HeartbeatTimeout: 4003,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];
