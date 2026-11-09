import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from 'mp4-muxer';
import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } from 'mediabunny';
import { MosaicTrack, MosaicType } from '../types';
import { interpolateKeyframes } from './tracking';
import { renderTrackMosaic, renderInverseMosaic, ProtectedRegion } from './mosaicRenderer';
import { requestScreenWakeLock, releaseScreenWakeLock } from './wakeLock';
import { getClampedDimensions } from './geometry';

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

interface MuxerOutputTarget {
  target: ArrayBufferTarget | FileSystemWritableFileStreamTarget;
  fastStart: false | 'in-memory';
  finalizeAndGetBlob: () => Promise<Blob>;
}

/**
 * OPFS（Origin Private File System）または ArrayBufferTarget を初期化
 * OPFS利用時はディスクへ直接ストリーム書き込みを行うため、スマホでもメモリ（RAM）を枯渇させません。
 */
async function prepareMuxerTarget(): Promise<MuxerOutputTarget> {
  // OPFS (Origin Private File System) を優先使用
  if (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === 'function' &&
    typeof window.FileSystemWritableFileStream !== 'undefined'
  ) {
    try {
      const root = await navigator.storage.getDirectory();

      // 過去の一時エクスポートファイルを安全にクリーンアップ
      try {
        for await (const [name] of (root as any).entries()) {
          if (name.startsWith('export_temp_') && name.endsWith('.mp4')) {
            await root.removeEntry(name).catch(() => {});
          }
        }
      } catch (_) {}

      const tempFileName = `export_temp_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`;
      const draftHandle = await root.getFileHandle(tempFileName, { create: true });
      const writable = await draftHandle.createWritable();
      const target = new FileSystemWritableFileStreamTarget(writable, {
        chunkSize: 2 * 1024 * 1024, // 2MB単位でディスクへストリーム書き込み
      });

      return {
        target,
        fastStart: false, // ディスク直接書き込み。finalize時に末尾へmoovアトムを出力してインデックス構築
        finalizeAndGetBlob: async () => {
          await writable.close();
          const file = await draftHandle.getFile();
          return file;
        },
      };
    } catch (opfsErr) {
      console.warn('OPFS initialization failed, fallback to ArrayBufferTarget:', opfsErr);
    }
  }

  // フォールバック: ArrayBufferTarget（fastStart: 'in-memory' でメモリ上に完全なmoovアトムを構築）
  const bufferTarget = new ArrayBufferTarget();
  return {
    target: bufferTarget,
    fastStart: 'in-memory',
    finalizeAndGetBlob: async () => {
      const blob = new Blob([bufferTarget.buffer], { type: 'video/mp4' });
      try {
        (bufferTarget as any).buffer = null;
      } catch (_) {}
      return blob;
    },
  };
}

/**
 * ビデオ要素の指定秒への確実なシーク（待機タイムアウト＆重複シーク防止付き）
 */
async function seekVideoElement(video: HTMLVideoElement, targetTime: number): Promise<void> {
  if (Math.abs(video.currentTime - targetTime) < 0.005) {
    return;
  }
  return new Promise<void>((resolve) => {
    let isDone = false;
    const timer = setTimeout(() => {
      if (!isDone) {
        isDone = true;
        video.removeEventListener('seeked', onSeeked);
        resolve(); // 万一seekedイベントが欠落しても最大800msで自己回復
      }
    }, 800);

    const onSeeked = () => {
      if (!isDone) {
        isDone = true;
        clearTimeout(timer);
        video.removeEventListener('seeked', onSeeked);
        resolve();
      }
    };

    video.addEventListener('seeked', onSeeked, { once: true });
    video.currentTime = targetTime;
  });
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
      muxerCodec: 'aac',
      encoderConfig: {
        codec: 'mp4a.40.2',
        numberOfChannels: 2,
        sampleRate: 48000,
        bitrate: 128_000,
      },
    },
    {
      muxerCodec: 'aac',
      encoderConfig: {
        codec: 'mp4a.40.2',
        numberOfChannels: 2,
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
 * WebCodecs VideoEncoder で端末が対応しているH.264プロファイルを検出
 */
async function findSupportedVideoConfig(
  width: number,
  height: number,
  fps: number,
  bitrate: number
): Promise<VideoEncoderConfig> {
  const candidates: VideoEncoderConfig[] = [
    {
      codec: 'avc1.42001f', // Baseline profile level 3.1
      width,
      height,
      bitrate,
      framerate: fps,
    },
    {
      codec: 'avc1.4d001f', // Main profile level 3.1
      width,
      height,
      bitrate,
      framerate: fps,
    },
    {
      codec: 'avc1.64001f', // High profile level 3.1
      width,
      height,
      bitrate,
      framerate: fps,
    },
    {
      codec: 'avc1.42E01E', // Baseline profile level 3.0
      width,
      height,
      bitrate,
      framerate: fps,
    },
  ];

  for (const candidate of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported(candidate);
      if (support.supported) {
        return candidate;
      }
    } catch (_) {}
  }

  return candidates[0];
}

/**
 * ブラウザが WebCodecs API (VideoEncoder / VideoFrame) をサポートしているか判定
 */
export function isWebCodecsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.VideoEncoder !== 'undefined' &&
    typeof window.VideoFrame !== 'undefined'
  );
}

