"use client";

// Shared camera QR scanner for the transfer module (transfer-OUT forms + transfer-IN
// receive). The camera opens on getUserMedia alone; decoding prefers the native
// BarcodeDetector (Android/ChromeOS/macOS) and falls back to ZXing on browsers that
// lack it (Chrome/Firefox on Linux & Windows, Safari) — so the live view + ROI render
// on every device. A 2s per-value cooldown avoids double-adds. If the camera itself is
// unavailable, a paste-the-QR fallback lets the operator still ingest a code. Emits the
// raw decoded string via onScan.
//
// ROI: detection is confined to a centred square (ROI_FRACTION of the camera view).
// Each frame we copy ONLY that region into an offscreen canvas and decode THAT, so a
// QR framed outside the green box is never handed to the detector and can't be read.
// The crop and the on-screen overlay box use the same fraction, so — under the video's
// object-cover scaling — the bright box is exactly the area that gets scanned. The
// container is `w-full aspect-square` (max-w-sm), so the camera view + ROI stay
// proportional and adaptively responsive across devices. The most recent decode is
// echoed back in a green/red bar over the live view.

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";

const COOLDOWN_MS = 2000;
// Centred square scan region as a fraction of the (square) camera view. The crop we
// feed the decoder and the on-screen overlay box both use this, so they line up.
const ROI_FRACTION = 0.7;
// Decode a slightly LARGER centred square than the visual box, so a QR framed in the
// green box keeps its required white quiet zone in the cropped image — QR decoders fail
// when the code fills the crop edge-to-edge with no margin.
const DECODE_FRACTION = 0.9;

// BarcodeDetector is not in the TS DOM lib yet — declare the slice we use.
type BarcodeDetectorLike = { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

// Friendly, device-aware camera failure messages (all keep the paste fallback open).
function cameraErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError")
    return "Camera permission denied — allow camera access and retry. Or paste the QR text:";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError")
    return "No camera found on this device. Paste the QR text instead:";
  if (name === "SecurityError")
    return "Camera needs a secure context (HTTPS or localhost). Paste the QR text instead:";
  return (e instanceof Error ? e.message : "Could not access the camera.") + " — paste the QR text:";
}

