"use client";

// Raw Material tab — sits beside "Stage Chain" on the job card detail page.
// Top of the tab is a camera QR scanner with a region-of-interest (ROI) box;
// the area below is a placeholder for raw-material content specified later.
//
// ROI design (why this is responsive on every device):
//   • The viewport is a SQUARE container and the video uses object-cover, so a
//     landscape/portrait camera is scaled-to-fill and centred.
//   • The decode region is computed as ROI_RATIO × min(videoWidth, videoHeight),
//     centred — a PROPORTION of the frame, never a fixed pixel count. The same
//     fraction of a square container drives the on-screen box (rendered as a
//     plain 62%×62% element), so the visible box and the decoded region always
//     coincide regardless of resolution or orientation.
//   • Only that centred crop is handed to the decoder, so a QR outside the box
//     is never decoded — "only the QR in the box works".
//
// Decoding uses ZXing (@zxing/browser BrowserQRCodeReader.decodeFromCanvas).
// We deliberately do NOT use ZXing's decodeFromVideoDevice — that scans the
// whole frame and would defeat the ROI; instead we feed it only the ROI canvas.

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

// Fraction of the smaller frame dimension occupied by the scan box. Kept as a
// ratio (not pixels) so the ROI is identical in proportion on a 480p phone and
// a 1080p webcam, and so it survives any viewport/orientation change.
const ROI_RATIO = 0.62;
// Cap the decode bitmap so the decoder stays fast on high-res cameras: the ROI
// crop is scaled into a square of at most this many px before decoding.
const DECODE_MAX_PX = 512;
// Throttle decode passes. Decoding every animation frame (~60/s) is wasteful;
// ~8/s is plenty responsive for a QR while keeping the CPU cool on mobile.
const DECODE_INTERVAL_MS = 120;

export function RawMaterialTab({ jcId }: { jcId: number }) {
  // jcId is accepted for parity with the other tabs and for the (later)
  // raw-material content that will live below the scanner.
  void jcId;
  return (
    <div className="space-y-4">
      {/* Scanner pinned to the top — further raw-material content is added
          below this in a later change. */}
      <QrScanner />
      <div className="bg-white border border-dashed border-[var(--aws-border-strong)] rounded-md p-4 text-center text-[12px] text-[var(--text-muted)]">
        Raw-material details will appear here.
      </div>
    </div>
  );
}

type ScanState = "idle" | "starting" | "scanning" | "error";