/**
 * LINE, Twitter/X, Instagram, Facebook 等のアプリ内ブラウザ（In-App Browser）か判定
 */
export function isInAppBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Line|FBAN|FBAV|Instagram|Twitter|Snapchat|MicroMessenger/i.test(ua);
}

interface PreparedAudioPipeline {
  audioConfig?: {
    codec: 'aac' | 'opus';
    numberOfChannels: number;
    sampleRate: number;
  };
  addAudioChunks: (muxer: Muxer<any>) => Promise<void>;
}

/**
 * WebCodecs AudioEncoder を使用して PCM AudioBuffer を AAC チャンクへエンコードして muxer へ追加
 */
async function encodePcmToMuxer(
  muxer: Muxer<any>,
  normalizedAudio: AudioBuffer,
  encoderConfig: AudioEncoderConfig,
  duration: number
): Promise<void> {
  let audioEncodeError: Error | null = null;
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => {
      console.error('AudioEncoder error', e);
      audioEncodeError = e;
    },
  });

  let channelArrays: Float32Array[] = [];
  try {
    audioEncoder.configure({
      ...encoderConfig,
      numberOfChannels: normalizedAudio.numberOfChannels,
      sampleRate: normalizedAudio.sampleRate,
    });

    const sampleRate = normalizedAudio.sampleRate;
    const numChannels = normalizedAudio.numberOfChannels;
    const maxAudioSamples = Math.ceil(duration * sampleRate);
    const totalSamples = Math.min(normalizedAudio.length, maxAudioSamples);
    const samplesPerChunk = 1024; // AAC固定ブロック長

    channelArrays = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channelArrays.push(normalizedAudio.getChannelData(ch));
    }

    for (let offset = 0; offset < totalSamples; offset += samplesPerChunk) {
      if (audioEncodeError) break;
      const frameCount = Math.min(samplesPerChunk, totalSamples - offset);

      const planarData = new Float32Array(samplesPerChunk * numChannels);
      for (let ch = 0; ch < numChannels; ch++) {
        planarData.set(
          channelArrays[ch].subarray(offset, offset + frameCount),
          ch * samplesPerChunk
        );
      }

      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: samplesPerChunk,
        numberOfChannels: numChannels,
        timestamp: Math.round((offset / sampleRate) * 1_000_000),
        data: planarData,
      });
      audioEncoder.encode(audioData);
      audioData.close();

      while (audioEncoder.encodeQueueSize > 6) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    await audioEncoder.flush();
    audioEncoder.close();
  } catch (aErr) {
    try {
      audioEncoder.close();
    } catch (_) {}
    throw aErr;
  } finally {
    channelArrays.length = 0;
  }

  if (audioEncodeError) {
    throw audioEncodeError;
  }
}

/**
 * 音声トラックの抽出・エンコードパイプラインを準備
 * 1. Mediabunny による直接ストリームコピー（iOS Safari / Android / PC で無劣化・最速・AudioEncoder不要）
 * 2. Web Audio API + WebCodecs AudioEncoder（特殊形式向けのフォールバック）
 * 3. 音声なし動画
 */
