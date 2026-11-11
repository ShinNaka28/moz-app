import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from 'mp4-muxer';
import {
  Input,
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  InputVideoTrack,
  EncodedPacketSink,
  AudioBufferSink,
} from 'mediabunny';
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
  includeAudio?: boolean;
}

interface MuxerOutputTarget {
  target: ArrayBufferTarget | FileSystemWritableFileStreamTarget;
  fastStart: false | 'in-memory';
  finalizeAndGetBlob: () => Promise<Blob>;
}

/**
 * MP4 出力ターゲットの初期化
 *
 * 【重要バグ修正】:
 * 1. mp4-muxer の FileSystemWritableFileStreamTarget (fastStart: false) は
 *    内部で writable.write() の Promise を await せずに同期呼び出しするため、
 *    finalize() 直後の writable.close() で未完了チャンクや moov アトムのフラッシュ競合が起きるリスクがありました。
 * 2. また fastStart: false では mdat の 64-bit 予約領域(16バイト)と finalize 時の 32-bit パッチ(8バイト)の差により
 *    moov がファイル末尾に配置され、スマホの再生プレイヤーや SNS 共有で音声トラックの認識・シークに支障が出ることがあります。
 * 3. そのため、通常の動画（180秒以下・2.5Mbpsで約56MB以下）では ArrayBufferTarget (fastStart: 'in-memory') を優先使用し、
 *    moov アトムをファイル先頭に配置した完全な FastStart MP4 を構築します。
 * 4. 180秒を超える長尺動画のみ OPFS を使用し、writable.write の Promise キューを確実に await してから close します。
 */
async function prepareMuxerTarget(durationSec: number): Promise<MuxerOutputTarget> {
  const useOpfsForLongVideo =
    durationSec > 180 &&
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === 'function' &&
    typeof window.FileSystemWritableFileStream !== 'undefined';

  if (useOpfsForLongVideo) {
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

      // mp4-muxer が内部で await せずに呼ぶ writable.write() を直列 Promise チェーンで追跡
      let writeChain: Promise<unknown> = Promise.resolve();
      const origWrite = writable.write.bind(writable);
      writable.write = ((data: any) => {
        const p = writeChain.then(() => origWrite(data));
        writeChain = p.catch(() => {});
        return p;
      }) as typeof writable.write;

      const target = new FileSystemWritableFileStreamTarget(writable, {
        chunkSize: 2 * 1024 * 1024,
      });

      return {
        target,
        fastStart: false,
        finalizeAndGetBlob: async () => {
          await writeChain;
          await writable.close();
          const file = await draftHandle.getFile();
          return file;
        },
      };
    } catch (opfsErr) {
      console.warn('OPFS initialization failed, fallback to ArrayBufferTarget:', opfsErr);
    }
  }

  // 標準: ArrayBufferTarget（fastStart: 'in-memory' でファイル先頭に完全な moov アトムを構築）
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
 * ビデオ要素の指定秒への確実なシーク（待機タイムアウト＆重複シーク防止＆GPUテクスチャ同期付き）
 *
 * 【GPUテクスチャ同期とコマ重複（カクツキ）根絶の仕組み】:
 * Chromium/WebKit では、seeked イベントが発火した直後、デコードされた新しいフレームテクスチャが
 * Canvas 2D コンテキスト（drawImage）側にスワップされるまでわずかな時間差が存在します。
 * そのため、seeked 直後に drawImage を行うと「1つ前のフレーム」が描画され、コマ重複（2コマずつ同一画像）
 * が発生してカクツキとなります。
 * そこで、requestVideoFrameCallback が利用可能な場合はフレームの提示を待ち、
 * 非対応環境やタイムアウト時でも V-Sync 周期に応じたマクロタスク開放（16ms）を設けることで、
 * GPUテクスチャが確実に更新された状態でキャンバスへ転写させます。
 */
async function seekVideoElement(video: HTMLVideoElement, targetTime: number): Promise<void> {
  const maxSafeTime = Math.max(0, (video.duration || 1) - 0.001);
  const clampedTarget = Math.min(maxSafeTime, Math.max(0, targetTime));

  if (Math.abs(video.currentTime - clampedTarget) < 0.002) {
    return;
  }

  return new Promise<void>((resolve) => {
    let isDone = false;
    let rvfcId: number | null = null;

    const finish = () => {
      if (!isDone) {
        isDone = true;
        clearTimeout(timer);
        if (rvfcId !== null && typeof (video as any).cancelVideoFrameCallback === 'function') {
          try {
            (video as any).cancelVideoFrameCallback(rvfcId);
          } catch (_) {}
        }
        video.removeEventListener('seeked', onSeeked);
        resolve();
      }
    };

    const timer = setTimeout(finish, 400);

    const onSeeked = () => {
      if (typeof (video as any).requestVideoFrameCallback === 'function') {
        try {
          let rvfcTimedOut = false;
          const rvfcTimer = setTimeout(() => {
            rvfcTimedOut = true;
            finish();
          }, 35);

          rvfcId = (video as any).requestVideoFrameCallback(() => {
            if (!rvfcTimedOut) {
              clearTimeout(rvfcTimer);
              finish();
            }
          });
          return;
        } catch (_) {}
      }
      // RVFC 非対応ブラウザや失敗時は 1 フレーム分のマクロタスク開放待機
      setTimeout(finish, 16);
    };

    video.addEventListener('seeked', onSeeked, { once: true });
    try {
      video.currentTime = clampedTarget;
    } catch (_) {
      finish();
    }
  });
}

// ============================================================================
// AAC AudioSpecificConfig (esds) & ADTS ヘッダー解析・正規化ヘルパー
// ============================================================================

const AAC_FREQUENCY_TABLE: readonly number[] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * ISO/IEC 14496-3 に準拠した標準 AAC AudioSpecificConfig バイト列を生成
 * mp4-muxer の esds ボックスに確実に有効な DecoderSpecificInfo (Tag 0x05) を書き込むために使用します。
 */
