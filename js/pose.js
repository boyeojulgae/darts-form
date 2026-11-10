// Thin wrapper around the MediaPipe pose landmarker (runs fully on the device).
import { FilesetResolver, PoseLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

let landmarker = null;
let info = { model: null, delegate: null };

export async function initPose(model, prefer) {
  if (landmarker) { landmarker.close(); landmarker = null; }
  const wasm = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
  const fileset = await FilesetResolver.forVisionTasks(wasm);
  const modelAssetPath = new URL(`../models/pose_landmarker_${model}.task`, import.meta.url).href;
  const order = prefer === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
  let lastError = null;
  for (const delegate of order) {
    try {
      landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      info = { model, delegate };
      return info;
    } catch (e) {
      lastError = e;
      landmarker = null;
    }
  }
  throw lastError || new Error('pose model failed to load');
}

/** Returns [[x, y, visibility] x33] in video pixels, or null when no person is found. */
export function detect(video, tMs) {
  if (!landmarker) return null;
  const r = landmarker.detectForVideo(video, tMs);
  const lm = r.landmarks && r.landmarks[0];
  if (!lm) return null;
  const w = video.videoWidth, h = video.videoHeight;
  return lm.map((p) => [Math.round(p.x * w * 10) / 10, Math.round(p.y * h * 10) / 10, Math.round((p.visibility ?? 1) * 100) / 100]);
}

export const poseInfo = () => info;