function QrScanner({ onResult }: { onResult?: (value: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null); // offscreen decode buffer
  const streamRef = useRef<MediaStream | null>(null);
  const readerRef = useRef<BrowserQRCodeReader | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastDecodeRef = useRef<number>(0);
  const lastHitRef = useRef<{ value: string; at: number } | null>(null);

  const [state, setState] = useState<ScanState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  const stop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    const v = videoRef.current;
    if (v) v.srcObject = null;
    setState("idle");
  }, []);

  // One decode pass: draw ONLY the centred ROI crop into the offscreen canvas,
  // then decode that crop. QRs outside the ROI never reach the decoder. The
  // animation loop (see start) calls this every frame; the time gate below
  // throttles the actual decoding to DECODE_INTERVAL_MS.
  const decodeOnce = useCallback(() => {
    const v = videoRef.current;
    const canvas = canvasRef.current;
    if (!v || !canvas || v.readyState < 2) return;

    const now = performance.now();
    if (now - lastDecodeRef.current < DECODE_INTERVAL_MS) return;
    lastDecodeRef.current = now;

    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return;

    // ROI = centred square of ROI_RATIO × the smaller intrinsic dimension. This
    // is the exact region the on-screen 62% box frames (square viewport +
    // object-cover ⇒ the fill axis is min(vw,vh), centred), so what the user
    // lines up is precisely what gets decoded.
    const side = Math.round(Math.min(vw, vh) * ROI_RATIO);
    const sx = Math.round((vw - side) / 2);
    const sy = Math.round((vh - side) / 2);
    const target = Math.min(side, DECODE_MAX_PX);

    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(v, sx, sy, side, side, 0, 0, target, target);

    // Decode ONLY the ROI canvas. decodeFromCanvas reads the canvas pixels
    // directly and throws NotFoundException when there's no QR in the crop, so
    // a code outside the box is never decoded.
    if (!readerRef.current) readerRef.current = new BrowserQRCodeReader();
    let value: string;
    try {
      value = readerRef.current.decodeFromCanvas(canvas).getText().trim();
    } catch {
      // No QR in the ROI this frame (NotFoundException) — keep scanning.
      return;
    }
    if (value) {
      const prev = lastHitRef.current;
      // De-dupe rapid repeats of the same code so a held QR doesn't spam.
      if (!prev || prev.value !== value || now - prev.at > 1500) {
        lastHitRef.current = { value, at: now };
        setResult(value);
        setFlash(true);
        window.setTimeout(() => setFlash(false), 350);
        onResult?.(value);
      }
    }
  }, [onResult]);

  const start = useCallback(async () => {
    setError(null);
    setResult(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      // getUserMedia is gated to secure contexts (HTTPS or localhost).
      setState("error");
      setError("Camera unavailable. Open this page over HTTPS (or localhost) on a device with a camera.");
      return;
    }
    setState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } }, // prefer the rear camera
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      v.srcObject = stream;
      await v.play().catch(() => {});
      setState("scanning");
      lastDecodeRef.current = 0;
      // Hoisted declaration → legal self-reference for the rAF loop.
      function runLoop() {
        decodeOnce();
        rafRef.current = requestAnimationFrame(runLoop);
      }
      rafRef.current = requestAnimationFrame(runLoop);
    } catch (e) {
      setState("error");
      const name = (e as { name?: string })?.name;
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Camera permission denied. Allow camera access and try again."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "No camera found on this device."
            : "Could not start the camera. Check permissions and try again.",
      );
    }
  }, [decodeOnce]);

  // Stop the stream + RAF loop on unmount (e.g. switching away from this tab).
  useEffect(() => stop, [stop]);

  const live = state === "scanning" || state === "starting";

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Scan Raw Material QR</h3>
        {live ? (
          <button
            type="button"
            onClick={stop}
            className="h-8 px-3 rounded-[2px] text-[12px] font-semibold border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] text-[var(--text-primary)]"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            className="h-8 px-3 rounded-[2px] text-[12px] font-semibold border border-[var(--aws-orange-active)] bg-[var(--aws-orange)] hover:bg-[var(--aws-orange-hover)] text-white"
          >
            {state === "error" ? "Retry camera" : "Start camera"}
          </button>
        )}
      </div>

      {/* Square viewport — full width, centred, capped so it doesn't dominate a
          desktop. w-full keeps it fluid on phones; the square aspect makes the
          ROI math orientation-proof. */}
      <div className="relative mx-auto w-full max-w-[460px] aspect-square overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* ROI box + dimmed surround. Rendered only while live so the idle
            state stays clean. The box is 62% of the SQUARE viewport on both
            axes — a pure proportion, so it scales with any screen. The large
            spread box-shadow dims everything outside the ROI. */}
        {live ? (
          <div className="pointer-events-none absolute inset-0">
            <div
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg"
              style={{
                width: `${ROI_RATIO * 100}%`,
                height: `${ROI_RATIO * 100}%`,
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
                outline: `2px solid ${flash ? "#1d8102" : "var(--aws-orange)"}`,
                transition: "outline-color 120ms ease",
              }}
            >
              {/* Corner ticks for a clear "align here" affordance. */}
              {(["left-0 top-0 border-l-2 border-t-2", "right-0 top-0 border-r-2 border-t-2",
                 "left-0 bottom-0 border-l-2 border-b-2", "right-0 bottom-0 border-r-2 border-b-2"] as const)
                .map((pos) => (
                  <span
                    key={pos}
                    className={`absolute h-5 w-5 ${pos}`}
                    style={{ borderColor: flash ? "#1d8102" : "#ffffff" }}
                  />
                ))}
            </div>
          </div>
        ) : null}

        {/* Idle / error overlay covering the black viewport. */}
        {!live ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#d5dbdb" strokeWidth={1.6}>
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <line x1="14" y1="14" x2="21" y2="14" />
              <line x1="14" y1="17.5" x2="21" y2="17.5" />
              <line x1="14" y1="21" x2="21" y2="21" />
            </svg>
            <p className="text-[12px] text-[#d5dbdb] max-w-[260px]">
              {error ?? "Start the camera and centre a QR code inside the box."}
            </p>
          </div>
        ) : null}
      </div>

      {/* Offscreen decode buffer. */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Last decoded value. Wired to onResult for the content added below
          later; shown inline for now so the operator gets immediate feedback. */}
      {result ? (
        <div className="mt-3 rounded-sm border border-[var(--aws-border)] bg-[var(--surface-subtle)] px-3 py-2">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">Last scan</span>
          <div className="font-mono text-[13px] text-[var(--text-primary)] break-all">{result}</div>
        </div>
      ) : null}
    </div>
  );
}
