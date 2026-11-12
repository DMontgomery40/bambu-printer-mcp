export async function snapshotFrame(source, timeoutMs, capturedAfter) {
    const waitMs = Math.min(timeoutMs, 10000), deadline = Date.now() + waitMs;
    if (capturedAfter === undefined)
        return source.frame({ waitMs, changedOnly: false });
    const boundary = Date.parse(capturedAfter);
    if (!Number.isFinite(boundary))
        throw Error("Invalid camera acquisition boundary.");
    const current = await source.frame({ waitMs: 0, changedOnly: false });
    const matches = (frame) => frame.status === "frame" &&
        !!frame.base64 &&
        frame.capturedAt !== undefined &&
        Number.isFinite(Date.parse(frame.capturedAt)) &&
        Date.parse(frame.capturedAt) >= boundary;
    if (matches(current))
        return current;
    if (current.status !== "frame" && current.status !== "unchanged")
        return current;
    const fresh = await source.frame({
        sinceSeq: current.seq,
        waitMs: Math.max(0, deadline - Date.now()),
        changedOnly: false,
    });
    return fresh.seq > current.seq && matches(fresh)
        ? fresh
        : { status: "unavailable", seq: fresh.seq };
}
