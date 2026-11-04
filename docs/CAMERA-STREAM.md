# Camera stream tools

Contract version: **Bambu 1.1.52 and newer.** This is the contract for
Counterpart's printer camera (PRD §8.6.1). Version 1.1.51 exposes only `camera_snapshot`.
Clients must discover the three tools before using this capability and retain their snapshot fallback.

Goal: one camera connection per printer, only while someone is watching; frames held in memory;
callers get a frame only when the picture changed. Nothing is open when nobody is looking.

## Tools

All three take the usual optional printer overrides (`host`, and for Bambu `bambu_serial`,
`bambu_token`). A stream is keyed by the requested host and serial together, so one server process can stream
several printers without mixing them up.

### `camera_stream_start`
`{fps?: number = 1 (0.2–2), idle_timeout_ms?: number = 30000 (5000–120000)}` plus overrides
(Bambu also `bambu_model`).
Returns `{status: "started" | "running", transport, fps, startedAt}`. Idempotent per printer.

### `camera_frame`
`{since_seq?: number = 0, wait_ms?: number = 0 (≤ 10000), max_width?: number,
  max_bytes?: number (4096–5000000), changed_only?: boolean = true, min_change?: number = 0.02}` plus overrides.
Returns `{status: "frame" | "unchanged" | "stopped" | "unavailable", seq, capturedAt, width, height,
format: "image/jpeg", base64?, change, reason?}`.

- Long poll: returns as soon as a frame newer than `since_seq` exists and, with `changed_only`,
  differs from the frame at `since_seq` by `change ≥ min_change`; otherwise after `wait_ms` with
  `unchanged` and no image.
- `change` is the mean absolute difference of 32×18 grayscale thumbnails, 0–1.
- `max_width` downscales (JPEG quality 70). Optional `max_bytes` caps JPEG bytes by reducing dimensions further, with at most four native encodes and four cached size variants per current frame.
- JPEG base64 appears only in MCP `structuredContent`; the accompanying text contains metadata without duplicating the image.
- The byte cap applies to decoded JPEG, not base64 or protocol overhead. A full-screen client can request 42000 bytes every two seconds (56000 base64 bytes, leaving roughly 4000 bytes for protocol overhead under 30 KB/s); a card can use 20000 bytes every ten seconds.
- Returns `stopped` at once after `camera_stream_stop` or the idle close, so a caller's loop ends.
- `unavailable` carries `reason: "no-camera" | "auth" | "unreachable"` (one reconnect is tried first).
- Every call renews the idle timer.
- `unchanged` retains the caller's `since_seq`; advance the cursor only when a JPEG is delivered.
  Quiet scenes keep comparing against the last delivered image, so small changes can accumulate.
- `max_width` is an integer from 1 to 4096; `min_change` is from 0 to 1.
- Cancelling a waiting frame request releases that waiter without stopping other viewers.

### `camera_stream_stop`
`{}` plus overrides → `{status: "stopped"}`. Closes the connection immediately.

## Behaviour

- `camera_snapshot` serves the in-memory frame when a stream is running (no new connection).
- The printer info tool adds `capabilities.cameraStream: true` on supported models; the existing
  `capabilities.camera` transport string remains compatible with older consumers.
- Shutdown closes every owned socket/process. An idle or explicitly stopped stream releases JPEG
  and thumbnail caches. Stream state is per server process, keyed by requested host and serial together. Host-only overrides therefore cannot reuse another printer's camera.
- One native Sharp/libvips decode makes a 32×18 grayscale thumbnail at the requested frame rate.
  Resized JPEGs are cached for the current frame; no JavaScript pixel loop or per-frame helper starts.
- Acceptance target from Counterpart PRD §8.6.1: under 2% Mac CPU for the camera path with one viewer; under 3 KB/s card and 30 KB/s full-screen image traffic; zero camera connections when idle. Hardware measurements must state their model, frame rate, size and observation window. The app stream consumer and generic MCP parity are separate work.

## Bambu transports

- A1/P1: one TLS socket on port 6000 (the existing frame parser) for the stream's lifetime.
- X1/H2/P2S: one `ffmpeg -rtsp_transport tcp -i rtsps://…:322 -vf fps=<fps> -f mjpeg pipe:1` for the
  stream's lifetime, frames split on JPEG SOI/EOI. If change detection from full decodes costs more
  than the budget at 1080p, `change` comes from a second tiny output (`scale=32:18,format=gray`).

Parity target: mcp-3D-printer-server will expose the same three tools and results.
That integration is not part of this Bambu development branch.