function buildAacAudioSpecificConfigBytes(
  objectType: number,
  sampleRate: number,
  numberOfChannels: number
): Uint8Array {
  const safeObjectType = objectType > 0 && objectType < 32 ? objectType : 2; // 2 = AAC-LC
  const safeChannels = Math.min(7, Math.max(1, numberOfChannels || 2));
  const freqIndex = AAC_FREQUENCY_TABLE.indexOf(sampleRate);

  if (freqIndex !== -1) {
    // 5 bits: objectType, 4 bits: freqIndex, 4 bits: channelConfig, 3 bits: 0
    const byte0 = ((safeObjectType & 0x1f) << 3) | ((freqIndex & 0x0e) >> 1);
    const byte1 = ((freqIndex & 0x01) << 7) | ((safeChannels & 0x0f) << 3);
    return new Uint8Array([byte0, byte1]);
  }

  // 非標準サンプルレート時は freqIndex = 15 (0x0f) + 24-bit 明示サンプルレート
  const bits: number[] = [];
  const pushBits = (val: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((val >> i) & 1);
    }
  };
  pushBits(safeObjectType, 5);
  pushBits(15, 4);
  pushBits(sampleRate, 24);
  pushBits(safeChannels, 4);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bits[i * 8 + j];
    }
    out[i] = b;
  }
  return out;
}

/**
 * Android Chrome 等の WebCodecs AudioEncoder が ADTS ヘッダー付きフレーム (0xFFF...) を出力した場合に
 * ヘッダー長と AAC 設定を抽出し、MP4 mdat 格納用に生 AAC フレームへストリップするためのヘルパー
 */
function parseAdtsHeader(data: Uint8Array): {
  headerLength: number;
  objectType: number;
  sampleRate: number;
  numberOfChannels: number;
  asc: Uint8Array;
} | null {
  if (data.byteLength < 7) return null;
  // Syncword 12 bits: 0xFFF
  if (data[0] !== 0xff || (data[1] & 0xf0) !== 0xf0) return null;
  // Layer (2 bits) must be 00 for AAC ADTS
  if ((data[1] & 0x06) !== 0x00) return null;

  const protectionAbsent = data[1] & 0x01;
  const headerLength = protectionAbsent === 1 ? 7 : 9;
  if (data.byteLength <= headerLength) return null;

  const profile = (data[2] >> 6) & 0x03;
  const objectType = profile + 1; // 2 = AAC-LC
  const freqIndex = (data[2] >> 2) & 0x0f;
  const channelConfig = ((data[2] & 0x01) << 2) | ((data[3] >> 6) & 0x03);

  const sampleRate = AAC_FREQUENCY_TABLE[freqIndex] || 48000;
  const numberOfChannels = channelConfig > 0 && channelConfig < 8 ? channelConfig : 2;
  const asc = buildAacAudioSpecificConfigBytes(objectType, sampleRate, numberOfChannels);

  return {
    headerLength,
    objectType,
    sampleRate,
    numberOfChannels,
    asc,
  };
}

/**
 * BufferSource (ArrayBuffer / Uint8Array / DataView) を安全に Uint8Array へ変換
 */
function toUint8Array(buf?: AllowSharedBufferSource | null): Uint8Array | null {
  if (!buf) return null;
  if (buf instanceof Uint8Array) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  if (ArrayBuffer.isView(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  if (buf instanceof ArrayBuffer) {
    return new Uint8Array(buf);
  }
  return null;
}

/**
 * ES_Descriptor (Tag 0x03) 全体が渡された場合、内部の DecoderSpecificInfo (Tag 0x05) を取り出す
 */
function unwrapEsdsDecoderSpecificInfo(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 2 || bytes[0] !== 0x03) {
    return bytes;
  }
  // Tag 0x05 (DecoderSpecificInfo) を探索して切り出す
  let pos = 0;
  const readTagAndSize = (): { tag: number; size: number } | null => {
    if (pos >= bytes.byteLength) return null;
    const tag = bytes[pos++];
    let size = 0;
    let numBytes = 0;
    while (pos < bytes.byteLength && numBytes < 4) {
      const b = bytes[pos++];
      size = (size << 7) | (b & 0x7f);
      numBytes++;
      if ((b & 0x80) === 0) break;
    }
    return { tag, size };
  };

  const esDescr = readTagAndSize();
  if (!esDescr || esDescr.tag !== 0x03) return bytes;
  if (pos + 3 > bytes.byteLength) return bytes;
  const flags = bytes[pos + 2];
  pos += 3;
  if (flags & 0x80) pos += 2; // streamDependenceFlag
  if (flags & 0x40) {
    // URL_Flag
    const urlLen = bytes[pos] || 0;
    pos += 1 + urlLen;
  }
  if (flags & 0x20) pos += 2; // OCRstreamFlag

  const decConfig = readTagAndSize();
  if (!decConfig || decConfig.tag !== 0x04) return bytes;
  pos += 13; // objectTypeIndication(1) + streamType(1) + bufferSizeDB(3) + maxBitrate(4) + avgBitrate(4)

  const decSpecific = readTagAndSize();
  if (decSpecific && decSpecific.tag === 0x05 && decSpecific.size >= 2 && pos + decSpecific.size <= bytes.byteLength) {
    return bytes.slice(pos, pos + decSpecific.size);
  }
  return bytes;
}

/**
 * AudioSpecificConfig バイト列から objectType, コアサンプルレート, HE-AAC(SBR/PS) 有無を解析
 */
function inspectAacAudioSpecificConfig(rawDesc?: AllowSharedBufferSource | null): {
  valid: boolean;
  objectType: number;
  coreSampleRate: number | null;
  coreChannels: number | null;
  isHeAacOrExtended: boolean;
  bytes: Uint8Array | null;
} {
  const rawBytes = toUint8Array(rawDesc);
  if (!rawBytes || rawBytes.byteLength < 2) {
    return {
      valid: false,
      objectType: 0,
      coreSampleRate: null,
      coreChannels: null,
      isHeAacOrExtended: false,
      bytes: null,
    };
  }

  const bytes = unwrapEsdsDecoderSpecificInfo(rawBytes);
  if (bytes.byteLength < 2) {
    return {
      valid: false,
      objectType: 0,
      coreSampleRate: null,
      coreChannels: null,
      isHeAacOrExtended: false,
      bytes: null,
    };
  }

  let bitPos = 0;
  const readBits = (n: number): number => {
    let val = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = bitPos >> 3;
      if (byteIdx >= bytes.byteLength) return 0;
      const bitIdx = 7 - (bitPos & 7);
      val = (val << 1) | ((bytes[byteIdx] >> bitIdx) & 1);
      bitPos++;
    }
    return val;
  };

  let objectType = readBits(5);
  if (objectType === 31) {
    objectType = 32 + readBits(6);
  }
  const freqIndex = readBits(4);
  const coreSampleRate =
    freqIndex === 15 ? readBits(24) : AAC_FREQUENCY_TABLE[freqIndex] ?? null;
  const channelConfig = readBits(4);
  const coreChannels = channelConfig > 0 && channelConfig < 8 ? channelConfig : null;

  // objectType === 5 (SBR / HE-AAC v1), 29 (PS / HE-AAC v2), または 2 バイト超の拡張設定(明示的/暗黙的SBR等)
  const isHeAacOrExtended =
    objectType === 5 || objectType === 29 || objectType !== 2 || bytes.byteLength > 2;

  return {
    valid: objectType > 0,
    objectType,
    coreSampleRate,
    coreChannels,
    isHeAacOrExtended,
    bytes,
  };
}

