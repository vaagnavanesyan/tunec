// ── Request: AppOne → AppBack ────────────────────────────────────────────────

export interface ConnectRequest {
  type: "connect";
  connectionId: string;
  destIp: string;
  destPort: number;
}

export interface DataRequest {
  type: "data";
  connectionId: string;
  /** Base64-encoded binary payload */
  payload: string;
}

export interface DisconnectRequest {
  type: "disconnect";
  connectionId: string;
}

export interface ShutdownWriteRequest {
  type: "shutdown_write";
  connectionId: string;
}

export type RelayRequest =
  | ConnectRequest
  | DataRequest
  | DisconnectRequest
  | ShutdownWriteRequest;

// ── Response: AppBack → AppOne ──────────────────────────────────────────────

export interface ConnectedResponse {
  type: "connected";
  connectionId: string;
}

export interface DataResponse {
  type: "data";
  connectionId: string;
  /** Base64-encoded binary payload */
  payload: string;
}

export interface DisconnectedResponse {
  type: "disconnected";
  connectionId: string;
}

export interface ErrorResponse {
  type: "error";
  connectionId: string;
  message: string;
}

export type RelayResponse =
  | ConnectedResponse
  | DataResponse
  | DisconnectedResponse
  | ErrorResponse;