async function prepareAudioPipeline(
  videoFile: File,
  duration: number,
  onProgress: (status: string) => void
): Promise<PreparedAudioPipeline> {
  onProgress('元動画の音声トラックを解析中...');

  // 戦略1 (最優先・iOS/Android完全対応):
  // Mediabunny によるコンテナ直接デマルチプレクス（パケットストリームコピー）
  // AAC / Opus パケットを再エンコードなしで直接抽出するため、
  // iOS Safari の「AudioEncoder 未実装」および「decodeAudioData の MOV/MP4 失敗」を 100% 回避！
  try {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(videoFile),
    });

    const audioTrack = await input.getPrimaryAudioTrack();
    if (audioTrack) {
      const codec = await audioTrack.getCodec();
      if (codec === 'aac' || codec === 'opus') {
        const sampleRate = await audioTrack.getSampleRate();
        const numberOfChannels = await audioTrack.getNumberOfChannels();

        return {
          audioConfig: {
            codec,
            numberOfChannels,
            sampleRate,
          },
          addAudioChunks: async (muxer: Muxer<any>) => {
            onProgress('音声トラック（無劣化ストリーム）を結合中...');
            const sink = new EncodedPacketSink(audioTrack);
            for await (const packet of sink.packets()) {
              if (packet.timestamp > duration + 0.1) break;
              const timestampUs = Math.round(Math.max(0, packet.timestamp) * 1e6);
              const durationUs = Math.round(packet.duration * 1e6);
              muxer.addAudioChunkRaw(packet.data, packet.type, timestampUs, durationUs);
            }
          },
        };
      }
    }
  } catch (directErr) {
    console.warn('Mediabunny direct audio extraction failed, attempting Web Audio API fallback:', directErr);
  }

  // 戦略2 (フォールバック): Web Audio API decodeAudioData + AudioEncoder
  if (typeof window.AudioEncoder !== 'undefined') {
    try {
      const isMobile =
        typeof navigator !== 'undefined' &&
        /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      const MAX_AUDIO_SAFE_FILE_SIZE = isMobile ? 120 * 1024 * 1024 : 350 * 1024 * 1024;

      if (videoFile.size <= MAX_AUDIO_SAFE_FILE_SIZE) {
        onProgress('音声トラックを展開中 (Web Audio API)...');
        let arrayBuffer: ArrayBuffer | null = await videoFile.arrayBuffer();
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const audioCtx = new AudioCtx();
        let audioBuffer: AudioBuffer | null = null;
        try {
          audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        } finally {
          arrayBuffer = null;
          await audioCtx.close().catch(() => {});
        }

        if (audioBuffer) {
          const supportedAudioConfig = await findSupportedAudioConfig(audioBuffer);
          if (supportedAudioConfig) {
            let normalizedAudio: AudioBuffer | null = null;
            try {
              normalizedAudio = await normalizeAudioBuffer(
                audioBuffer,
                supportedAudioConfig.encoderConfig.sampleRate,
                supportedAudioConfig.encoderConfig.numberOfChannels
              );
              if (normalizedAudio !== audioBuffer) {
                audioBuffer = null;
              }
            } catch (_) {
              normalizedAudio = audioBuffer;
            }

            if (normalizedAudio && normalizedAudio.length > 0) {
              const currentNormAudio = normalizedAudio;
              return {
                audioConfig: {
                  codec: supportedAudioConfig.muxerCodec,
                  numberOfChannels: currentNormAudio.numberOfChannels,
                  sampleRate: currentNormAudio.sampleRate,
                },
                addAudioChunks: async (muxer: Muxer<any>) => {
                  onProgress('音声トラックをエンコード中 (WebCodecs)...');
                  await encodePcmToMuxer(
                    muxer,
                    currentNormAudio,
                    supportedAudioConfig.encoderConfig,
                    duration
                  );
                },
              };
            }
          }
        }
      }
    } catch (fallbackErr) {
      console.warn('Web Audio fallback failed:', fallbackErr);
    }
  }

  // 戦略3: 音声なし
  return {
    addAudioChunks: async () => {},
  };
}

/**
 * 動画の完全ローカルMP4書き出し（WebCodecs API + mp4-muxer による完全なmoovアトム構築）
 */
