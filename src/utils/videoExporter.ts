import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { MosaicTrack } from '../types';
import { interpolateKeyframes } from './tracking';
import { renderTrackMosaic } from './mosaicRenderer';

export interface ExportProgress {
  currentFrame: number;
  totalFrames: number;
  percent: number;
  status: string;
}

/**
 * 動画の完全ローカルMP4書き出し（音声トラック維持）
 */
export async function exportMosaicVideo(
  videoFile: File,
  videoElement: HTMLVideoElement,
  tracks: MosaicTrack[],
  onProgress: (p: ExportProgress) => void
): Promise<Blob> {
  const duration = videoElement.duration;
  const videoWidth = videoElement.videoWidth;
  const videoHeight = videoElement.videoHeight;
  const fps = 30;
  const totalFrames = Math.max(1, Math.floor(duration * fps));

  // キャンバス準備
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = videoWidth;
  exportCanvas.height = videoHeight;
  const ctx = exportCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas context could not be created');

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = videoWidth;
  sourceCanvas.height = videoHeight;
  const srcCtx = sourceCanvas.getContext('2d');
  if (!srcCtx) throw new Error('Source canvas context error');

  // 音声のデコード（AudioContext を使用）
  onProgress({ currentFrame: 0, totalFrames, percent: 0, status: '音声を解析中...' });
  let audioBuffer: AudioBuffer | null = null;
  try {
    const arrayBuffer = await videoFile.arrayBuffer();
    const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch (err) {
    console.warn('音声トラックの取得をスキップまたは音声なし:', err);
  }

  // WebCodecs が使えるかチェック
  const hasWebCodecs = typeof window.VideoEncoder !== 'undefined' && typeof window.VideoFrame !== 'undefined';

  if (hasWebCodecs) {
    return await exportWithWebCodecs(
      videoElement,
      exportCanvas,
      ctx,
      sourceCanvas,
      srcCtx,
      tracks,
      fps,
      totalFrames,
      duration,
      videoWidth,
      videoHeight,
      audioBuffer,
      onProgress
    );
  } else {
    // フォールバック: MediaRecorder
    return await exportWithMediaRecorder(
      videoElement,
      exportCanvas,
      ctx,
      sourceCanvas,
      srcCtx,
      tracks,
      fps,
      totalFrames,
      duration,
      onProgress
    );
  }
}

// WebCodecs + mp4-muxer による高速高画質エクスポート
async function exportWithWebCodecs(
  videoElement: HTMLVideoElement,
  exportCanvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  srcCtx: CanvasRenderingContext2D,
  tracks: MosaicTrack[],
  fps: number,
  totalFrames: number,
  duration: number,
  width: number,
  height: number,
  audioBuffer: AudioBuffer | null,
  onProgress: (p: ExportProgress) => void
): Promise<Blob> {
  const muxerTarget = new ArrayBufferTarget();

  const muxer = new Muxer({
    target: muxerTarget,
    video: {
      codec: 'avc',
      width,
      height,
    },
    audio: audioBuffer
      ? {
          codec: 'aac',
          numberOfChannels: audioBuffer.numberOfChannels,
          sampleRate: audioBuffer.sampleRate,
        }
      : undefined,
    fastStart: 'in-memory',
  });

  // VideoEncoder の作成
  let videoEncoderError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      console.error('VideoEncoder error', e);
      videoEncoderError = e;
    },
  });

  videoEncoder.configure({
    codec: 'avc1.42001f', // Baseline profile
    width,
    height,
    bitrate: Math.min(6_000_000, Math.round(width * height * 4)),
    framerate: fps,
  });

  // AudioEncoder（音声がある場合）
  let audioEncoder: AudioEncoder | null = null;
  if (audioBuffer && typeof window.AudioEncoder !== 'undefined') {
    try {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => console.error('AudioEncoder error', e),
      });

      audioEncoder.configure({
        codec: 'mp4a.40.2', // AAC-LC
        numberOfChannels: audioBuffer.numberOfChannels,
        sampleRate: audioBuffer.sampleRate,
        bitrate: 128_000,
      });

      // オーディオサンプルのエンコード
      const sampleRate = audioBuffer.sampleRate;
      const numChannels = audioBuffer.numberOfChannels;
      const totalSamples = audioBuffer.length;
      const samplesPerChunk = 1024;

      for (let offset = 0; offset < totalSamples; offset += samplesPerChunk) {
        const frameCount = Math.min(samplesPerChunk, totalSamples - offset);
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: frameCount,
          numberOfChannels: numChannels,
          timestamp: Math.round((offset / sampleRate) * 1_000_000),
          data: audioBuffer.getChannelData(0).subarray(offset, offset + frameCount),
        });
        audioEncoder.encode(audioData);
        audioData.close();
      }
      await audioEncoder.flush();
    } catch (aErr) {
      console.warn('AudioEncoder not available or failed:', aErr);
      audioEncoder = null;
    }
  }

  // 1フレームずつシークしてレンダリング
  for (let f = 0; f < totalFrames; f++) {
    if (videoEncoderError) throw videoEncoderError;

    const currentTime = (f / fps);
    videoElement.currentTime = currentTime;

    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        videoElement.removeEventListener('seeked', onSeeked);
        resolve();
      };
      videoElement.addEventListener('seeked', onSeeked);
    });

    // 元フレーム描画
    srcCtx.drawImage(videoElement, 0, 0, width, height);
    ctx.drawImage(sourceCanvas, 0, 0, width, height);

    // 各モザイクの適用
    for (const track of tracks) {
      if (!track.enabled) continue;
      if (currentTime < track.startTime || currentTime > track.endTime) continue;

      const pos = interpolateKeyframes(track.keyframes, currentTime);
      if (pos && !track.trackingData?.isOutOfFrame) {
        renderTrackMosaic(ctx, track, pos, sourceCanvas);
      }
    }

    // VideoFrame 作成とエンコード
    const timestampUs = Math.round((f / fps) * 1_000_000);
    const videoFrame = new VideoFrame(exportCanvas, {
      timestamp: timestampUs,
      duration: Math.round((1 / fps) * 1_000_000),
    });

    const isKeyframe = f % 60 === 0;
    videoEncoder.encode(videoFrame, { keyFrame: isKeyframe });
    videoFrame.close();

    const percent = Math.round(((f + 1) / totalFrames) * 100);
    onProgress({
      currentFrame: f + 1,
      totalFrames,
      percent,
      status: `フレームをエンコード中 (${f + 1}/${totalFrames})`,
    });
  }

  await videoEncoder.flush();
  muxer.finalize();

  return new Blob([muxerTarget.buffer], { type: 'video/mp4' });
}

