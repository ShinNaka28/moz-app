import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { MosaicTrack, MosaicType } from '../types';
import { interpolateKeyframes } from './tracking';
import { renderTrackMosaic, renderInverseMosaic, ProtectedRegion } from './mosaicRenderer';
import { requestScreenWakeLock, releaseScreenWakeLock } from './wakeLock';

export interface ExportProgress {
  currentFrame: number;
  totalFrames: number;
  percent: number;
  status: string;
}

export interface ExportOptions {
  isInverseMosaic?: boolean;
  inverseMosaicType?: MosaicType;
  inverseStrength?: number;
}

/**
 * AudioBuffer を指定のサンプルレート・チャンネル数に変換（OfflineAudioContext使用）
 */
async function normalizeAudioBuffer(
  sourceBuffer: AudioBuffer,
  targetSampleRate: number,
  targetChannels: number
): Promise<AudioBuffer> {
  if (
    sourceBuffer.sampleRate === targetSampleRate &&
    sourceBuffer.numberOfChannels === targetChannels
  ) {
    return sourceBuffer;
  }

  const targetLength = Math.max(
    1,
    Math.round((sourceBuffer.length * targetSampleRate) / sourceBuffer.sampleRate)
  );
  const OfflineCtx =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;

  const offlineCtx = new OfflineCtx(targetChannels, targetLength, targetSampleRate);
  const bufferSource = offlineCtx.createBufferSource();
  bufferSource.buffer = sourceBuffer;
  bufferSource.connect(offlineCtx.destination);
  bufferSource.start(0);
  return await offlineCtx.startRendering();
}

/**
 * WebCodecs AudioEncoder で利用可能な音声エンコード設定を検出
 */
async function findSupportedAudioConfig(
  sourceBuffer: AudioBuffer
): Promise<{
  muxerCodec: 'aac' | 'opus';
  encoderConfig: AudioEncoderConfig;
} | null> {
  if (typeof window.AudioEncoder === 'undefined') return null;

  const targetChannels = Math.min(2, Math.max(1, sourceBuffer.numberOfChannels));
  const candidates: Array<{
    muxerCodec: 'aac' | 'opus';
    encoderConfig: AudioEncoderConfig;
  }> = [
    {
      muxerCodec: 'aac',
      encoderConfig: {
        codec: 'mp4a.40.2',
        numberOfChannels: targetChannels,
        sampleRate: sourceBuffer.sampleRate,
        bitrate: 128_000,
      },
    },
    {
      muxerCodec: 'aac',
      encoderConfig: {
        codec: 'mp4a.40.2',
        numberOfChannels: targetChannels,
        sampleRate: 48000,
        bitrate: 128_000,
      },
    },
    {
      muxerCodec: 'aac',
      encoderConfig: {
        codec: 'mp4a.40.2',
        numberOfChannels: targetChannels,
        sampleRate: 44100,
        bitrate: 128_000,
      },
    },
    {
      muxerCodec: 'opus',
      encoderConfig: {
        codec: 'opus',
        numberOfChannels: targetChannels,
        sampleRate: 48000,
        bitrate: 128_000,
      },
    },
  ];

  for (const candidate of candidates) {
    try {
      const support = await AudioEncoder.isConfigSupported(candidate.encoderConfig);
      if (support.supported) {
        return candidate;
      }
    } catch (_) {
      // 次の候補へ
    }
  }

  return null;
}

/**
 * 動画の完全ローカルMP4書き出し（音声トラック維持 ＆ 画面スリープ防止）
 */