export async function exportMosaicVideo(
  videoFile: File,
  videoElement: HTMLVideoElement,
  tracks: MosaicTrack[],
  options: ExportOptions = {},
  onProgress: (p: ExportProgress) => void
): Promise<Blob> {
  // WebCodecs サポートチェック
  if (!isWebCodecsSupported()) {
    if (isInAppBrowser()) {
      throw new Error(
        'LINEやSNS等のアプリ内ブラウザではWebCodecs動画書き出しが制限されています。画面右上のメニュー（︙等）から「ブラウザで開く（SafariまたはChrome）」を選択してご利用ください。'
      );
    }
    throw new Error(
      'お使いのブラウザはWebCodecs API（高精度MP4出力）に対応していません。最新バージョンのSafari、Chrome、またはEdgeをご利用ください。'
    );
  }

  // 画面スリープ（消灯）を防止
  await requestScreenWakeLock();

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      requestScreenWakeLock();
    }
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);

  try {
    videoElement.pause();

    const duration = videoElement.duration || 1;
    // スマホでのメモリクラッシュ（OOM）防止＆プレビュー作業解像度との100%座標同期のため長辺1280px以下にクランプ（偶数ピクセル保証）
    const rawW = videoElement.videoWidth || 640;
    const rawH = videoElement.videoHeight || 360;
    const { width: videoWidth, height: videoHeight } = getClampedDimensions(rawW, rawH, 1280);
    const fps = 30;
    const totalFrames = Math.max(1, Math.floor(duration * fps));

    // レンダリング用キャンバス準備
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

    // 1. 音声トラックの解析・準備（超高速＆スマホ完全対応のストリーム抽出を優先）
    const audioPipeline = await prepareAudioPipeline(videoFile, duration, (status) => {
      onProgress({ currentFrame: 0, totalFrames, percent: 0, status });
    });

    // 2. mp4-muxer 出力ターゲット（OPFS または ArrayBufferTarget）の準備
    const outputTarget = await prepareMuxerTarget();

    const muxer = new Muxer({
      target: outputTarget.target,
      video: {
        codec: 'avc',
        width: videoWidth,
        height: videoHeight,
        frameRate: fps,
      },
      audio: audioPipeline.audioConfig,
      fastStart: outputTarget.fastStart,
      firstTimestampBehavior: 'offset',
    });

    // 3. VideoEncoder の設定
    const videoConfig = await findSupportedVideoConfig(videoWidth, videoHeight, fps, 2_500_000);
    let videoEncoderError: Error | null = null;
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        console.error('VideoEncoder error', e);
        videoEncoderError = e;
      },
    });
    videoEncoder.configure(videoConfig);

    // 4. 音声チャンクの書き込み（無劣化ストリームまたはWebCodecsエンコード）
    if (audioPipeline.audioConfig) {
      await audioPipeline.addAudioChunks(muxer);
    }

    // 5. 映像フレームの順次レンダリングとエンコード
    for (let f = 0; f < totalFrames; f++) {
      if (videoEncoderError) throw videoEncoderError;

      // バックプレッシャー: 未処理フレームがキューにたまっている場合は待機（GPU/RAMのOOM防止）
      while (videoEncoder.encodeQueueSize > 2) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const currentTime = f / fps;
      await seekVideoElement(videoElement, currentTime);

      // 元フレーム描画
      srcCtx.drawImage(videoElement, 0, 0, videoWidth, videoHeight);
      ctx.drawImage(sourceCanvas, 0, 0, videoWidth, videoHeight);

      // モザイク適用（反転モザイクまたは通常モザイク）
      if (options.isInverseMosaic) {
        const protectedRegions: ProtectedRegion[] = [];
        for (const track of tracks) {
          if (!track.enabled) continue;
          if (currentTime < track.startTime || currentTime > track.endTime) continue;
          const pos = interpolateKeyframes(track.keyframes, currentTime, {
            screenWidth: videoWidth,
            screenHeight: videoHeight,
            hasFutureManualKeyframe: track.keyframes.some((k) => k.time > currentTime),
          });
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
          videoWidth,
          videoHeight,
          options.inverseMosaicType || 'blur',
          options.inverseStrength || 18,
          sourceCanvas
        );
      } else {
        for (const track of tracks) {
          if (!track.enabled) continue;
          if (currentTime < track.startTime || currentTime > track.endTime) continue;

          const pos = interpolateKeyframes(track.keyframes, currentTime, {
            screenWidth: videoWidth,
            screenHeight: videoHeight,
            hasFutureManualKeyframe: track.keyframes.some((k) => k.time > currentTime),
          });
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

      // 1秒ごと（30フレームごと）に必ずIDRキーフレームを生成してシークバーの移動を軽快にする
      const isKeyframe = f % 30 === 0;
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

    // 6. 完了処理（moovアトムの書き込みとインデックス構築）
    onProgress({
      currentFrame: totalFrames,
      totalFrames,
      percent: 100,
      status: 'MP4（moovアトム・シーク目次）を構築中...',
    });

    await videoEncoder.flush();
    videoEncoder.close();
    muxer.finalize();

    return await outputTarget.finalizeAndGetBlob();
  } finally {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    await releaseScreenWakeLock();
  }
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