export function QRScanner({
  onScan, onClose,
  title = "Scan box QR",
  hint = "Align the box QR inside the green box.",
}: {
  onScan: (text: string) => boolean | void | Promise<boolean | void>;
  onClose: () => void;
  title?: string;
  hint?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<{ value: string; at: number }>({ value: "", at: 0 });
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [scanned, setScanned] = useState<{ text: string; ok: boolean } | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const emit = useCallback(async (raw: string) => {
    const now = Date.now();
    if (raw === lastRef.current.value && now - lastRef.current.at < COOLDOWN_MS) return;
    lastRef.current = { value: raw, at: now };
    // onScan reports whether the code was a usable box (true/undefined = ok, false =
    // unrecognised/duplicate). Reflect that in the bar so a foreign QR framed in the
    // box isn't shown as a green success while its error sits hidden behind the modal.
    let ok = true;
    try { ok = (await onScan(raw)) !== false; } catch { ok = false; }
    setScanned({ text: raw, ok });
  }, [onScan]);

  useEffect(() => {
    let off = false;
    // Capability check + camera start live inside the async IIFE so no setState runs
    // synchronously in the effect body (react-hooks/set-state-in-effect).
    (async () => {
      // The CAMERA only needs getUserMedia — it must open regardless of decoder support.
      if (!navigator.mediaDevices?.getUserMedia) {
        if (!off) setError("Camera access isn't available on this device/browser. Paste the QR text instead:");
        return;
      }
      // Decoder: native BarcodeDetector if present (fast; Android/ChromeOS/macOS), else
      // ZXing — which decodes on browsers WITHOUT BarcodeDetector (Chrome/Firefox on
      // Linux & Windows, Safari). Decode is decoupled from the camera so the live view +
      // ROI render either way.
      const Ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      const detector = Ctor ? new Ctor({ formats: ["qr_code"] }) : null;
      // TRY_HARDER greatly improves marginal captures (a QR off a phone screen via a
      // webcam — glare, moire, soft focus); restrict to QR for speed.
      const zxing = detector ? null : new BrowserQRCodeReader(
        new Map<DecodeHintType, unknown>([
          [DecodeHintType.TRY_HARDER, true],
          [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
        ]),
      );
      let lastZxingAt = 0;
      try {
        // `ideal` (not exact): prefers the rear camera on phones but still starts on a
        // single-/front-camera laptop instead of throwing OverconstrainedError.
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
        if (off) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        const tick = async () => {
          if (off || !videoRef.current) return;
          const vid = videoRef.current;
          const vw = vid.videoWidth, vh = vid.videoHeight;
          if (vw && vh) {
            try {
              // ROI: copy the centred square (ROI_FRACTION of the smaller dimension —
              // exactly the region the green overlay highlights under object-cover) into
              // an offscreen canvas and decode THAT. Anything outside the box is never
              // handed to the detector, so it can't be scanned.
              const roi = Math.floor(Math.min(vw, vh) * DECODE_FRACTION);
              const sx = Math.floor((vw - roi) / 2);
              const sy = Math.floor((vh - roi) / 2);
              const canvas = canvasRef.current ?? (canvasRef.current = document.createElement("canvas"));
              // Resize only when the ROI size changes (it derives from the fixed stream
              // resolution, so this is a no-op after frame 1). drawImage overwrites the
              // whole canvas each frame, so we never need a manual clear.
              if (canvas.width !== roi) { canvas.width = roi; canvas.height = roi; }
              const ctx = canvas.getContext("2d");
              if (ctx) {
                ctx.drawImage(vid, sx, sy, roi, roi, 0, 0, roi, roi);
                if (detector) {
                  const codes = await detector.detect(canvas);
                  // detect() is async; re-check the scanner is still open before emitting.
                  if (off || !videoRef.current) return;
                  if (codes.length && codes[0].rawValue) emit(codes[0].rawValue);
                } else if (zxing) {
                  // ZXing decode is sync + CPU-heavy — throttle to ~150ms; ignore the
                  // no-code-found throw and keep scanning.
                  const now = Date.now();
                  if (now - lastZxingAt >= 150) {
                    lastZxingAt = now;
                    try { const t = zxing.decodeFromCanvas(canvas).getText().trim(); if (t) emit(t); }
                    catch { /* no QR in this frame */ }
                  }
                }
              }
            } catch { /* transient decode error — keep scanning */ }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        if (!off) setError(cameraErrorMessage(e));
      }
    })();
    return () => { off = true; stop(); };
  }, [emit, stop]);

  const close = () => { stop(); onClose(); };

  return (
    <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4" onClick={close}>
      <div className="bg-white rounded-lg w-full max-w-sm overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--aws-border)]">
          <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h3>
          <button onClick={close} className="text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>
        <div className="p-4">
          {!error ? (
            <>
              {/* Square scan window. The green box is the active region: only QR codes
                  framed inside it are decoded; everything around it is dimmed so the
                  operator can see the part that won't be read. */}
              <div className="relative w-full aspect-square overflow-hidden rounded-md bg-black">
                <video ref={videoRef} muted playsInline className="absolute inset-0 h-full w-full object-cover" />
                <div className="pointer-events-none absolute inset-0">
                  <div
                    className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md"
                    style={{ width: `${ROI_FRACTION * 100}%`, height: `${ROI_FRACTION * 100}%`, boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)" }}
                  >
                    <div className="absolute inset-0 rounded-md border border-emerald-400/50" />
                    <span className="absolute -left-px -top-px h-6 w-6 rounded-tl-md border-l-4 border-t-4 border-emerald-400" />
                    <span className="absolute -right-px -top-px h-6 w-6 rounded-tr-md border-r-4 border-t-4 border-emerald-400" />
                    <span className="absolute -bottom-px -left-px h-6 w-6 rounded-bl-md border-b-4 border-l-4 border-emerald-400" />
                    <span className="absolute -bottom-px -right-px h-6 w-6 rounded-br-md border-b-4 border-r-4 border-emerald-400" />
                    <div
                      className="absolute left-[8%] right-[8%] h-[2px] bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.7)]"
                      style={{ animation: "qrroi-scan 2.2s ease-in-out infinite" }}
                    />
                  </div>
                </div>
                {scanned && (
                  <div className={`absolute inset-x-0 bottom-0 px-3 py-1.5 ${scanned.ok ? "bg-emerald-500/95" : "bg-rose-500/95"}`}>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-white/90">{scanned.ok ? "✓ Scanned" : "✕ Not a usable box code"}</p>
                    <p className="truncate font-mono text-[12px] text-white" title={scanned.text}>{scanned.text}</p>
                  </div>
                )}
              </div>
              <p className="mt-2 text-[12px] text-[var(--text-secondary)] text-center">{hint}</p>
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-[12px] text-rose-600">
                {error || "Camera scanning isn't available on this device/browser. Paste the QR text instead:"}
              </p>
              <textarea value={manual} onChange={(e) => setManual(e.target.value)} rows={3}
                placeholder='Paste QR contents, e.g. {"tx":"BE-...","bi":"..."}'
                className="w-full px-2.5 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md font-mono" />
              <button type="button" onClick={() => { if (manual.trim()) { onScan(manual.trim()); setManual(""); } }}
                className="w-full px-3 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90">
                Add scanned code
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