/**
 * mp4-muxer の esds アトムが絶対に 0 バイト（undefined 上書きバグ）や不正値にならないよう
 * AudioSpecificConfig (description) を検証・補完
 */
function ensureValidAacDescription(
  rawDesc: AllowSharedBufferSource | null | undefined,
  sampleRate: number,
  numberOfChannels: number,
  fallbackAsc?: Uint8Array | null
): Uint8Array {
  const info = inspectAacAudioSpecificConfig(rawDesc);
  if (info.valid && info.bytes && info.bytes.byteLength >= 2) {
    return info.bytes;
  }
  if (fallbackAsc && fallbackAsc.byteLength >= 2) {
    return fallbackAsc;
  }
  return buildAacAudioSpecificConfigBytes(2, sampleRate, numberOfChannels);
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
 * WebCodecs AudioEncoder で利用可能な AAC-LC 音声エンコード設定を検出
 * （すべてのスマホ・PC・SNSプレイヤーで100%再生可能な AAC-LC を最優先し、aac: { format: 'aac' } を指定）
 */
async function findSupportedAudioConfig(
  preferredSampleRate: number,
  preferredChannels: number
): Promise<{
  muxerCodec: 'aac' | 'opus';
  encoderConfig: AudioEncoderConfig;
} | null> {
  if (typeof window.AudioEncoder === 'undefined') return null;

  const targetChannels = Math.min(2, Math.max(1, preferredChannels || 2));
  const sampleRates = Array.from(
    new Set([preferredSampleRate, 48000, 44100].filter((sr) => sr >= 8000 && sr <= 96000))
  );
  const channelOptions = Array.from(new Set([targetChannels, 2, 1]));

  const candidates: Array<{
    muxerCodec: 'aac' | 'opus';
    encoderConfig: AudioEncoderConfig;
  }> = [];

  // 1. aac: { format: 'aac' } 明示付きの AAC-LC 候補（ADTS 混入を防止）
  for (const sr of sampleRates) {
    for (const ch of channelOptions) {
      candidates.push({
        muxerCodec: 'aac',
        encoderConfig: {
          codec: 'mp4a.40.2',
          numberOfChannels: ch,
          sampleRate: sr,
          bitrate: 128_000,
          aac: { format: 'aac' },
        } as AudioEncoderConfig,
      });
    }
  }

  // 2. aac オプション非対応ブラウザ向けの標準 AAC-LC 候補
  for (const sr of sampleRates) {
    for (const ch of channelOptions) {
      candidates.push({
        muxerCodec: 'aac',
        encoderConfig: {
          codec: 'mp4a.40.2',
          numberOfChannels: ch,
          sampleRate: sr,
          bitrate: 128_000,
        },
      });
    }
  }

  // 3. 最終フォールバック: Opus
  candidates.push({
    muxerCodec: 'opus',
    encoderConfig: {
      codec: 'opus',
      numberOfChannels: targetChannels,
      sampleRate: 48000,
      bitrate: 128_000,
    },
  });

  for (const candidate of candidates) {
    try {
      const support = await AudioEncoder.isConfigSupported(candidate.encoderConfig);
      if (support.supported) {
        return {
          muxerCodec: candidate.muxerCodec,
          encoderConfig: support.config || candidate.encoderConfig,
        };
      }
    } catch (_) {
      // 次の候補へ
    }
  }

  return null;
}

/**
 * 解像度（幅・高さ）とFPSから必要なH.264 (AVC) レベルを算出し、端末が対応する最適なエンコード設定を自動検出
 */
async function findSupportedVideoConfig(
  width: number,
  height: number,
  fps: number,
  bitrate: number
): Promise<VideoEncoderConfig> {
  // H.264のマクロブロック（16x16）数を計算
  const mbW = Math.ceil(width / 16);
  const mbH = Math.ceil(height / 16);
  const totalMacroblocks = mbW * mbH;

  // スマホの縦動画（例: 732x1280 -> 736*1280 = 942,080 px）は Level 3.1 (921,600) を超過するため、
  // 最低でも Level 4.0 / 4.1 / 4.2 が必須となります。
  const levels =
    totalMacroblocks > 3600
      ? ['29', '28', '2a', '33', '32', '20', '1f'] // Level 4.1, 4.0, 4.2, 5.1, 5.0, 3.2, 3.1
      : ['29', '28', '1f', '2a', '20', '33', '32'];

  const profiles = [
    '4d00', // Main Profile (高画質・広範なスマホ互換)
    '4200', // Baseline Profile (全スマホ・PC対応)
    '6400', // High Profile
    '42E0', // Constrained Baseline
  ];

  const candidates: VideoEncoderConfig[] = [];
  for (const lvl of levels) {
    for (const prof of profiles) {
      candidates.push({
        codec: `avc1.${prof}${lvl}`,
        width,
        height,
        bitrate,
        framerate: fps,
        hardwareAcceleration: 'no-preference',
      });
    }
  }

  for (const candidate of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported(candidate);
      if (support.supported) {
        return candidate;
      }
    } catch (_) {}
  }

  // フォールバック: 1080pまで万能対応する Level 4.1 Main Profile
  return {
    codec: 'avc1.4d0029',
    width,
    height,
    bitrate,
    framerate: fps,
  };
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

interface PreparedAudioChunk {
  data: Uint8Array;
  type: 'key' | 'delta';
  timestampUs: number;
  durationUs: number;
  meta?: EncodedAudioChunkMetadata;
}

interface PreparedAudioPipeline {
  audioConfig?: {
    codec: 'aac' | 'opus';
    numberOfChannels: number;
    sampleRate: number;
  };
  chunks: PreparedAudioChunk[];
}

/**
 * WebCodecs AudioEncoder を使用して PCM AudioBuffer をエンコードし、
 * ADTS ヘッダー除去および esds AudioSpecificConfig (description) 欠落補完を施したチャンク配列を生成
 */
async function encodePcmToAudioChunks(
  normalizedAudio: AudioBuffer,
  encoderConfig: AudioEncoderConfig,
  muxerCodec: 'aac' | 'opus',
  duration: number
): Promise<PreparedAudioChunk[]> {
  let audioEncodeError: Error | null = null;
  const chunks: PreparedAudioChunk[] = [];
  const sampleRate = normalizedAudio.sampleRate;
  const numChannels = normalizedAudio.numberOfChannels;

  let rawDecoderConfig: AudioDecoderConfig | undefined;
  let adtsDerivedAsc: Uint8Array | null = null;

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      const rawBytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(rawBytes);

      let payload = rawBytes;
      if (muxerCodec === 'aac') {
        const adts = parseAdtsHeader(rawBytes);
        if (adts) {
          payload = rawBytes.subarray(adts.headerLength);
          if (!adtsDerivedAsc) {
            adtsDerivedAsc = adts.asc;
          }
        }
      }

      if (meta?.decoderConfig) {
        rawDecoderConfig = meta.decoderConfig;
      }

      if (payload.byteLength === 0) return;

      const chunkDurationUs =
        chunk.duration && chunk.duration > 0
          ? Math.round(chunk.duration)
          : Math.round((1024 / sampleRate) * 1_000_000);

      chunks.push({
        data: payload,
        type: chunk.type === 'delta' ? 'delta' : 'key',
        timestampUs: Math.max(0, Math.round(chunk.timestamp)),
        durationUs: Math.max(1, chunkDurationUs),
      });
    },
    error: (e) => {
      console.error('AudioEncoder error', e);
      audioEncodeError = e;
    },
  });

  let channelArrays: Float32Array[] = [];
  try {
    audioEncoder.configure({
      ...encoderConfig,
      numberOfChannels: numChannels,
      sampleRate,
    });

    // 動画末尾の端数丸め誤差やデコーダ遅延によるコマ末尾の音声抜けを防ぐため、+0.5秒のマージンを許容
    const maxAudioSamples = Math.ceil((duration + 0.5) * sampleRate);
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

  if (chunks.length > 0) {
    // 【重要】Android Chrome 等で AudioEncoder が meta.decoderConfig.description を undefined で返した場合、
    // そのまま mp4-muxer に渡すと Object.assign で description が undefined に上書きされ、
    // esds ボックスの AudioSpecificConfig が 0 バイトに破壊されて無音になります。
    // ここで必ず有効な 2 バイト以上の AudioSpecificConfig を保証して最初のチャンクに付与します。
    if (muxerCodec === 'aac') {
      const validDesc = ensureValidAacDescription(
        rawDecoderConfig?.description,
        sampleRate,
        numChannels,
        adtsDerivedAsc
      );
      chunks[0].meta = {
        decoderConfig: {
          codec: encoderConfig.codec || 'mp4a.40.2',
          sampleRate,
          numberOfChannels: numChannels,
          description: validDesc,
        },
      };
    } else if (rawDecoderConfig) {
      const descBytes = toUint8Array(rawDecoderConfig.description);
      chunks[0].meta = {
        decoderConfig: {
          codec: rawDecoderConfig.codec || encoderConfig.codec,
          sampleRate,
          numberOfChannels: numChannels,
          ...(descBytes && descBytes.byteLength > 0 ? { description: descBytes } : {}),
        },
      };
    }
  }

  return chunks;
}

