import { FilesetResolver, FaceDetector } from '@mediapipe/tasks-vision';
import { DetectedPerson } from '../types';

let faceDetectorInstance: FaceDetector | null = null;
let isInitializing = false;

export interface FaceFilterOptions {
  minScore?: number;
  minAspect?: number;
  maxAspect?: number;
  verifyFaceKeypoints?: boolean;
}

/**
 * 検出結果が手や物体などの誤検出ではないかを幾何学的に判定する
 */
export function isValidFaceDetection(
  det: {
    boundingBox?: { originX: number; originY: number; width: number; height: number };
    categories?: Array<{ score: number }>;
    keypoints?: Array<{ x: number; y: number; label?: string }>;
  },
  options: FaceFilterOptions = {}
): boolean {
  const minScore = options.minScore ?? 0.55;
  const minAspect = options.minAspect ?? 0.55;
  const maxAspect = options.maxAspect ?? 1.65;
  const verifyKeypoints = options.verifyFaceKeypoints ?? true;

  // 1. 信頼度スコア判定（手や背景ノイズの多くは 0.3〜0.5 前後）
  const score = det.categories?.[0]?.score ?? 0;
  if (score < minScore) return false;

  // 2. バウンディングボックスの検証
  const bb = det.boundingBox;
  if (!bb || bb.width <= 6 || bb.height <= 6) return false;

  // アスペクト比 (顔は通常 0.6〜1.4 程度。手や指先、腕などは極端に横長・縦長になりやすい)
  const aspect = bb.width / bb.height;
  if (aspect < minAspect || aspect > maxAspect) return false;

  // 3. 顔キーポイント（両目、鼻、口）の幾何学的検証
  // BlazeFace は 6点: 0:右目, 1:左目, 2:鼻先, 3:口中心, 4:右耳, 5:左耳
  if (verifyKeypoints && det.keypoints && det.keypoints.length >= 4) {
    const rightEye = det.keypoints[0];
    const leftEye = det.keypoints[1];
    const mouth = det.keypoints[3];

    // 両目間の距離
    const eyeDx = leftEye.x - rightEye.x;
    const eyeDy = leftEye.y - rightEye.y;
    const eyeDist = Math.sqrt(eyeDx * eyeDx + eyeDy * eyeDy);

    // 手の誤検出ではキーポイントが極端に密集することが多い
    if (eyeDist < 0.035) {
      return false;
    }

    // 通常の顔では口が両目より上に来ることはない（手のひらや拳の誤検出防止）
    const eyesCenterY = (rightEye.y + leftEye.y) / 2;
    if (mouth.y < eyesCenterY - eyeDist * 0.3) {
      return false;
    }
  }

  return true;
}

// 完全ローカルから MediaPipe Face Detector を初期化
export async function initFaceDetector(
  confidence = 0.45,
  forceCpu = false
): Promise<FaceDetector> {
  if (faceDetectorInstance && !forceCpu) return faceDetectorInstance;
  if (forceCpu && faceDetectorInstance) {
    try {
      faceDetectorInstance.close();
    } catch (_) {}
    faceDetectorInstance = null;
  }
  if (isInitializing) {
    while (isInitializing) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (faceDetectorInstance) return faceDetectorInstance;
  }

  isInitializing = true;
  try {
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
    const wasmPath = `${baseUrl}/wasm`;
    const modelPath = `${baseUrl}/models/blaze_face_short_range.tflite`;

    // ローカルの wasm を参照
    const vision = await FilesetResolver.forVisionTasks(wasmPath);
    if (!forceCpu) {
      faceDetectorInstance = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: 'GPU',
        },
        runningMode: 'IMAGE',
        minDetectionConfidence: confidence,
      });
      return faceDetectorInstance;
    }
    throw new Error('Force CPU delegate');
  } catch (err) {
    console.warn('GPU delegate skipped or failed, using CPU delegate', err);
    // CPUフォールバック
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
    const wasmPath = `${baseUrl}/wasm`;
    const modelPath = `${baseUrl}/models/blaze_face_short_range.tflite`;

    const vision = await FilesetResolver.forVisionTasks(wasmPath);
    faceDetectorInstance = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: confidence,
    });
    return faceDetectorInstance;
  } finally {
    isInitializing = false;
  }
}