export async function exportMosaicVideo(
  videoFile: File,
  videoElement: HTMLVideoElement,
  tracks: MosaicTrack[],
  options: ExportOptions = {},
  onProgress: (p: ExportProgress) => void
): Promise<Blob> {
  // 画面スリープ（消灯）を防止
  await requestScreenWakeLock();

  // 画面復帰時の自動再取得ハンドラ
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      requestScreenWakeLock();
    }
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);

  try {
    videoElement.pause();

    const duration = videoElement.duration;
    // H.264 エンコーダ要件のため偶数サイズに揃える
    const rawW = videoElement.videoWidth || 640;
    const rawH = videoElement.videoHeight || 360;
    const videoWidth = rawW % 2 === 0 ? rawW : rawW - 1;
    const videoHeight = rawH % 2 === 0 ? rawH : rawH - 1;
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
    onProgress({ currentFrame: 0, totalFrames, percent: 0, status: '音声を解析・展開中...' });
    let audioBuffer: AudioBuffer | null = null;
    try {
      const arrayBuffer = await videoFile.arrayBuffer();
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      await audioCtx.close().catch(() => {});
    } catch (err) {
      console.warn('音声トラックの取得をスキップまたは音声なし:', err);
    }

    // WebCodecs が使えるかチェック（音声がある場合は AudioEncoder の対応状況も確認）
    const hasWebCodecs =
      typeof window.VideoEncoder !== 'undefined' && typeof window.VideoFrame !== 'undefined';
    const supportedAudioConfig = audioBuffer
      ? await findSupportedAudioConfig(audioBuffer)
      : null;

    // 音声があるのに WebCodecs AudioEncoder が非対応の環境では MediaRecorder にフォールバックして音声を確実に維持
    const canUseWebCodecs = hasWebCodecs && (!audioBuffer || supportedAudioConfig !== null);

    if (canUseWebCodecs) {
      try {
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
          supportedAudioConfig,
          options,
          onProgress
        );
      } catch (wcErr) {
        console.warn('WebCodecs export failed, falling back to MediaRecorder:', wcErr);
      }
    }

    // フォールバック: MediaRecorder（WebAudio ストリーム合成対応）
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
      audioBuffer,
      options,
      onProgress
    );
  } finally {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    await releaseScreenWakeLock();
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
  supportedAudioConfig: {
    muxerCodec: 'aac' | 'opus';
    encoderConfig: AudioEncoderConfig;
  } | null,
  options: ExportOptions,
  onProgress: (p: ExportProgress) => void
): Promise<Blob> {
  const muxerTarget = new ArrayBufferTarget();

  // 音声バッファをエンコーダ設定に合わせて正規化（ステレオ2ch対応・リサンプリング対応）
  let normalizedAudio: AudioBuffer | null = null;
  if (audioBuffer && supportedAudioConfig) {
    try {
      normalizedAudio = await normalizeAudioBuffer(
        audioBuffer,
        supportedAudioConfig.encoderConfig.sampleRate,
        supportedAudioConfig.encoderConfig.numberOfChannels
      );
    } catch (e) {
      console.warn('Audio normalization failed, using original buffer:', e);
      normalizedAudio = audioBuffer;
    }
  }

  const muxer = new Muxer({
    target: muxerTarget,
    video: {
      codec: 'avc',
      width,
      height,
    },
    audio:
      normalizedAudio && supportedAudioConfig
        ? {
            codec: supportedAudioConfig.muxerCodec,
            numberOfChannels: normalizedAudio.numberOfChannels,
            sampleRate: normalizedAudio.sampleRate,
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

  // AudioEncoder（音声がある場合：ステレオ2chのf32-planarデータを正しく配置してエンコード）
  if (normalizedAudio && supportedAudioConfig && normalizedAudio.length > 0) {
    let audioEncodeError: Error | null = null;
    let audioChunksAdded = 0;
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        audioChunksAdded++;
        muxer.addAudioChunk(chunk, meta);
      },
      error: (e) => {
        console.error('AudioEncoder error', e);
        audioEncodeError = e;
      },
    });

    try {
      audioEncoder.configure({
        ...supportedAudioConfig.encoderConfig,
        numberOfChannels: normalizedAudio.numberOfChannels,
        sampleRate: normalizedAudio.sampleRate,
      });

      const sampleRate = normalizedAudio.sampleRate;
      const numChannels = normalizedAudio.numberOfChannels;
      const totalSamples = normalizedAudio.length;
      const samplesPerChunk = 1024;

      // 各チャンネルのFloat32Array参照を取得
      const channelArrays: Float32Array[] = [];
      for (let ch = 0; ch < numChannels; ch++) {
        channelArrays.push(normalizedAudio.getChannelData(ch));
      }

      for (let offset = 0; offset < totalSamples; offset += samplesPerChunk) {
        if (audioEncodeError) break;
        const frameCount = Math.min(samplesPerChunk, totalSamples - offset);

        // f32-planar 形式: [ch0の全サンプル, ch1の全サンプル, ...] のサイズ (frameCount * numChannels) を確保
        const planarData = new Float32Array(frameCount * numChannels);
        for (let ch = 0; ch < numChannels; ch++) {
          planarData.set(
            channelArrays[ch].subarray(offset, offset + frameCount),
            ch * frameCount
          );
        }

        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: frameCount,
          numberOfChannels: numChannels,
          timestamp: Math.round((offset / sampleRate) * 1_000_000),
          data: planarData,
        });
        audioEncoder.encode(audioData);
        audioData.close();
      }
      await audioEncoder.flush();
      audioEncoder.close();
    } catch (aErr) {
      try {
        audioEncoder.close();
      } catch (_) {}
      try {
        videoEncoder.close();
      } catch (_) {}
      throw aErr;
    }

    if (audioEncodeError || audioChunksAdded === 0) {
      try {
        videoEncoder.close();
      } catch (_) {}
      throw audioEncodeError || new Error('AudioEncoder produced 0 audio chunks');
    }
  }

  // 1フレームずつシークしてレンダリング
  for (let f = 0; f < totalFrames; f++) {
    if (videoEncoderError) throw videoEncoderError;

    const currentTime = (f / fps);
    videoElement.currentTime = currentTime;

    await new Promise<void>((resolve) => {
      let isDone = false;
      const timer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          videoElement.removeEventListener('seeked', onSeeked);
          resolve(); // 画面消灯・スリープ復帰時のイベント欠落でも最大1.5秒で自動回復
        }
      }, 1500);

      const onSeeked = () => {
        if (!isDone) {
          isDone = true;
          clearTimeout(timer);
          videoElement.removeEventListener('seeked', onSeeked);
          resolve();
        }
      };
      videoElement.addEventListener('seeked', onSeeked);
    });

    // 元フレーム描画
    srcCtx.drawImage(videoElement, 0, 0, width, height);
    ctx.drawImage(sourceCanvas, 0, 0, width, height);

    // モザイク適用（反転モザイクまたは通常モザイク）
    if (options.isInverseMosaic) {
      const protectedRegions: ProtectedRegion[] = [];
      for (const track of tracks) {
        if (!track.enabled) continue;
        if (currentTime < track.startTime || currentTime > track.endTime) continue;
        const pos = interpolateKeyframes(track.keyframes, currentTime);
        if (pos && !track.trackingData?.isOutOfFrame) {
          protectedRegions.push({
            shape: track.shape,
            x: pos.x,
            y: pos.y,
            width: pos.width,
            height: pos.height,
            points: pos.points,
          });
        }
      }
      renderInverseMosaic(
        ctx,
        protectedRegions,
        width,
        height,
        options.inverseMosaicType || 'blur',
        options.inverseStrength || 18,
        sourceCanvas
      );
    } else {
      for (const track of tracks) {
        if (!track.enabled) continue;
        if (currentTime < track.startTime || currentTime > track.endTime) continue;

        const pos = interpolateKeyframes(track.keyframes, currentTime);
        if (pos && !track.trackingData?.isOutOfFrame) {
          renderTrackMosaic(ctx, track, pos, sourceCanvas);
        }
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
  videoEncoder.close();
  muxer.finalize();

  return new Blob([muxerTarget.buffer], { type: 'video/mp4' });
}

// MediaRecorder フォールバック（WebAudio ストリーム合成で全ブラウザ音声維持）
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
  audioBuffer: AudioBuffer | null,
  options: ExportOptions,
  onProgress: (p: ExportProgress) => void
): Promise<Blob> {
  const stream = exportCanvas.captureStream(fps);

  // 音声トラックをキャプチャストリームに追加（AudioBufferから直接ストリーム化することでiOS/Safari等でも確実に音声維持）
  let playbackAudioCtx: AudioContext | null = null;
  let bufferSource: AudioBufferSourceNode | null = null;
  const prevMuted = videoElement.muted;

  try {
    if (audioBuffer) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      playbackAudioCtx = new AudioCtx();
      const dest = playbackAudioCtx.createMediaStreamDestination();
      bufferSource = playbackAudioCtx.createBufferSource();
      bufferSource.buffer = audioBuffer;
      bufferSource.connect(dest);
      if (dest.stream.getAudioTracks().length > 0) {
        stream.addTrack(dest.stream.getAudioTracks()[0]);
      }
      videoElement.muted = true; // エンコード中にスピーカーから重複再生されるのを防止
    } else {
      const capStream =
        (videoElement as unknown as { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream })
          .captureStream?.() ||
        (videoElement as unknown as { mozCaptureStream?: () => MediaStream }).mozCaptureStream?.();
      const audioTrack = capStream?.getAudioTracks()[0];
      if (audioTrack) {
        stream.addTrack(audioTrack);
      }
    }
  } catch (e) {
    console.warn('MediaStream audio capture unavailable', e);
  }

  const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')
    ? 'video/mp4;codecs=avc1,mp4a.40.2'
    : MediaRecorder.isTypeSupported('video/mp4')
    ? 'video/mp4'
    : MediaRecorder.isTypeSupported('video/webm;codecs=h264,opus')
    ? 'video/webm;codecs=h264,opus'
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
      try {
        bufferSource?.stop();
      } catch (_) {}
      playbackAudioCtx?.close().catch(() => {});
      videoElement.muted = prevMuted;
      resolve(new Blob(chunks, { type: mimeType }));
    };
  });

  recorder.start();
  if (bufferSource && playbackAudioCtx) {
    if (playbackAudioCtx.state === 'suspended') {
      await playbackAudioCtx.resume().catch(() => {});
    }
    bufferSource.start(0);
  }

  videoElement.currentTime = 0;
  await videoElement.play().catch(() => {});

  const renderLoop = () => {
    const curTime = videoElement.currentTime;
    srcCtx.drawImage(videoElement, 0, 0, exportCanvas.width, exportCanvas.height);
    ctx.drawImage(sourceCanvas, 0, 0, exportCanvas.width, exportCanvas.height);

    if (options.isInverseMosaic) {
      const protectedRegions: ProtectedRegion[] = [];
      for (const track of tracks) {
        if (!track.enabled) continue;
        if (curTime < track.startTime || curTime > track.endTime) continue;
        const pos = interpolateKeyframes(track.keyframes, curTime);
        if (pos && !track.trackingData?.isOutOfFrame) {
          protectedRegions.push({
            shape: track.shape,
            x: pos.x,
            y: pos.y,
            width: pos.width,
            height: pos.height,
            points: pos.points,
          });
        }
      }
      renderInverseMosaic(
        ctx,
        protectedRegions,
        exportCanvas.width,
        exportCanvas.height,
        options.inverseMosaicType || 'blur',
        options.inverseStrength || 18,
        sourceCanvas
      );
    } else {
      for (const track of tracks) {
        if (!track.enabled) continue;
        if (curTime < track.startTime || curTime > track.endTime) continue;
        const pos = interpolateKeyframes(track.keyframes, curTime);
        if (pos && !track.trackingData?.isOutOfFrame) {
          renderTrackMosaic(ctx, track, pos, sourceCanvas);
        }
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