/**
 * 元動画から PCM AudioBuffer をデコード（Web Audio API + Mediabunny AudioBufferSink の二段構え）
 */
async function decodeAudioFileToBuffer(
  videoFile: File,
  audioTrack: any | null,
  duration: number
): Promise<AudioBuffer | null> {
  const isMobile =
    typeof navigator !== 'undefined' &&
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const MAX_AUDIO_SAFE_FILE_SIZE = isMobile ? 120 * 1024 * 1024 : 350 * 1024 * 1024;

  // 1. Web Audio API decodeAudioData（ネイティブ C++ デコーダーで HE-AAC / AAC / MP3 / Opus を高速展開）
  if (videoFile.size <= MAX_AUDIO_SAFE_FILE_SIZE) {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        let arrayBuffer: ArrayBuffer | null = await videoFile.arrayBuffer();
        const audioCtx = new AudioCtx();
        try {
          const decoded = await audioCtx.decodeAudioData(arrayBuffer);
          if (decoded && decoded.length > 0) {
            return decoded;
          }
        } finally {
          arrayBuffer = null;
          await audioCtx.close().catch(() => {});
        }
      }
    } catch (webAudioErr) {
      console.warn('AudioContext.decodeAudioData failed, trying AudioBufferSink fallback:', webAudioErr);
    }
  }

  // 2. Mediabunny AudioBufferSink によるパケット単位デコード結合
  if (audioTrack) {
    try {
      const sink = new AudioBufferSink(audioTrack);
      const buffers: AudioBuffer[] = [];
      let totalFrames = 0;
      let sampleRate = 48000;
      let numberOfChannels = 2;

      for await (const wrapped of sink.buffers(0, duration + 0.5)) {
        if (wrapped && wrapped.buffer && wrapped.buffer.length > 0) {
          if (buffers.length === 0) {
            sampleRate = wrapped.buffer.sampleRate;
            numberOfChannels = wrapped.buffer.numberOfChannels;
          }
          buffers.push(wrapped.buffer);
          totalFrames += wrapped.buffer.length;
        }
      }

      if (buffers.length > 0 && totalFrames > 0) {
        const OfflineCtx =
          window.OfflineAudioContext ||
          (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
            .webkitOfflineAudioContext;
        const offlineCtx = new OfflineCtx(numberOfChannels, totalFrames, sampleRate);
        const combined = offlineCtx.createBuffer(numberOfChannels, totalFrames, sampleRate);
        for (let ch = 0; ch < numberOfChannels; ch++) {
          const dest = combined.getChannelData(ch);
          let offset = 0;
          for (const b of buffers) {
            const srcCh = Math.min(ch, b.numberOfChannels - 1);
            dest.set(b.getChannelData(srcCh), offset);
            offset += b.length;
          }
        }
        return combined;
      }
    } catch (sinkErr) {
      console.warn('Mediabunny AudioBufferSink fallback failed:', sinkErr);
    }
  }

  return null;
}