// 2D Canvas バッファ（<video> を直接 WebGL2 texImage2D に渡すとスマホ環境で未デコードや cross-origin エラーになる問題を完全回避）
let sharedDetCanvas: HTMLCanvasElement | null = null;

/**
 * スマホ・PC問わず安全に顔検出を実行するラッパー関数
 * - <video> や <img> を一度同一オリジンの2D Canvasに転写してから MediaPipe に渡すことで
 *   WebGL2 texImage2D の "The video element contains cross-origin data, and may not be loaded" エラーを根絶
 * - 万が一 WebGL2 実行時エラーが起きた場合も自動的に CPU デリゲートへフォールバックして継続
 */
export async function detectFacesSafely(
  source: HTMLVideoElement | HTMLImageElement,
  detector: FaceDetector,
  confidence = 0.45
): Promise<{
  detections: Array<{
    boundingBox?: { originX: number; originY: number; width: number; height: number };
    categories?: Array<{ score: number }>;
    keypoints?: Array<{ x: number; y: number; label?: string }>;
  }>;
  activeDetector: FaceDetector;
}> {
  const isVideo = source instanceof HTMLVideoElement;
  const origWidth = isVideo ? source.videoWidth : source.naturalWidth;
  const origHeight = isVideo ? source.videoHeight : source.naturalHeight;

  if (!origWidth || !origHeight) {
    return { detections: [], activeDetector: detector };
  }

  // 動画フレームがまだデコードされていない場合（readyState < 2）は安全にスキップ
  if (isVideo && source.readyState < 2) {
    return { detections: [], activeDetector: detector };
  }

  if (!sharedDetCanvas) {
    sharedDetCanvas = document.createElement('canvas');
  }

  // BlazeFace の入力解像度に合わせ、長辺最大 640px に縮小して転写（スマホでのWebGLメモリ負荷と処理速度も大幅に改善）
  const maxDim = 640;
  const scale = Math.min(1, maxDim / Math.max(origWidth, origHeight));
  const detWidth = Math.max(16, Math.round(origWidth * scale));
  const detHeight = Math.max(16, Math.round(origHeight * scale));

  if (sharedDetCanvas.width !== detWidth || sharedDetCanvas.height !== detHeight) {
    sharedDetCanvas.width = detWidth;
    sharedDetCanvas.height = detHeight;
  }

  const ctx = sharedDetCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { detections: [], activeDetector: detector };
  }

  try {
    ctx.clearRect(0, 0, detWidth, detHeight);
    ctx.drawImage(source, 0, 0, detWidth, detHeight);
  } catch (drawErr) {
    console.warn('Skipping frame: video frame not ready for drawImage', drawErr);
    return { detections: [], activeDetector: detector };
  }

  let currentDetector = detector;
  let rawResult: ReturnType<FaceDetector['detect']>;

  try {
    rawResult = currentDetector.detect(sharedDetCanvas);
  } catch (detectErr) {
    console.warn('WebGL detect failed on canvas, switching to CPU delegate:', detectErr);
    currentDetector = await initFaceDetector(confidence, true);
    rawResult = currentDetector.detect(sharedDetCanvas);
  }

  const invScaleX = origWidth / detWidth;
  const invScaleY = origHeight / detHeight;

  const scaledDetections = (rawResult.detections || []).map((det) => {
    const bb = det.boundingBox;
    return {
      ...det,
      boundingBox: bb
        ? {
            originX: bb.originX * invScaleX,
            originY: bb.originY * invScaleY,
            width: bb.width * invScaleX,
            height: bb.height * invScaleY,
          }
        : undefined,
    };
  });

  return {
    detections: scaledDetections,
    activeDetector: currentDetector,
  };
}