// MediaRecorder フォールバック
async function exportWithMediaRecorder(
  videoElement: HTMLVideoElement,
  exportCanvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  srcCtx: CanvasRenderingContext2D,
  tracks: MosaicTrack[],
  fps: number,
  totalFrames: number,
  duration: number,
  onProgress: (p: ExportProgress) => void
): Promise<Blob> {
  const stream = exportCanvas.captureStream(fps);

  // 音声トラックをキャプチャストリームに追加
  try {
    const audioTrack = (videoElement as unknown as { captureStream?: () => MediaStream }).captureStream?.()?.getAudioTracks()[0];
    if (audioTrack) {
      stream.addTrack(audioTrack);
    }
  } catch (e) {
    console.warn('MediaStream audio capture unavailable', e);
  }

  const mimeType = MediaRecorder.isTypeSupported('video/mp4')
    ? 'video/mp4'
    : MediaRecorder.isTypeSupported('video/webm;codecs=h264')
    ? 'video/webm;codecs=h264'
    : 'video/webm';

  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const recordedPromise = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType }));
    };
  });

  recorder.start();

  videoElement.currentTime = 0;
  await videoElement.play().catch(() => {});

  const renderLoop = () => {
    const curTime = videoElement.currentTime;
    srcCtx.drawImage(videoElement, 0, 0, exportCanvas.width, exportCanvas.height);
    ctx.drawImage(sourceCanvas, 0, 0, exportCanvas.width, exportCanvas.height);

    for (const track of tracks) {
      if (!track.enabled) continue;
      if (curTime < track.startTime || curTime > track.endTime) continue;
      const pos = interpolateKeyframes(track.keyframes, curTime);
      if (pos && !track.trackingData?.isOutOfFrame) {
        renderTrackMosaic(ctx, track, pos, sourceCanvas);
      }
    }

    const percent = Math.min(99, Math.round((curTime / duration) * 100));
    onProgress({
      currentFrame: Math.floor(curTime * fps),
      totalFrames,
      percent,
      status: `リアルタイム録画中 (${percent}%)`,
    });

    if (videoElement.ended || curTime >= duration - 0.05) {
      recorder.stop();
      videoElement.pause();
    } else {
      requestAnimationFrame(renderLoop);
    }
  };

  requestAnimationFrame(renderLoop);
  return await recordedPromise;
}

/**
 * ファイル保存・共有
 */
export async function saveOrShareBlob(blob: Blob, fileName: string) {
  const file = new File([blob], fileName, { type: blob.type });

  // スマホの共有シート（navigator.share）
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: 'モザイク済み動画',
        text: 'ローカル完結型アプリでモザイク加工した動画です',
      });
      return;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.warn('Share error, fallback to download', e);
      } else {
        return; // ユーザーがキャンセル
      }
    }
  }

  // 通常のダウンロード
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