/**
 * 音声トラックの抽出・エンコードパイプラインを準備
 *
 * 【根本原因への完全対策】:
 * 1. Mediabunny で直接パケットを抽出する際、必ず `audioTrack.getDecoderConfig()` を取得して
 *    オリジナルの `AudioSpecificConfig (description)` を解析・保持し、先頭チャンクの `meta` に渡します。
 *    （これを行わないと、SNS動画等で多用される HE-AAC / SBR 24kHz 音声が mp4-muxer の 48kHz AAC-LC 推測ヘッダーで
 *      上書きされて esds ボックスが破損し、スマホで無音になります）
 * 2. さらに、元動画が HE-AAC (SBR / PS) や特殊プロファイルであり、かつ端末が WebCodecs AudioEncoder に対応している場合、
 *    デバイスのプレイヤー互換性を100%にするため、標準 AAC-LC (mp4a.40.2) へのクリーン再エンコードを試み、
 *    万一失敗しても上記の完全な `decoderConfig` 付き直接ストリームコピーへ即座にフォールバックします。
 * 3. iOS Safari 等の AudioEncoder 非搭載環境では、完全な `decoderConfig.description` 付きの直接ストリームコピーを行います。
 * 4. すべての音声チャンクをこの関数内で事前に確定・検証するため、0パケットのまま成功扱いになることもありません。
 */
async function prepareAudioPipeline(
  videoFile: File,
  duration: number,
  onProgress: (status: string) => void
): Promise<PreparedAudioPipeline> {
  onProgress('元動画の音声トラックを解析中...');

  let input: Input | null = null;
  let audioTrack: any | null = null;
  let directCodec: string | null = null;
  let directSampleRate = 48000;
  let directChannels = 2;
  let directDecoderConfig: AudioDecoderConfig | null = null;
  let directChunks: PreparedAudioChunk[] = [];
  let isHeAacOrExtended = false;

  try {
    input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(videoFile),
    });

    audioTrack = await input.getPrimaryAudioTrack();
    if (audioTrack) {
      directCodec = await audioTrack.getCodec();
      directSampleRate = (await audioTrack.getSampleRate()) || 48000;
      directChannels = (await audioTrack.getNumberOfChannels()) || 2;

      try {
        directDecoderConfig = await audioTrack.getDecoderConfig();
      } catch (_) {
        directDecoderConfig = null;
      }

      if (directCodec === 'aac' || directCodec === 'opus') {
        const ascInfo =
          directCodec === 'aac'
            ? inspectAacAudioSpecificConfig(directDecoderConfig?.description)
            : null;

        isHeAacOrExtended = Boolean(ascInfo?.isHeAacOrExtended);

        // HE-AAC 等で esds のコアサンプルレートと出力サンプルレートが異なる場合でも、
        // 元の description (AudioSpecificConfig) をそのまま渡すことでデコーダーが SBR を正しく認識できるようにする
        const sink = new EncodedPacketSink(audioTrack);
        let firstTimestamp: number | null = null;
        let lastTimestampUs = -1;
        let adtsDerivedAsc: Uint8Array | null = null;

        for await (const packet of sink.packets()) {
          if (!packet.data || packet.data.byteLength === 0) continue;
          if (firstTimestamp === null) {
            firstTimestamp = packet.timestamp;
          }
          const relativeSec = packet.timestamp - firstTimestamp;
          // 動画末尾の端数丸め誤差やデコーダ遅延によるコマ末尾の音声抜けを防ぐため、+0.5秒のマージンを確保
          if (relativeSec > duration + 0.5) break;

          let timestampUs = Math.round(Math.max(0, relativeSec) * 1_000_000);
          if (timestampUs < lastTimestampUs) {
            timestampUs = lastTimestampUs;
          }
          lastTimestampUs = timestampUs;
          const durationUs = Math.max(1, Math.round(packet.duration * 1_000_000));

          let payload = new Uint8Array(packet.data);
          if (directCodec === 'aac') {
            const adts = parseAdtsHeader(payload);
            if (adts) {
              payload = payload.subarray(adts.headerLength);
              if (!adtsDerivedAsc) {
                adtsDerivedAsc = adts.asc;
              }
            }
          }
          if (payload.byteLength === 0) continue;

          directChunks.push({
            data: payload,
            type: packet.type === 'delta' ? 'delta' : 'key',
            timestampUs,
            durationUs,
          });
        }

        if (directChunks.length > 0) {
          if (directCodec === 'aac') {
            const validDesc = ensureValidAacDescription(
              directDecoderConfig?.description,
              directSampleRate,
              directChannels,
              adtsDerivedAsc
            );
            directChunks[0].meta = {
              decoderConfig: {
                codec: directDecoderConfig?.codec || 'mp4a.40.2',
                sampleRate: directSampleRate,
                numberOfChannels: directChannels,
                description: validDesc,
              },
            };
          } else if (directDecoderConfig) {
            const descBytes = toUint8Array(directDecoderConfig.description);
            directChunks[0].meta = {
              decoderConfig: {
                codec: directDecoderConfig.codec || 'opus',
                sampleRate: directSampleRate,
                numberOfChannels: directChannels,
                ...(descBytes && descBytes.byteLength > 0 ? { description: descBytes } : {}),
              },
            };
          }
        }
      }
    }

    // 分岐A: 元動画が標準 AAC-LC であり、直接パケット抽出に成功している場合
    // （無劣化・高速・iOS/Android/PC 全対応）
    if (directCodec === 'aac' && !isHeAacOrExtended && directChunks.length > 0) {
      return {
        audioConfig: {
          codec: 'aac',
          numberOfChannels: directChannels,
          sampleRate: directSampleRate,
        },
        chunks: directChunks,
      };
    }

    // 分岐B: WebCodecs AudioEncoder が利用可能な場合
    // （元動画が HE-AAC / SBR / PS、Opus、MP3 等の場合、または直接抽出が0チャンクだった場合に
    //   全端末で100%再生可能なクリーンな AAC-LC (mp4a.40.2) へ変換）
    if (typeof window.AudioEncoder !== 'undefined') {
      try {
        onProgress('音声トラックを標準AAC形式へ最適化中...');
        const decodedBuffer = await decodeAudioFileToBuffer(videoFile, audioTrack, duration);
        if (decodedBuffer && decodedBuffer.length > 0) {
          const supportedAudioConfig = await findSupportedAudioConfig(
            decodedBuffer.sampleRate,
            decodedBuffer.numberOfChannels
          );
          if (supportedAudioConfig) {
            const targetSr = supportedAudioConfig.encoderConfig.sampleRate || decodedBuffer.sampleRate;
            const targetCh =
              supportedAudioConfig.encoderConfig.numberOfChannels || decodedBuffer.numberOfChannels;

            let normalizedAudio = decodedBuffer;
            try {
              normalizedAudio = await normalizeAudioBuffer(decodedBuffer, targetSr, targetCh);
            } catch (_) {
              normalizedAudio = decodedBuffer;
            }

            const encodedChunks = await encodePcmToAudioChunks(
              normalizedAudio,
              supportedAudioConfig.encoderConfig,
              supportedAudioConfig.muxerCodec,
              duration
            );

            if (encodedChunks.length > 0) {
              // メモリ節約のため不要になった直接抽出チャンクをクリア
              directChunks = [];
              return {
                audioConfig: {
                  codec: supportedAudioConfig.muxerCodec,
                  numberOfChannels: normalizedAudio.numberOfChannels,
                  sampleRate: normalizedAudio.sampleRate,
                },
                chunks: encodedChunks,
              };
            }
          }
        }
      } catch (reencodeErr) {
        console.warn('WebCodecs AAC-LC re-encode failed, using direct stream packets if available:', reencodeErr);
      }
    }

    // 分岐C: AudioEncoder 非搭載環境（iOS Safari 等）または再エンコード失敗時のフォールバックとして
    // 完全な decoderConfig.description 付きの直接抽出チャンクを使用
    if ((directCodec === 'aac' || directCodec === 'opus') && directChunks.length > 0) {
      return {
        audioConfig: {
          codec: directCodec,
          numberOfChannels: directChannels,
          sampleRate: directSampleRate,
        },
        chunks: directChunks,
      };
    }
  } catch (err) {
    console.warn('Audio pipeline preparation encountered an error:', err);
  } finally {
    if (input) {
      try {
        input.dispose();
      } catch (_) {}
    }
  }

  // 分岐D: 音声トラックなし動画
  return {
    chunks: [],
  };
}