// IoU (Intersection over Union) 計算
function calcIoU(
  b1: { x: number; y: number; width: number; height: number },
  b2: { x: number; y: number; width: number; height: number }
): number {
  const x1 = Math.max(b1.x, b2.x);
  const y1 = Math.max(b1.y, b2.y);
  const x2 = Math.min(b1.x + b1.width, b2.x + b2.width);
  const y2 = Math.min(b1.y + b1.height, b2.y + b2.height);

  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const interArea = interW * interH;
  if (interArea <= 0) return 0;

  const area1 = b1.width * b1.height;
  const area2 = b2.width * b2.height;
  return interArea / (area1 + area2 - interArea);
}

// 顔の検出枠に安全マージン（35%拡張）を付与して素顔のはみ出し・チラ見えを防止
export function expandBoxWithMargin(
  box: { x: number; y: number; width: number; height: number },
  margin = 0.35
): { x: number; y: number; width: number; height: number } {
  const padW = box.width * margin;
  const padH = box.height * margin;
  return {
    x: Math.max(0, box.x - padW / 2),
    y: Math.max(0, box.y - padH / 2),
    width: box.width + padW,
    height: box.height + padH,
  };
}

let nextPersonId = 1;

/**
 * 毎フレーム検出結果を受け取り、ID付与＋見失い補間（速度予測バッファ）を行う
 */
export function updatePersonTracks(
  existingTracks: DetectedPerson[],
  rawBoxes: Array<{ x: number; y: number; width: number; height: number; score: number }>,
  currentTime: number,
  maxMissBufferFrames = 8 // 見失い補間フレーム数
): DetectedPerson[] {
  const updated: DetectedPerson[] = [];
  const matchedRawIndices = new Set<number>();

  // 1. 既存のトラックに対して直近の検出ボックスをマッチング
  for (const track of existingTracks) {
    let bestIoU = 0;
    let bestIdx = -1;

    // 前回の速度を考慮した予測位置
    const predictedBox = {
      x: track.box.x + track.velocity.vx,
      y: track.box.y + track.velocity.vy,
      width: track.box.width,
      height: track.box.height,
    };

    for (let i = 0; i < rawBoxes.length; i++) {
      if (matchedRawIndices.has(i)) continue;
      const iou = calcIoU(predictedBox, rawBoxes[i]);
      if (iou > bestIoU) {
        bestIoU = iou;
        bestIdx = i;
      }
    }

    if (bestIdx !== -1 && bestIoU > 0.15) {
      // マッチ成功
      const matched = rawBoxes[bestIdx];
      matchedRawIndices.add(bestIdx);

      // 移動ベクトルの平滑化 (EMA)
      const vx = matched.x - track.box.x;
      const vy = matched.y - track.box.y;
      const smoothedVx = track.velocity.vx * 0.4 + vx * 0.6;
      const smoothedVy = track.velocity.vy * 0.4 + vy * 0.6;

      updated.push({
        ...track,
        box: { ...matched },
        score: matched.score,
        missCount: 0,
        lastSeenTime: currentTime,
        velocity: { vx: smoothedVx, vy: smoothedVy },
      });
    } else {
      // 見失った場合：直前の移動ベクトルで予測位置を維持（見失い補間バッファ）
      if (track.missCount < maxMissBufferFrames) {
        const nextBox = {
          x: track.box.x + track.velocity.vx * 0.9,
          y: track.box.y + track.velocity.vy * 0.9,
          width: track.box.width,
          height: track.box.height,
        };

        updated.push({
          ...track,
          box: nextBox,
          missCount: track.missCount + 1,
          velocity: {
            vx: track.velocity.vx * 0.8,
            vy: track.velocity.vy * 0.8,
          },
        });
      }
    }
  }

  // 2. 新規検出された人物に新しいIDを発行
  for (let i = 0; i < rawBoxes.length; i++) {
    if (!matchedRawIndices.has(i)) {
      const b = rawBoxes[i];
      updated.push({
        trackId: nextPersonId++,
        label: `人物 #${nextPersonId - 1}`,
        box: { ...b },
        score: b.score,
        enabled: true,
        missCount: 0,
        lastSeenTime: currentTime,
        velocity: { vx: 0, vy: 0 },
      });
    }
  }

  return updated;
}