/**
 * 動画の完全ローカルMP4書き出し（WebCodecs API + mp4-muxer による完全なmoovアトム構築）
 */
/**
 * 1フレーム分のモザイク・反転モザイクをキャンバスへ描画する統合ヘルパー
 */
function applyMosaicToFrame(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  tracks: MosaicTrack[],
  currentTime: number,
  videoWidth: number,
  videoHeight: number,
  options: ExportOptions,
  videoDuration?: number
) {
  if (options.isInverseMosaic) {
    const protectedRegions: ProtectedRegion[] = [];
    for (const track of tracks) {
      if (!track.enabled) continue;
      // 冒頭0.6秒以内から始まっているトラックは0秒（第1フレーム）でも確実に保護
      const effectiveStart = track.startTime <= 0.6 ? 0 : track.startTime;
      // 動画末尾（1.0秒以内）まで延びているトラックは動画終端まで確実に保護し、最後のコマ抜けを防止
      const effectiveEnd =
        videoDuration && videoDuration > 0 && videoDuration - track.endTime <= 1.0
          ? videoDuration + 0.5
          : track.endTime;

      if (currentTime < effectiveStart || currentTime > effectiveEnd) continue;

      const effectiveTime =
        currentTime < track.startTime && track.startTime <= 0.6
          ? track.startTime
          : currentTime;

      const pos = interpolateKeyframes(track.keyframes, effectiveTime, {
        screenWidth: videoWidth,
        screenHeight: videoHeight,
        hasFutureManualKeyframe: track.keyframes.some((k) => k.time > effectiveTime),
        trackEndTime: effectiveEnd,
        videoDuration,
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
      const effectiveStart = track.startTime <= 0.6 ? 0 : track.startTime;
      const effectiveEnd =
        videoDuration && videoDuration > 0 && videoDuration - track.endTime <= 1.0
          ? videoDuration + 0.5
          : track.endTime;

      if (currentTime < effectiveStart || currentTime > effectiveEnd) continue;

      const effectiveTime =
        currentTime < track.startTime && track.startTime <= 0.6
          ? track.startTime
          : currentTime;

      const pos = interpolateKeyframes(track.keyframes, effectiveTime, {
        screenWidth: videoWidth,
        screenHeight: videoHeight,
        hasFutureManualKeyframe: track.keyframes.some((k) => k.time > effectiveTime),
        trackEndTime: effectiveEnd,
        videoDuration,
      });
      if (pos && !track.trackingData?.isOutOfFrame) {
        renderTrackMosaic(ctx, track, pos, sourceCanvas);
      }
    }
  }
}

/**
 * 動画エクスポートの実行（WebCodecs直接デコード + フォールバックシーク）
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

  let activeVideo: HTMLVideoElement = videoElement;
  let dedicatedVideoUrl: string | null = null;
  let videoInput: Input | null = null;

  try {
    videoElement.pause();

    const duration = videoElement.duration || 1;
    // スマホでのメモリクラッシュ（OOM）防止＆プレビュー作業解像度との100%座標同期のため長辺1280px以下にクランプ（偶数ピクセル保証）
    const rawW = videoElement.videoWidth || 640;
    const rawH = videoElement.videoHeight || 360;
    const { width: videoWidth, height: videoHeight } = getClampedDimensions(rawW, rawH, 1280);

    // 【革新】Mediabunny + WebCodecs による動画トラックのネイティブFPS検出とハードウェア直接デコードの準備
    let videoTrack: InputVideoTrack | null = null;
    let canUseDirectDecoder = false;
    let nativeFps = 30;
    let totalVideoPackets = 0;

    try {
      videoInput = new Input({
        formats: ALL_FORMATS,
        source: new BlobSource(videoFile),
      });

      const primaryVideo = await videoInput.getPrimaryVideoTrack();
      if (primaryVideo && (await primaryVideo.canDecode().catch(() => false))) {
        videoTrack = primaryVideo;
        canUseDirectDecoder = true;

        try {
          const stats = await primaryVideo.computePacketStats(60);
          if (stats && stats.averagePacketRate > 0) {
            const rawFps = stats.averagePacketRate;
            // スマートフォンや一般的なカメラの主要フレームレートに整合
            if (Math.abs(rawFps - 24) < 1.5) nativeFps = 24;
            else if (Math.abs(rawFps - 25) < 1.0) nativeFps = 25;
            else if (Math.abs(rawFps - 30) < 1.5) nativeFps = 30;
            else if (Math.abs(rawFps - 50) < 2.0) nativeFps = 50;
            else if (Math.abs(rawFps - 60) < 3.5) nativeFps = 60;
            else nativeFps = Math.min(60, Math.max(15, Math.round(rawFps)));

            if (stats.packetCount && stats.packetCount > 0) {
              totalVideoPackets = stats.packetCount;
            }
          }
        } catch (_) {}
      }
    } catch (inputErr) {
      console.warn('Mediabunny videoTrack init failed, will use videoElement fallback:', inputErr);
      canUseDirectDecoder = false;
    }

    const fps = canUseDirectDecoder ? nativeFps : 30;
    const totalFrames =
      totalVideoPackets > 0
        ? totalVideoPackets
        : Math.max(1, Math.floor(duration * fps));

    // フォールバック用のクリーン動画要素を準備（CanvasSink が万一使えない環境用）
    if (!canUseDirectDecoder) {
      try {
        dedicatedVideoUrl = URL.createObjectURL(videoFile);
        const cleanVideo = document.createElement('video');
        cleanVideo.crossOrigin = 'anonymous';
        cleanVideo.preload = 'auto';
        cleanVideo.playsInline = true;
        cleanVideo.muted = true;
        cleanVideo.src = dedicatedVideoUrl;

        await new Promise<void>((resolve) => {
          let isSettled = false;
          const to = setTimeout(() => {
            if (!isSettled) {
              isSettled = true;
              resolve();
            }
          }, 1500);

          cleanVideo.onloadedmetadata = () => {
            if (!isSettled) {
              isSettled = true;
              clearTimeout(to);
              resolve();
            }
          };
          cleanVideo.onerror = () => {
            if (!isSettled) {
              isSettled = true;
              clearTimeout(to);
              resolve();
            }
          };
        });

        if (cleanVideo.duration && cleanVideo.duration > 0) {
          activeVideo = cleanVideo;
        }
      } catch (cleanErr) {
        console.warn('Dedicated video creation fallback to videoElement:', cleanErr);
        activeVideo = videoElement;
      }
    }

    // レンダリング用キャンバス準備（100% クリーンなコンテキストで生成）
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

    // 1. 音声トラックの解析・準備（完全な AudioSpecificConfig / esds 保証付き）
    const shouldIncludeAudio = options.includeAudio !== false;
    const audioPipeline = shouldIncludeAudio
      ? await prepareAudioPipeline(videoFile, duration, (status) => {
          onProgress({ currentFrame: 0, totalFrames, percent: 0, status });
        })
      : { audioConfig: undefined, chunks: [] };

    const hasValidAudio = Boolean(audioPipeline.audioConfig && audioPipeline.chunks.length > 0);

    // 2. mp4-muxer 出力ターゲットの準備（標準動画は fastStart: 'in-memory' で先頭に moov を配置）
    const outputTarget = await prepareMuxerTarget(duration);

    const muxer = new Muxer({
      target: outputTarget.target,
      video: {
        codec: 'avc',
        width: videoWidth,
        height: videoHeight,
        frameRate: fps,
      },
      audio: hasValidAudio ? audioPipeline.audioConfig : undefined,
      fastStart: outputTarget.fastStart,
      firstTimestampBehavior: 'offset',
    });

    // 3. VideoEncoder の設定（60fps等に応じた最適なビットレートとプロファイルを自動選択）
    const targetBitrate = fps >= 50 ? 3_500_000 : 2_500_000;
    const videoConfig = await findSupportedVideoConfig(videoWidth, videoHeight, fps, targetBitrate);
    let videoEncoderError: Error | null = null;
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        console.error('VideoEncoder error', e);
        videoEncoderError = e;
      },
    });
    videoEncoder.configure(videoConfig);

    // 4. 映像フレームの順次レンダリングと、タイムスタンプ順の音声チャンク・インターリーブ書き込み
    let frameCount = 0;
    let nextAudioIndex = 0;
    const audioChunks = audioPipeline.chunks;
    let lastVideoTimestampUs = -1;

    // パイプライン1: 【WebCodecs + Mediabunny CanvasSink 直接ハードウェアデコード】
    // シーク一切なし・重複率0%・ネイティブFPSで超滑らか出力
    if (canUseDirectDecoder && videoTrack) {
      try {
        onProgress({
          currentFrame: 0,
          totalFrames,
          percent: 0,
          status: `直接ハードウェアデコード開始 (${fps} fps)...`,
        });

        const sink = new CanvasSink(videoTrack, {
          width: videoWidth,
          height: videoHeight,
          fit: 'fill',
        });

        for await (const wrappedCanvas of sink.canvases()) {
          if (videoEncoderError) throw videoEncoderError;

          while (videoEncoder.encodeQueueSize > 2) {
            await new Promise((r) => setTimeout(r, 10));
          }

          const currentTime = wrappedCanvas.timestamp;

          // デコードされた完全クリーンな元コマを描画
          srcCtx.drawImage(wrappedCanvas.canvas, 0, 0, videoWidth, videoHeight);
          ctx.drawImage(sourceCanvas, 0, 0, videoWidth, videoHeight);

          // モザイク適用
          applyMosaicToFrame(
            ctx,
            sourceCanvas,
            tracks,
            currentTime,
            videoWidth,
            videoHeight,
            options,
            duration
          );

          // 単調増加を保証した正確なタイムスタンプの算出（ジャダー・コマ飛び根絶）
          let timestampUs = Math.round(wrappedCanvas.timestamp * 1_000_000);
          const durationUs = Math.max(1000, Math.round(wrappedCanvas.duration * 1_000_000));

          if (timestampUs <= lastVideoTimestampUs) {
            timestampUs =
              lastVideoTimestampUs +
              Math.max(1000, Math.round((1 / fps) * 1_000_000));
          }
          lastVideoTimestampUs = timestampUs;

          const videoFrame = new VideoFrame(exportCanvas, {
            timestamp: timestampUs,
            duration: durationUs,
          });

          // 1秒ごと（fpsフレームごと）に必ずIDRキーフレームを生成してシークバーの移動を軽快にする
          const isKeyframe = frameCount % fps === 0;
          videoEncoder.encode(videoFrame, { keyFrame: isKeyframe });
          videoFrame.close();

          // 現在の映像フレーム時刻までの音声チャンクを順次インターリーブ投入
          if (hasValidAudio) {
            while (
              nextAudioIndex < audioChunks.length &&
              audioChunks[nextAudioIndex].timestampUs <= timestampUs
            ) {
              const aChunk = audioChunks[nextAudioIndex];
              muxer.addAudioChunkRaw(
                aChunk.data,
                aChunk.type,
                aChunk.timestampUs,
                aChunk.durationUs,
                aChunk.meta
              );
              (aChunk as any).data = null;
              nextAudioIndex++;
            }
          }

          frameCount++;
          const currentTotal = Math.max(frameCount, totalFrames);
          const percent = Math.min(99, Math.round((frameCount / currentTotal) * 100));
          onProgress({
            currentFrame: frameCount,
            totalFrames: currentTotal,
            percent,
            status: `高精度フレームをエンコード中 (${frameCount}/${currentTotal})`,
          });
        }
      } catch (directErr) {
        console.warn('Direct CanvasSink processing failed, fallback to seek loop:', directErr);
      }
    }

    // パイプライン2: 【フォールバック・シーク方式】
    // 直接デコード非対応時、または万一の例外発生時に安全に実行
    if (frameCount === 0) {
      if (!dedicatedVideoUrl) {
        try {
          dedicatedVideoUrl = URL.createObjectURL(videoFile);
          const cleanVideo = document.createElement('video');
          cleanVideo.crossOrigin = 'anonymous';
          cleanVideo.preload = 'auto';
          cleanVideo.playsInline = true;
          cleanVideo.muted = true;
          cleanVideo.src = dedicatedVideoUrl;
          await new Promise<void>((r) => {
            cleanVideo.onloadedmetadata = () => r();
            cleanVideo.onerror = () => r();
            setTimeout(r, 1500);
          });
          if (cleanVideo.duration && cleanVideo.duration > 0) {
            activeVideo = cleanVideo;
          }
        } catch (_) {}
      }

      for (let f = 0; f < totalFrames; f++) {
        if (videoEncoderError) throw videoEncoderError;

        while (videoEncoder.encodeQueueSize > 2) {
          await new Promise((r) => setTimeout(r, 10));
        }

        const currentTime = f / fps;
        await seekVideoElement(activeVideo, currentTime);

        srcCtx.drawImage(activeVideo, 0, 0, videoWidth, videoHeight);
        ctx.drawImage(sourceCanvas, 0, 0, videoWidth, videoHeight);

        applyMosaicToFrame(
          ctx,
          sourceCanvas,
          tracks,
          currentTime,
          videoWidth,
          videoHeight,
          options,
          duration
        );

        const timestampUs = Math.round((f / fps) * 1_000_000);
        const videoFrame = new VideoFrame(exportCanvas, {
          timestamp: timestampUs,
          duration: Math.round((1 / fps) * 1_000_000),
        });

        const isKeyframe = f % fps === 0;
        videoEncoder.encode(videoFrame, { keyFrame: isKeyframe });
        videoFrame.close();

        if (hasValidAudio) {
          while (
            nextAudioIndex < audioChunks.length &&
            audioChunks[nextAudioIndex].timestampUs <= timestampUs
          ) {
            const aChunk = audioChunks[nextAudioIndex];
            muxer.addAudioChunkRaw(
              aChunk.data,
              aChunk.type,
              aChunk.timestampUs,
              aChunk.durationUs,
              aChunk.meta
            );
            (aChunk as any).data = null;
            nextAudioIndex++;
          }
        }

        frameCount++;
        const percent = Math.round(((f + 1) / totalFrames) * 100);
        onProgress({
          currentFrame: f + 1,
          totalFrames,
          percent,
          status: `フレームをエンコード中 (${f + 1}/${totalFrames})`,
        });
      }
    }

    // 5. 残りの音声チャンクをフラッシュ書き込み
    if (hasValidAudio) {
      while (nextAudioIndex < audioChunks.length) {
        const aChunk = audioChunks[nextAudioIndex];
        muxer.addAudioChunkRaw(
          aChunk.data,
          aChunk.type,
          aChunk.timestampUs,
          aChunk.durationUs,
          aChunk.meta
        );
        (aChunk as any).data = null;
        nextAudioIndex++;
      }
      audioChunks.length = 0;
    }

    // 6. 完了処理（moovアトムの書き込みとインデックス構築）
    onProgress({
      currentFrame: Math.max(frameCount, totalFrames),
      totalFrames: Math.max(frameCount, totalFrames),
      percent: 100,
      status: 'MP4（moovアトム・シーク目次）を構築中...',
    });

    await videoEncoder.flush();
    videoEncoder.close();
    muxer.finalize();

    return await outputTarget.finalizeAndGetBlob();
  } finally {
    if (videoInput) {
      try {
        (videoInput as any).dispose?.();
      } catch (_) {}
    }
    if (dedicatedVideoUrl) {
      try {
        URL.revokeObjectURL(dedicatedVideoUrl);
      } catch (_) {}
    }
    if (activeVideo && activeVideo !== videoElement) {
      try {
        activeVideo.pause();
        activeVideo.removeAttribute('src');
        activeVideo.load();
      } catch (_) {}
    }
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
