import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { Toolbar } from './components/Toolbar';
import { VideoCanvas } from './components/VideoCanvas';
import { Timeline } from './components/Timeline';
import { PersonListPanel } from './components/PersonListPanel';
import { ExportModal } from './components/ExportModal';
import { EditorMode, MosaicTrack, MosaicType, Point, Keyframe, NormalizedPoint } from './types';
import { Film, ListFilter, Clock, Play, Pause, RotateCcw, Trash2, Crosshair, Sparkles, AlertTriangle, X, ChevronLeft, ChevronRight, ChevronFirst, ChevronLast } from 'lucide-react';
import { initFaceDetector, initPersonSegmenter, detectFacesSafely, segmentPersonSafely, resampleClosedPolygon, BODY_CONTOUR_POINTS, updatePersonTracks, expandBoxWithMargin, estimateBodyBoxFromFace, createBodySilhouettePolygon, isValidFaceDetection, FaceFilterOptions, GatekeeperContext, resetAnalysisState, calcIoU } from './utils/aiDetector';
import { exportMosaicVideo, ExportProgress, saveOrShareBlob, isWebCodecsSupported, isInAppBrowser } from './utils/videoExporter';
import { generateDemoVideoBlob } from './utils/sampleGenerator';
import { renderTrackMosaic, renderInverseMosaic, ProtectedRegion } from './utils/mosaicRenderer';
import { extractFeaturePoints, toGrayscale, trackBox, interpolateKeyframes } from './utils/tracking';
import { requestScreenWakeLock, releaseScreenWakeLock, seekVideoSafely } from './utils/wakeLock';
import { getClampedDimensions, absoluteToNormalizedPoints, NORMALIZED_POINT_COUNT, createDefaultNormalizedPoints, normalizedToAbsolutePoints, isBoxTouchingBorder } from './utils/geometry';

export const App: React.FC = () => {
  // メディア状態
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [isImage, setIsImage] = useState<boolean>(false);
  const [duration, setDuration] = useState<number>(0);
  const [durationWarning, setDurationWarning] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  // トラック・編集状態
  const [tracks, setTracks] = useState<MosaicTrack[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>('select');
  const [isPreviewMode, setIsPreviewMode] = useState<boolean>(false);
  const [mobileTab, setMobileTab] = useState<'canvas' | 'list' | 'timeline'>('canvas');

  // 反転モザイク（選択した人物やPC画面以外の『背景全体』にモザイクをかける機能）
  const [isInverseMosaic, setIsInverseMosaic] = useState<boolean>(false);
  const [inverseMosaicType, setInverseMosaicType] = useState<MosaicType>('blur');
  const [inverseStrength, setInverseStrength] = useState<number>(18);

  // AIおよびエクスポート進行状態
  const [isAIDetecting, setIsAIDetecting] = useState<boolean>(false);
  const [aiDetectProgress, setAiDetectProgress] = useState<number>(0);
  const [aiSensitivity, setAiSensitivity] = useState<'strict' | 'standard' | 'high'>('strict');
  const [aiTarget, setAiTarget] = useState<'face' | 'body'>('body');
  const [isTrackingProcessing, setIsTrackingProcessing] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportedBlob, setExportedBlob] = useState<Blob | null>(null);
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);

  // 要素参照
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // ファイルオープンハンドラ
  const handleOpenFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (mediaUrl) URL.revokeObjectURL(mediaUrl);

    const url = URL.createObjectURL(file);
    const isImg = file.type.startsWith('image/');

    setMediaFile(file);
    setMediaUrl(url);
    setIsImage(isImg);
    setTracks([]);
    setSelectedTrackId(null);
    setCurrentTime(0);
    setIsPlaying(false);
    setDurationWarning(false);

    if (isImg) {
      setDuration(1);
    }
  };

  // デモ動画の即座生成
  const handleLoadDemo = async () => {
    try {
      const demoFile = await generateDemoVideoBlob();
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
      const url = URL.createObjectURL(demoFile);

      setMediaFile(demoFile);
      setMediaUrl(url);
      setIsImage(false);
      setTracks([]);
      setSelectedTrackId(null);
      setCurrentTime(0);
      setIsPlaying(false);
      setDurationWarning(false);
    } catch (e) {
      console.error('Demo video generation failed:', e);
      alert('デモ動画の生成に失敗しました');
    }
  };

  // 再生制御
  const togglePlay = () => {
    if (!videoRef.current || isImage) return;
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current.play().catch(console.error);
      setIsPlaying(true);
    }
  };

  const handleSeek = (time: number) => {
    if (!videoRef.current || isImage) return;
    const clamped = Math.max(0, Math.min(duration, time));
    videoRef.current.currentTime = clamped;
    setCurrentTime(clamped);
  };

  // ビデオのメタデータ読み込み
  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      const videoDur = videoRef.current.duration || 1;
      setDuration(videoDur);

      // 5分（300秒）を超える長尺動画に対する安全装置（OOMクラッシュ防止警告）
      if (videoDur > 300) {
        setDurationWarning(true);
        alert(
          'ブラウザのメモリ制限のため、5分以上の動画は処理中に強制終了する可能性があります。短い動画にカットしてご利用ください'
        );
      } else {
        setDurationWarning(false);
      }

      // スマホブラウザで初期フレームが未デコード(readyState < 2)のままになるのを防ぐため微小シークで先頭フレームをデコード
      if (videoRef.current.readyState < 2 && videoRef.current.currentTime === 0) {
        try {
          videoRef.current.currentTime = 0.001;
        } catch (_) {}
      }
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
  };

  // トラック追加
  const handleAddTrack = (newTrack: MosaicTrack) => {
    setTracks((prev) => [...prev, newTrack]);
    setSelectedTrackId(newTrack.id);
    // ※囲んだ直後にユーザーが枠をタップ＆ドラッグして微調整できるよう、
    //   シークを伴う重い自動解析(runTrackingForTrack)はここでは自動発火させず、
    //   再生中のリアルタイム追従または「自動追従を解析」ボタン押下時に実行する。
  };

  // トラック削除
  const handleDeleteTrack = (id: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== id));
    if (selectedTrackId === id) setSelectedTrackId(null);
  };

  // ユーザー指定領域（フリー囲み等）を一括全削除
  const handleDeleteAllUserTracks = () => {
    setTracks((prev) => prev.filter((t) => t.type === 'ai'));
    setSelectedTrackId(null);
  };

  // キーボードショートカット（Delete / Backspace で選択枠を即削除）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTrackId) {
        if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
        e.preventDefault();
        handleDeleteTrack(selectedTrackId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedTrackId]);

  // トラック設定更新
  const handleUpdateTrackSettings = (updates: Partial<MosaicTrack>) => {
    if (!selectedTrackId) return;
    setTracks((prev) =>
      prev.map((t) => (t.id === selectedTrackId ? { ...t, ...updates } : t))
    );
  };

  const handleUpdateTrackTime = (id: string, startTime: number, endTime: number) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, startTime, endTime } : t))
    );
  };

  const handleToggleTrackEnabled = (id: string) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t))
    );
  };

  const handleToggleAllAITracks = (enable: boolean) => {
    setTracks((prev) =>
      prev.map((t) => (t.type === 'ai' ? { ...t, enabled: enable } : t))
    );
  };

  // 現在位置をIn点・Out点に設定
  const handleSetInPoint = () => {
    if (!selectedTrackId) return;
    setTracks((prev) =>
      prev.map((t) =>
        t.id === selectedTrackId
          ? { ...t, startTime: Math.min(currentTime, t.endTime - 0.1) }
          : t
      )
    );
  };

  const handleSetOutPoint = () => {
    if (!selectedTrackId) return;
    setTracks((prev) =>
      prev.map((t) =>
        t.id === selectedTrackId
          ? { ...t, endTime: Math.max(currentTime, t.startTime + 0.1) }
          : t
      )
    );
  };

  // キーフレーム追加・位置補正
  const handleAddKeyframeAtCurrentTime = () => {
    if (!selectedTrackId) return;
    const track = tracks.find((t) => t.id === selectedTrackId);
    if (!track) return;

    const pos = interpolateKeyframes(track.keyframes, currentTime) || track.keyframes[0];
    if (!pos) return;

    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== selectedTrackId) return t;
        const filtered = t.keyframes.filter((k) => Math.abs(k.time - currentTime) >= 0.016);
        return {
          ...t,
          keyframes: [
            ...filtered,
            {
              time: currentTime,
              x: pos.x,
              y: pos.y,
              width: pos.width,
              height: pos.height,
              points: pos.points,
              normalizedPoints: pos.normalizedPoints,
            },
          ].sort((a, b) => a.time - b.time),
        };
      })
    );
  };

  // 1フレーム送り・戻し（30fps基準、累積誤差を避けるため整数インデックスで計算）
  const handleStepFrame = (deltaFrames: number) => {
    if (isImage || duration <= 0) return;
    setIsPlaying(false);
    if (videoRef.current) {
      videoRef.current.pause();
    }
    const currentFrame = Math.round(currentTime * 30);
    const totalFrames = Math.max(1, Math.round(duration * 30));
    const targetFrame = Math.max(0, Math.min(totalFrames, currentFrame + deltaFrames));
    const targetTime = targetFrame / 30;
    handleSeek(targetTime);
  };

  // 前後のキーフレームへジャンプ
  const handleJumpToKeyframe = (direction: 'prev' | 'next') => {
    if (!selectedTrackId) return;
    const track = tracks.find((t) => t.id === selectedTrackId);
    if (!track || track.keyframes.length === 0) return;
    setIsPlaying(false);
    if (videoRef.current) {
      videoRef.current.pause();
    }
    const times = track.keyframes.map((k) => k.time).sort((a, b) => a - b);
    if (direction === 'prev') {
      const prevTimes = times.filter((t) => t < currentTime - 0.016);
      if (prevTimes.length > 0) {
        handleSeek(prevTimes[prevTimes.length - 1]);
      } else {
        handleSeek(0);
      }
    } else {
      const nextTimes = times.filter((t) => t > currentTime + 0.016);
      if (nextTimes.length > 0) {
        handleSeek(nextTimes[0]);
      } else {
        handleSeek(duration);
      }
    }
  };

  const handleUpdateTrackKeyframe = (
    trackId: string,
    box: { x: number; y: number; width: number; height: number; points?: Point[]; normalizedPoints?: NormalizedPoint[] },
    isPlaybackTracking: boolean = false
  ) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;

        const norm = box.normalizedPoints || (box.points && box.points.length >= 3 ? absoluteToNormalizedPoints(box, box.points, NORMALIZED_POINT_COUNT) : undefined);
        const points = norm ? normalizedToAbsolutePoints(box, norm) : box.points;

        // 静止画モードの場合：常に time: 0 の単一キーフレームとして確実に保持・更新（タイムライン分裂やホールド切れを防止）
        if (isImage) {
          return {
            ...t,
            startTime: 0,
            endTime: 1,
            trackingData: t.trackingData
              ? { ...t.trackingData, isOutOfFrame: false, featurePoints: undefined }
              : undefined,
            keyframes: [
              {
                time: 0,
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                points,
                normalizedPoints: norm,
              },
            ],
          };
        }

        // 1. キーフレームが1個以下のトラック（手動囲み直後や静止画）は、そのキーフレームを直接更新
        if (t.keyframes.length <= 1) {
          const orig = t.keyframes[0];
          return {
            ...t,
            trackingData: t.trackingData
              ? { ...t.trackingData, isOutOfFrame: false, featurePoints: undefined }
              : undefined,
            keyframes: [
              {
                time: orig ? orig.time : currentTime,
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                points,
                normalizedPoints: norm,
              },
            ],
          };
        }

        // 2. 再生中の自動追従による更新の場合（現在時刻の近傍キーフレームを更新）
        if (isPlaybackTracking) {
          const filtered = t.keyframes.filter((k) => Math.abs(k.time - currentTime) >= 0.05);
          return {
            ...t,
            keyframes: [
              ...filtered,
              {
                time: currentTime,
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                points,
                normalizedPoints: norm,
              },
            ].sort((a, b) => a.time - b.time),
          };
        }

        // 3. ユーザーが手動で外枠操作・32頂点ドラッグ変形した場合：
        // 現在時刻 currentTime に「キーフレーム」として記録する。
        // 近傍（0.016秒以内＝同コマ内）の既存キーフレームがあれば更新し、なければ新規追加（1コマ毎の連続編集を完全保証）。
        // 2つのキーフレーム間（例: 10F目と40F目）は interpolateKeyframes の Lerp で自動変形し、
        // 後続にキーフレームがない場合は直前のキーフレームの状態を維持（ホールド）します。
        const filtered = t.keyframes.filter((k) => Math.abs(k.time - currentTime) >= 0.016);
        const newKeyframes = [
          ...filtered,
          {
            time: currentTime,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            points,
            normalizedPoints: norm,
          },
        ].sort((a, b) => a.time - b.time);

        return {
          ...t,
          trackingData: t.trackingData
            ? { ...t.trackingData, isOutOfFrame: false, featurePoints: undefined }
            : undefined,
          keyframes: newKeyframes,
        };
      })
    );
  };

  // 矩形枠(rect)を固定32頂点の正規化ポリゴン枠に変換し、身体のラインに沿うよう手動で頂点編集できるようにする
  const handleConvertTrackToPolygon = (trackId: string) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        const convertedKeyframes = t.keyframes.map((k) => {
          const box = { x: k.x, y: k.y, width: k.width, height: k.height };
          let normPoints = k.normalizedPoints;
          let points = k.points;

          if (!normPoints || normPoints.length !== NORMALIZED_POINT_COUNT) {
            if (points && points.length >= 3) {
              normPoints = absoluteToNormalizedPoints(box, points, NORMALIZED_POINT_COUNT);
            } else {
              normPoints = createDefaultNormalizedPoints(NORMALIZED_POINT_COUNT);
            }
          }
          points = normalizedToAbsolutePoints(box, normPoints);

          return {
            ...k,
            points,
            normalizedPoints: normPoints,
          };
        });
        return {
          ...t,
          shape: 'polygon',
          keyframes: convertedKeyframes,
        };
      })
    );
  };

  const handleUpdateTrackFrameOut = (trackId: string, isOutOfFrame: boolean) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        return {
          ...t,
          trackingData: {
            ...t.trackingData,
            templateWidth: t.trackingData?.templateWidth || 50,
            templateHeight: t.trackingData?.templateHeight || 50,
            isOutOfFrame,
          },
        };
      })
    );
  };

  // 高精度・自動追従区間解析（大域探索SAD + Lucas-Kanade + Median Flow）
  const runTrackingForTrack = async (targetTrackId: string, currentTrackData?: MosaicTrack) => {
    if (!videoRef.current || isImage) return;
    const track = currentTrackData || tracks.find((t) => t.id === targetTrackId);
    if (!track || track.keyframes.length === 0) return;

    setIsTrackingProcessing(true);
    await requestScreenWakeLock();

    const video = videoRef.current;
    const origTime = video.currentTime;
    const rawW = video.videoWidth || 640;
    const rawH = video.videoHeight || 480;
    const { width, height } = getClampedDimensions(rawW, rawH, 1280);

    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true })!;

    try {
      const startT = track.startTime;
      const endT = track.endTime;
      const step = 0.08; // 12.5fpsの高密度サンプリング

      // 開始フレームに安全にシーク
      await seekVideoSafely(video, startT);

      offCtx.drawImage(video, 0, 0, width, height);
      let prevGray = toGrayscale(offCtx.getImageData(0, 0, width, height));

      const initialPos = interpolateKeyframes(track.keyframes, startT) || track.keyframes[0];
      let curBox = { x: initialPos.x, y: initialPos.y, width: initialPos.width, height: initialPos.height };
      let featPoints = extractFeaturePoints(prevGray, width, height, curBox, 36);

      const initialNorm = initialPos.normalizedPoints || (initialPos.points ? absoluteToNormalizedPoints(curBox, initialPos.points, NORMALIZED_POINT_COUNT) : undefined);

      const generatedKeyframes: Keyframe[] = [
        {
          time: startT,
          x: curBox.x,
          y: curBox.y,
          width: curBox.width,
          height: curBox.height,
          points: initialPos.points,
          normalizedPoints: initialNorm,
        },
      ];

      const totalSteps = Math.floor((endT - startT) / step);
      for (let s = 1; s <= totalSteps; s++) {
        const curT = Math.min(endT, startT + s * step);
        await seekVideoSafely(video, curT);

        offCtx.drawImage(video, 0, 0, width, height);
        const currGray = toGrayscale(offCtx.getImageData(0, 0, width, height));

        const res = trackBox(curBox, featPoints, prevGray, currGray, width, height);
        if (res.isOutOfFrame) {
          break;
        }

        curBox = res.newBox;
        featPoints = res.newPoints;
        prevGray = currGray;

        generatedKeyframes.push({
          time: curT,
          x: curBox.x,
          y: curBox.y,
          width: curBox.width,
          height: curBox.height,
          points: initialPos.points?.map((p) => ({
            x: p.x + (curBox.x - initialPos.x),
            y: p.y + (curBox.y - initialPos.y),
          })),
          normalizedPoints: initialNorm,
        });
      }

      setTracks((prev) =>
        prev.map((t) =>
          t.id === targetTrackId
            ? {
                ...t,
                keyframes: generatedKeyframes,
                trackingData: t.trackingData ? { ...t.trackingData, isOutOfFrame: false } : undefined,
              }
            : t
        )
      );
    } catch (err) {
      console.error('Auto tracking failed', err);
    } finally {
      await seekVideoSafely(video, origTime);
      await releaseScreenWakeLock();
      setIsTrackingProcessing(false);
    }
  };

  // MediaPipe による高密度・AI人物自動検出＆追跡（セグメンテーションによる体ライン輪郭＋顔検出併用）
  const handleRunAIFaceDetection = async (overrideTarget?: 'face' | 'body', autoEnableInverse?: boolean) => {
    if (!videoRef.current && !imageRef.current) return;
    const targetMode = overrideTarget || aiTarget;
    setIsAIDetecting(true);
    setAiDetectProgress(0);
    await requestScreenWakeLock();

    try {
      if (targetMode === 'body') {
        // 【体のラインに沿った人物輪郭セグメンテーション】
        // 顔が映っていない、後ろ向き、横向きでも全身・上半身の境界をダイレクトに抽出
        let segmenter = await initPersonSegmenter();

        if (isImage && imageRef.current) {
          const img = imageRef.current;
          const rawW = img.naturalWidth || 640;
          const rawH = img.naturalHeight || 480;
          const { width: workW, height: workH } = getClampedDimensions(rawW, rawH, 1280);
          const scaleX = workW / rawW;
          const scaleY = workH / rawH;

          const gateContext: GatekeeperContext = {
            existingTracks: tracks.map((t) => ({
              id: t.id,
              box: t.keyframes[0] || { x: 0, y: 0, width: 0, height: 0 },
              hasManualKeyframe: t.keyframes.length > 1,
            })),
            origWidth: workW,
            origHeight: workH,
          };

          const res = await segmentPersonSafely(img, segmenter, gateContext);
          segmenter = res.activeSegmenter;

          const contours = (res.contours && res.contours.length > 0)
            ? res.contours
            : (res.contour && res.contour.points.length >= 3 ? [res.contour] : []);

          if (contours.length > 0) {
            const newTracks: MosaicTrack[] = contours.map((cnt, idx) => {
              const scaledBox = {
                x: Math.round(cnt.bounds.x * scaleX),
                y: Math.round(cnt.bounds.y * scaleY),
                width: Math.round(cnt.bounds.width * scaleX),
                height: Math.round(cnt.bounds.height * scaleY),
              };
              const scaledPoints = cnt.points.map((p) => ({
                x: p.x * scaleX,
                y: p.y * scaleY,
              }));
              const normPoints =
                cnt.normalizedPoints ||
                absoluteToNormalizedPoints(scaledBox, scaledPoints, NORMALIZED_POINT_COUNT);

              return {
                id: `ai-body-${Date.now()}-${idx + 1}`,
                name: contours.length > 1 ? `AI人物 #${idx + 1} (輪郭)` : 'AI人物 (輪郭)',
                type: 'ai',
                shape: 'polygon',
                enabled: true,
                mosaicType: 'pixel',
                strength: 14,
                startTime: 0,
                endTime: 1,
                keyframes: [
                  {
                    time: 0,
                    ...scaledBox,
                    points: scaledPoints,
                    normalizedPoints: normPoints,
                  },
                ],
                aiTarget: 'body',
              };
            });

            setTracks((prev) => [...prev, ...newTracks]);
            if (newTracks.length > 0) {
              setSelectedTrackId(newTracks[0].id);
            }
            if (autoEnableInverse && newTracks.length > 0) {
              setIsInverseMosaic(true);
            }
          } else {
            // セグメンテーションで見つからなかった場合は顔検出にフォールバック
            await runFaceDetectionFallback(targetMode, autoEnableInverse);
          }
          setAiDetectProgress(100);
        } else if (videoRef.current) {
          const video = videoRef.current;
          const origTime = video.currentTime;
          const totalDuration = video.duration || 5;
          const rawW = video.videoWidth || 640;
          const rawH = video.videoHeight || 480;
          const { width: workW, height: workH } = getClampedDimensions(rawW, rawH, 1280);
          const scaleX = workW / rawW;
          const scaleY = workH / rawH;

          // キーフレーム補間(Lerp)が滑らかに繋ぐため、スマホでも超高速かつ低負荷なサンプリング
          // ※モバイル端末での長周期キーフレーム動画（3秒GOP等）のデコーダー詰まりを防止するため、
          //   端末と動画長さに応じて 0.35s 〜 0.45s でアダプティブ調整
          const isMobileDevice = typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
          const step = isMobileDevice ? (totalDuration > 10 ? 0.45 : 0.35) : 0.35;
          const totalSteps = Math.max(1, Math.floor(totalDuration / step));

          resetAnalysisState();
          const createdTracks: MosaicTrack[] = [];

          interface ActiveBodyTrack {
            trackId: number;
            currentKeyframes: Keyframe[];
            pendingKeyframes: Keyframe[];
            consecutiveHits: number;
            missedDuration: number;
            lastValidBox: { x: number; y: number; width: number; height: number };
            prevKf?: Keyframe;
          }

          let nextTrackId = 1;
          const activeTracks: ActiveBodyTrack[] = [];

          for (let i = 0; i <= totalSteps; i++) {
            const sampleTime = Math.min(totalDuration, i * step);
            await seekVideoSafely(video, sampleTime);
            setAiDetectProgress(Math.round((i / totalSteps) * 100));

            const gateContext: GatekeeperContext = {
              prevBox: activeTracks[0]?.lastValidBox,
              existingTracks: tracks.map((t) => ({
                id: t.id,
                box: t.keyframes[0] || { x: 0, y: 0, width: 0, height: 0 },
                hasManualKeyframe: t.keyframes.length > 1,
              })),
              origWidth: workW,
              origHeight: workH,
            };

            const res = await segmentPersonSafely(video, segmenter, gateContext);
            segmenter = res.activeSegmenter;

            const rawContours = (res.contours && res.contours.length > 0)
              ? res.contours
              : (res.contour && res.contour.points.length >= 3 ? [res.contour] : []);

            const detectedBoxes = rawContours.map((cnt) => {
              const scaledBox = {
                x: Math.round(cnt.bounds.x * scaleX),
                y: Math.round(cnt.bounds.y * scaleY),
                width: Math.round(cnt.bounds.width * scaleX),
                height: Math.round(cnt.bounds.height * scaleY),
              };
              const scaledPoints = cnt.points.map((p) => ({
                x: p.x * scaleX,
                y: p.y * scaleY,
              }));
              const normPoints =
                cnt.normalizedPoints ||
                absoluteToNormalizedPoints(scaledBox, scaledPoints, NORMALIZED_POINT_COUNT);

              return {
                box: scaledBox,
                points: scaledPoints,
                normPoints,
              };
            });

            // 既存のアクティブトラックと現在の検出結果をマッチング
            const matchedDetectionIndices = new Set<number>();

            for (const track of activeTracks) {
              let bestScore = 0;
              let bestIdx = -1;

              for (let dIdx = 0; dIdx < detectedBoxes.length; dIdx++) {
                if (matchedDetectionIndices.has(dIdx)) continue;
                const det = detectedBoxes[dIdx];
                const iou = calcIoU(track.lastValidBox, det.box);

                const c1x = track.lastValidBox.x + track.lastValidBox.width / 2;
                const c1y = track.lastValidBox.y + track.lastValidBox.height / 2;
                const c2x = det.box.x + det.box.width / 2;
                const c2y = det.box.y + det.box.height / 2;
                const dist = Math.hypot(c1x - c2x, c1y - c2y);
                const maxDim = Math.max(track.lastValidBox.width, track.lastValidBox.height, 80);

                const centerScore = Math.max(0, 1 - dist / (maxDim * 1.5));
                const score = iou * 0.6 + centerScore * 0.4;

                if (score > bestScore && (iou > 0.10 || dist < maxDim * 0.8)) {
                  bestScore = score;
                  bestIdx = dIdx;
                }
              }

              if (bestIdx !== -1) {
                matchedDetectionIndices.add(bestIdx);
                const det = detectedBoxes[bestIdx];

                const prevKf = track.prevKf;
                let finalBox = det.box;
                let finalPoints = det.points;
                let finalNormPoints = det.normPoints;

                if (prevKf) {
                  const bPrevW = 0.35;
                  const bCurrW = 0.65;
                  finalBox = {
                    x: Math.round(prevKf.x * bPrevW + det.box.x * bCurrW),
                    y: Math.round(prevKf.y * bPrevW + det.box.y * bCurrW),
                    width: Math.round(prevKf.width * bPrevW + det.box.width * bCurrW),
                    height: Math.round(prevKf.height * bPrevW + det.box.height * bCurrW),
                  };

                  if (prevKf.normalizedPoints && prevKf.normalizedPoints.length === det.normPoints.length) {
                    const N = det.normPoints.length;
                    let bestShift = 0;
                    let bestDist = Infinity;

                    for (let shift = 0; shift < N; shift++) {
                      let dSum = 0;
                      for (let j = 0; j < N; j++) {
                        const curNp = det.normPoints[(j + shift) % N];
                        const prevNp = prevKf.normalizedPoints[j];
                        const du = curNp.u - prevNp.u;
                        const dv = curNp.v - prevNp.v;
                        dSum += du * du + dv * dv;
                      }
                      if (dSum < bestDist) {
                        bestDist = dSum;
                        bestShift = shift;
                      }
                    }

                    const alignedNorm = det.normPoints.map((_, idx) => det.normPoints[(idx + bestShift) % N]);
                    const pPrevW = 0.30;
                    const pCurrW = 0.70;
                    finalNormPoints = alignedNorm.map((np, idx) => ({
                      u: Number((prevKf.normalizedPoints![idx].u * pPrevW + np.u * pCurrW).toFixed(4)),
                      v: Number((prevKf.normalizedPoints![idx].v * pPrevW + np.v * pCurrW).toFixed(4)),
                    }));

                    finalPoints = normalizedToAbsolutePoints(finalBox, finalNormPoints);
                  }
                }

                const kf: Keyframe = {
                  time: sampleTime,
                  ...finalBox,
                  points: finalPoints,
                  normalizedPoints: finalNormPoints,
                };

                track.consecutiveHits++;
                track.lastValidBox = finalBox;
                track.prevKf = kf;
                track.missedDuration = 0;

                if (track.currentKeyframes.length > 0) {
                  track.currentKeyframes.push(kf);
                } else {
                  track.pendingKeyframes.push(kf);
                  if (track.consecutiveHits >= 3) {
                    track.currentKeyframes.push(...track.pendingKeyframes);
                    track.pendingKeyframes = [];
                  }
                }
              } else {
                track.consecutiveHits = 0;
                track.pendingKeyframes = [];
                track.missedDuration += step;
              }
            }

            // マッチしなかった新規検出領域を新しい人物トラックとして追加
            for (let dIdx = 0; dIdx < detectedBoxes.length; dIdx++) {
              if (matchedDetectionIndices.has(dIdx)) continue;
              const det = detectedBoxes[dIdx];
              const kf: Keyframe = {
                time: sampleTime,
                ...det.box,
                points: det.points,
                normalizedPoints: det.normPoints,
              };

              activeTracks.push({
                trackId: nextTrackId++,
                currentKeyframes: [],
                pendingKeyframes: [kf],
                consecutiveHits: 1,
                missedDuration: 0,
                lastValidBox: det.box,
                prevKf: kf,
              });
            }

            // 退場・見失い判定によるトラックの確定と終了
            for (let tIdx = activeTracks.length - 1; tIdx >= 0; tIdx--) {
              const track = activeTracks[tIdx];
              if (track.missedDuration === 0) continue;

              const isBorder = isBoxTouchingBorder(track.lastValidBox, workW, workH, 20);
              const isTimeout = isBorder ? (track.missedDuration >= 0.1) : (track.missedDuration >= 1.0);

              if (isTimeout) {
                if (track.currentKeyframes.length >= 3) {
                  const lastKf = track.currentKeyframes[track.currentKeyframes.length - 1];
                  createdTracks.push({
                    id: `ai-body-${Date.now()}-${track.trackId}`,
                    name: `AI人物 #${track.trackId} (体ライン)`,
                    type: 'ai',
                    shape: 'polygon',
                    enabled: true,
                    mosaicType: 'pixel',
                    strength: 14,
                    startTime: track.currentKeyframes[0].time,
                    endTime: isBorder ? (lastKf.time + 0.05) : Math.min(totalDuration, lastKf.time + 1.0),
                    keyframes: [...track.currentKeyframes],
                    aiPersonId: track.trackId,
                    aiTarget: 'body',
                  });
                }
                activeTracks.splice(tIdx, 1);
              }
            }
          }

          await seekVideoSafely(video, origTime);

          // ループ終了時に残っているアクティブトラックを確定
          for (const track of activeTracks) {
            if (track.currentKeyframes.length >= 3) {
              const lastKf = track.currentKeyframes[track.currentKeyframes.length - 1];
              const isBorder = isBoxTouchingBorder(track.lastValidBox, workW, workH, 20);
              createdTracks.push({
                id: `ai-body-${Date.now()}-${track.trackId}`,
                name: `AI人物 #${track.trackId} (体ライン)`,
                type: 'ai',
                shape: 'polygon',
                enabled: true,
                mosaicType: 'pixel',
                strength: 14,
                startTime: track.currentKeyframes[0].time,
                endTime: isBorder ? (lastKf.time + 0.05) : Math.min(totalDuration, lastKf.time + 0.3),
                keyframes: [...track.currentKeyframes],
                aiPersonId: track.trackId,
                aiTarget: 'body',
              });
            }
          }

          if (createdTracks.length >= 1) {
            setTracks((prev) => [...prev, ...createdTracks]);
            setSelectedTrackId(createdTracks[0].id);
            if (autoEnableInverse) {
              setIsInverseMosaic(true);
            }
          } else {
            // セグメンテーションでフレームが不足した場合は顔検出にフォールバック
            await runFaceDetectionFallback(targetMode, autoEnableInverse);
          }
        }
      } else {
        // 顔中心検出モード
        await runFaceDetectionFallback('face', autoEnableInverse);
      }
    } catch (err) {
      console.error('AI Detection failed', err);
      // エラー発生時は安全に顔検出へフォールバック
      try {
        await runFaceDetectionFallback(targetMode, autoEnableInverse);
      } catch (fbErr) {
        alert('AI検出の実行に失敗しました: ' + (err as Error).message);
      }
    } finally {
      await releaseScreenWakeLock();
      setIsAIDetecting(false);
      setAiDetectProgress(0);
    }
  };

  // 顔検出フォールバック関数
  const runFaceDetectionFallback = async (targetMode: 'face' | 'body', autoEnableInverse?: boolean) => {
    if (!videoRef.current && !imageRef.current) return;
    const filterOptions: FaceFilterOptions = {
      minScore: aiSensitivity === 'strict' ? 0.58 : aiSensitivity === 'standard' ? 0.48 : 0.35,
      minAspect: aiSensitivity === 'strict' ? 0.60 : 0.50,
      maxAspect: aiSensitivity === 'strict' ? 1.50 : 1.70,
      verifyFaceKeypoints: aiSensitivity !== 'high',
    };
    const minPersistenceFrames = aiSensitivity === 'strict' ? 4 : aiSensitivity === 'standard' ? 3 : 2;

    const confidence = filterOptions.minScore! * 0.9;
    let detector = await initFaceDetector(confidence);

    if (isImage && imageRef.current) {
      const img = imageRef.current;
      const rawW = img.naturalWidth || 640;
      const rawH = img.naturalHeight || 480;
      const { width: workW, height: workH } = getClampedDimensions(rawW, rawH, 1280);
      const scaleX = workW / rawW;
      const scaleY = workH / rawH;

      const result = await detectFacesSafely(img, detector, confidence);
      detector = result.activeDetector;
      const validDetections = (result.detections || []).filter((det) =>
        isValidFaceDetection(det, filterOptions)
      );

      const newAITracks: MosaicTrack[] = validDetections.map((det, idx) => {
        const bb = det.boundingBox;
        const rawBox = {
          x: bb ? bb.originX : 0,
          y: bb ? bb.originY : 0,
          width: bb ? bb.width : 50,
          height: bb ? bb.height : 50,
        };
        const finalBox = targetMode === 'body'
          ? estimateBodyBoxFromFace(rawBox, rawW, rawH)
          : expandBoxWithMargin(rawBox, 0.35, rawW, rawH);
        const bodyPoints = targetMode === 'body'
          ? createBodySilhouettePolygon(finalBox, rawW, rawH)
          : undefined;

        const scaledBox = {
          x: Math.round(finalBox.x * scaleX),
          y: Math.round(finalBox.y * scaleY),
          width: Math.round(finalBox.width * scaleX),
          height: Math.round(finalBox.height * scaleY),
        };
        const scaledPoints = bodyPoints ? bodyPoints.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })) : undefined;
        const normPoints = scaledPoints ? absoluteToNormalizedPoints(scaledBox, scaledPoints, NORMALIZED_POINT_COUNT) : undefined;

        return {
          id: `ai-person-${Date.now()}-${idx}`,
          name: targetMode === 'body' ? `AI人物 (体ライン) #${idx + 1}` : `AI顔 #${idx + 1}`,
          type: 'ai',
          shape: targetMode === 'body' ? 'polygon' : 'rect',
          enabled: true,
          mosaicType: 'pixel',
          strength: 14,
          startTime: 0,
          endTime: 1,
          keyframes: [{ time: 0, ...scaledBox, points: scaledPoints, normalizedPoints: normPoints }],
          aiTarget: targetMode,
        };
      });
      setTracks((prev) => [...prev, ...newAITracks]);
      if (newAITracks.length > 0) {
        setSelectedTrackId(newAITracks[0].id);
      }
      if (autoEnableInverse && newAITracks.length > 0) {
        setIsInverseMosaic(true);
      }
    } else if (videoRef.current) {
      const video = videoRef.current;
      const origTime = video.currentTime;
      const totalDuration = video.duration || 5;
      const rawW = video.videoWidth || 640;
      const rawH = video.videoHeight || 480;
      const { width: workW, height: workH } = getClampedDimensions(rawW, rawH, 1280);
      const scaleX = workW / rawW;
      const scaleY = workH / rawH;
      const isMobileDevice = typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      const step = isMobileDevice ? (totalDuration > 10 ? 0.45 : 0.35) : 0.35;
      const totalSteps = Math.max(1, Math.floor(totalDuration / step));

      let currentDetectedPersons: any[] = [];
      const personKeyframesMap = new Map<number, any[]>();
      const personScoresMap = new Map<number, number[]>();

      for (let i = 0; i <= totalSteps; i++) {
        const sampleTime = Math.min(totalDuration, i * step);
        await seekVideoSafely(video, sampleTime);
        setAiDetectProgress(Math.round((i / totalSteps) * 100));

        const result = await detectFacesSafely(video, detector, confidence);
        detector = result.activeDetector;
        const validDetections = (result.detections || []).filter((det) =>
          isValidFaceDetection(det, filterOptions)
        );

        const rawBoxes = validDetections.map((det) => {
          const bb = det.boundingBox!;
          const rawBox = {
            x: bb.originX,
            y: bb.originY,
            width: bb.width,
            height: bb.height,
          };
          const padded = expandBoxWithMargin(rawBox, 0.35, rawW, rawH);
          return {
            ...padded,
            rawFaceBox: rawBox,
            score: det.categories?.[0]?.score || 0.9,
          };
        });

        currentDetectedPersons = updatePersonTracks(
          currentDetectedPersons,
          rawBoxes,
          sampleTime,
          6
        );

        for (const p of currentDetectedPersons) {
          if (!personKeyframesMap.has(p.trackId)) {
            personKeyframesMap.set(p.trackId, []);
            personScoresMap.set(p.trackId, []);
          }
          const boxToStore = targetMode === 'body'
            ? estimateBodyBoxFromFace(p.box, rawW, rawH)
            : p.box;
          const bodyPoints = targetMode === 'body'
            ? createBodySilhouettePolygon(boxToStore, rawW, rawH)
            : undefined;

          const scaledBox = {
            x: Math.round(boxToStore.x * scaleX),
            y: Math.round(boxToStore.y * scaleY),
            width: Math.round(boxToStore.width * scaleX),
            height: Math.round(boxToStore.height * scaleY),
          };
          const scaledPoints = bodyPoints ? bodyPoints.map((pt) => ({ x: pt.x * scaleX, y: pt.y * scaleY })) : undefined;
          const normPoints = scaledPoints ? absoluteToNormalizedPoints(scaledBox, scaledPoints, NORMALIZED_POINT_COUNT) : undefined;

          personKeyframesMap.get(p.trackId)!.push({
            time: sampleTime,
            ...scaledBox,
            points: scaledPoints,
            normalizedPoints: normPoints,
          });
          personScoresMap.get(p.trackId)!.push(p.score);
        }
      }

      const newTracks: MosaicTrack[] = [];
      const requiredFrames = Math.min(minPersistenceFrames, totalSteps);

      personKeyframesMap.forEach((kfs, personId) => {
        if (kfs.length >= requiredFrames) {
          const scores = personScoresMap.get(personId) || [];
          const avgScore = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
          if (avgScore >= filterOptions.minScore! * 0.95) {
            newTracks.push({
              id: `ai-track-${personId}-${Date.now()}`,
              name: targetMode === 'body' ? `AI人物 (体ライン) #${personId}` : `AI顔 #${personId}`,
              type: 'ai',
              shape: targetMode === 'body' ? 'polygon' : 'rect',
              enabled: true,
              mosaicType: 'pixel',
              strength: 14,
              startTime: kfs[0].time,
              endTime: kfs[kfs.length - 1].time + 0.3,
              keyframes: kfs,
              aiPersonId: personId,
              aiTarget: targetMode,
            });
          }
        }
      });

      await seekVideoSafely(video, origTime);
      setTracks((prev) => [...prev, ...newTracks]);
      if (newTracks.length > 0) {
        setSelectedTrackId(newTracks[0].id);
      }
      if (autoEnableInverse && newTracks.length > 0) {
        setIsInverseMosaic(true);
      }
    }
  };

  // 「人物囲み+背景モザイク」ワンタップアクション
  const handleDetectAndBlurBackground = async () => {
    // 全身ターゲットでAI人物を検出し、自動で背景モザイク（反転モザイク）をON
    setAiTarget('body');
    await handleRunAIFaceDetection('body', true);
  };

  // エクスポート実行
  const handleExport = async () => {
    if (!mediaFile) return;

    if (!isImage && videoRef.current) {
      if (!isWebCodecsSupported()) {
        if (isInAppBrowser()) {
          alert(
            'LINEやSNS等のアプリ内ブラウザではWebCodecs動画書き出しが制限されています。\n画面右上のメニュー（︙等）から「ブラウザで開く（SafariまたはChrome）」を選択してご利用ください。'
          );
        } else {
          alert(
            'お使いのブラウザはWebCodecs API（MP4動画エクスポート）に対応していません。\n最新バージョンのSafari、Chrome、またはEdgeをご利用ください。'
          );
        }
        return;
      }

      if (videoRef.current.duration > 300) {
        const proceed = window.confirm(
          'ブラウザのメモリ制限のため、5分以上の動画は処理中に強制終了する可能性があります。短い動画にカットしてご利用ください。\n\nこのままエクスポートを続行しますか？'
        );
        if (!proceed) return;
      }
    }

    setIsExportModalOpen(true);
    setExportedBlob(null);

    if (isImage && imageRef.current) {
      const img = imageRef.current;
      const rawW = img.naturalWidth || 640;
      const rawH = img.naturalHeight || 480;
      const { width: workW, height: workH } = getClampedDimensions(rawW, rawH, 1280);

      // 元画像の解像度を保持して高品質PNGを生成
      const canvas = document.createElement('canvas');
      canvas.width = rawW;
      canvas.height = rawH;
      const ctx = canvas.getContext('2d')!;

      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = rawW;
      sourceCanvas.height = rawH;
      const srcCtx = sourceCanvas.getContext('2d')!;

      // 元画像を出力Canvasへ等倍転写
      srcCtx.drawImage(img, 0, 0, rawW, rawH);
      ctx.drawImage(sourceCanvas, 0, 0, rawW, rawH);

      // 動画エクスポート（videoExporter）の座標復元ロジックに則り、
      // プレビュー作業解像度（workW, workH）から出力キャンバス（rawW, rawH）へのスケーリングと
      // 余白（レターボックス / contain）のオフセットを正確に計算
      const scale = Math.min(rawW / workW, rawH / workH);
      const drawW = workW * scale;
      const drawH = workH * scale;
      const offsetX = (rawW - drawW) / 2;
      const offsetY = (rawH - drawH) / 2;

      if (isInverseMosaic) {
        // 反転モザイク適用
        const protectedRegions: ProtectedRegion[] = [];
        tracks.forEach((track) => {
          if (!track.enabled) return;
          const pos = track.keyframes[0];
          if (pos && !track.trackingData?.isOutOfFrame) {
            const targetBox = {
              x: offsetX + pos.x * scale,
              y: offsetY + pos.y * scale,
              width: pos.width * scale,
              height: pos.height * scale,
            };
            const targetPoints =
              pos.normalizedPoints && pos.normalizedPoints.length >= 3
                ? normalizedToAbsolutePoints(targetBox, pos.normalizedPoints)
                : pos.points?.map((p) => ({
                    x: offsetX + p.x * scale,
                    y: offsetY + p.y * scale,
                  }));

            protectedRegions.push({
              shape: track.shape,
              x: targetBox.x,
              y: targetBox.y,
              width: targetBox.width,
              height: targetBox.height,
              points: targetPoints,
            });
          }
        });
        renderInverseMosaic(
          ctx,
          protectedRegions,
          rawW,
          rawH,
          inverseMosaicType,
          inverseStrength,
          sourceCanvas
        );
      } else {
        // 通常モザイク適用
        tracks.forEach((track) => {
          if (!track.enabled) return;
          const pos = track.keyframes[0];
          if (pos && !track.trackingData?.isOutOfFrame) {
            const targetBox = {
              x: offsetX + pos.x * scale,
              y: offsetY + pos.y * scale,
              width: pos.width * scale,
              height: pos.height * scale,
            };
            const targetPoints =
              pos.normalizedPoints && pos.normalizedPoints.length >= 3
                ? normalizedToAbsolutePoints(targetBox, pos.normalizedPoints)
                : pos.points?.map((p) => ({
                    x: offsetX + p.x * scale,
                    y: offsetY + p.y * scale,
                  }));

            renderTrackMosaic(
              ctx,
              track,
              {
                ...targetBox,
                points: targetPoints,
              },
              sourceCanvas
            );
          }
        });
      }

      canvas.toBlob((blob) => {
        if (blob) {
          setExportedBlob(blob);
          setExportProgress({ currentFrame: 1, totalFrames: 1, percent: 100, status: '完了！' });
        }
      }, 'image/png');
      return;
    }

    if (videoRef.current) {
      try {
        const blob = await exportMosaicVideo(
          mediaFile,
          videoRef.current,
          tracks,
          {
            isInverseMosaic,
            inverseMosaicType,
            inverseStrength,
          },
          (prog) => setExportProgress(prog)
        );
        setExportedBlob(blob);
      } catch (err) {
        console.error('Export failed', err);
        alert('エクスポートに失敗しました: ' + (err as Error).message);
        setIsExportModalOpen(false);
      }
    }
  };

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId) || null;
  const hasKeyframeAtCurrentTime = Boolean(
    selectedTrack?.keyframes.some((k) => Math.abs(k.time - currentTime) < 0.016)
  );

  const formatTimeStr = (sec: number) => {
    const s = Math.max(0, sec);
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  };

  return (
    <div className="flex flex-col min-h-screen md:h-screen w-screen overflow-x-hidden overflow-y-auto md:overflow-hidden bg-slate-950 text-slate-100">
      {/* 隠しメディア要素（display:none だとスマホのハードウェアデコーダがフレーム描画を省略することがあるため画面外1px配置） */}
      {mediaUrl && (
        <>
          {isImage ? (
            <img
              ref={imageRef}
              src={mediaUrl}
              crossOrigin="anonymous"
              alt="Source"
              onLoad={() => {
                setDuration(1);
              }}
              className="fixed -left-[9999px] -top-[9999px] opacity-0 pointer-events-none"
            />
          ) : (
            <video
              ref={videoRef}
              src={mediaUrl}
              crossOrigin="anonymous"
              preload="auto"
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleEnded}
              playsInline
              className="fixed -left-[9999px] -top-[9999px] w-px h-px opacity-0 pointer-events-none"
            />
          )}
        </>
      )}

      {/* ヘッダー */}
      <Header
        onOpenFile={handleOpenFile}
        onLoadDemo={handleLoadDemo}
        onExport={handleExport}
        hasMedia={Boolean(mediaFile)}
        isProcessing={isAIDetecting || isTrackingProcessing}
      />

      {/* ツールバー */}
      <Toolbar
        editorMode={editorMode}
        onSelectMode={setEditorMode}
        selectedTrack={selectedTrack}
        onUpdateTrackSettings={handleUpdateTrackSettings}
        onDeleteSelectedTrack={() => selectedTrackId && handleDeleteTrack(selectedTrackId)}
        onAddKeyframeAtCurrentTime={handleAddKeyframeAtCurrentTime}
        hasKeyframeAtCurrentTime={hasKeyframeAtCurrentTime}
        onRunAIFaceDetection={() => handleRunAIFaceDetection(aiTarget)}
        isAIDetecting={isAIDetecting}
        aiSensitivity={aiSensitivity}
        onUpdateAiSensitivity={setAiSensitivity}
        aiTarget={aiTarget}
        onUpdateAiTarget={setAiTarget}
        onDetectAndBlurBackground={handleDetectAndBlurBackground}
        isPreviewMode={isPreviewMode}
        onTogglePreviewMode={() => setIsPreviewMode((prev) => !prev)}
        isInverseMosaic={isInverseMosaic}
        onToggleInverseMosaic={() => setIsInverseMosaic((prev) => !prev)}
        inverseMosaicType={inverseMosaicType}
        onUpdateInverseMosaicType={setInverseMosaicType}
        inverseStrength={inverseStrength}
        onUpdateInverseStrength={setInverseStrength}
        onRunTrackingForSelectedTrack={() => selectedTrackId && runTrackingForTrack(selectedTrackId)}
        isTrackingProcessing={isTrackingProcessing}
      />

      {/* 長時間動画（5分以上）のメモリ警告バナー */}
      {durationWarning && (
        <div className="bg-amber-950/90 border-b border-amber-500/60 px-3 py-2 flex items-center justify-between gap-3 text-xs text-amber-200 z-30 shadow-md">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-400 shrink-0" />
            <span>
              <strong className="text-amber-300">メモリ制限警告:</strong> 動画が5分（{Math.floor(duration / 60)}分{Math.floor(duration % 60)}秒）を超えています。ブラウザのメモリ制限のため、5分以上の動画は処理中に強制終了する可能性があります。短い動画にカットしてご利用ください。
            </span>
          </div>
          <button
            onClick={() => setDurationWarning(false)}
            className="text-amber-400 hover:text-white p-1 rounded shrink-0 transition"
            title="警告を閉じる"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* AI顔検出・自動追従解析中のスリープ防止＆進捗ステータスバー */}
      {(isAIDetecting || isTrackingProcessing) && (
        <div className="bg-emerald-950/90 border-b border-emerald-500/40 px-3 py-1.5 flex items-center justify-between gap-3 text-xs text-emerald-200 z-30">
          <div className="flex items-center gap-2 font-semibold">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            <span>
              {isAIDetecting
                ? `AI${aiTarget === 'body' ? '人物' : '顔'}自動検出を実行中... (${aiDetectProgress}%)`
                : '自動追従区間を解析中...'}
            </span>
          </div>
          <span className="text-[11px] bg-emerald-900/80 border border-emerald-600/50 text-emerald-300 px-2 py-0.5 rounded-full font-medium shrink-0">
            ⚡ 画面オフ（スリープ）防止作動中
          </span>
        </div>
      )}

      {/* スマホ専用ビュー切り替えタブ（PCでは非表示） */}
      {mediaUrl && (
        <div className="md:hidden flex items-center justify-around bg-slate-900/90 backdrop-blur border-b border-slate-800 p-1 text-xs font-semibold sticky top-0 z-20">
          <button
            onClick={() => setMobileTab('canvas')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md transition ${
              mobileTab === 'canvas'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Film size={14} />
            <span>映像・囲み</span>
          </button>

          <button
            onClick={() => setMobileTab('list')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md transition relative ${
              mobileTab === 'list'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ListFilter size={14} />
            <span>枠・人物</span>
            {tracks.length > 0 && (
              <span className="bg-indigo-400 text-slate-950 text-[10px] font-black px-1.5 py-0.2 rounded-full">
                {tracks.length}
              </span>
            )}
          </button>

          {!isImage && (
            <button
              onClick={() => setMobileTab('timeline')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md transition ${
                mobileTab === 'timeline'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Clock size={14} />
              <span>タイムライン</span>
            </button>
          )}
        </div>
      )}

      {/* メインプレビュー＆サイドパネルエリア */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        {!mediaUrl ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-slate-400 gap-4 min-h-[350px]">
            <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-3xl shadow-inner">
              🔒
            </div>
            <div className="max-w-md space-y-2">
              <h2 className="text-lg font-bold text-slate-200">
                動画・静止画モザイクエディターへようこそ
              </h2>
              <p className="text-xs text-slate-400 leading-relaxed">
                外部サーバーへの通信はブラウザのCSP（セキュリティポリシー）により遮断されています。動画や画像は端末のメモリ内でのみ処理されます。
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <label className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl cursor-pointer shadow-lg transition">
                <span>動画/画像を選択</span>
                <input
                  type="file"
                  accept="video/*,image/*"
                  onChange={handleOpenFile}
                  className="hidden"
                />
              </label>
              <button
                onClick={handleLoadDemo}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-indigo-700/60 text-xs font-bold rounded-xl shadow transition"
              >
                デモ動画で試す
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* キャンバスエリア（スマホではmobileTab === 'canvas'の時またはPCで表示） */}
            <div
              className={`flex-1 flex flex-col ${
                mobileTab === 'canvas' ? 'flex' : 'hidden md:flex'
              }`}
            >
              <VideoCanvas
                videoRef={videoRef}
                imageRef={imageRef}
                isImage={isImage}
                tracks={tracks}
                selectedTrackId={selectedTrackId}
                editorMode={editorMode}
                currentTime={currentTime}
                isPlaying={isPlaying}
                isPreviewMode={isPreviewMode}
                isInverseMosaic={isInverseMosaic}
                inverseMosaicType={inverseMosaicType}
                inverseStrength={inverseStrength}
                onSelectTrack={setSelectedTrackId}
                onAddTrack={handleAddTrack}
                onUpdateTrackKeyframe={handleUpdateTrackKeyframe}
                onToggleTrackEnabled={handleToggleTrackEnabled}
                onUpdateTrackFrameOut={handleUpdateTrackFrameOut}
                onDeleteTrack={handleDeleteTrack}
                onConvertTrackToPolygon={handleConvertTrackToPolygon}
              />

              {/* スマホ専用の直感クイック操作＆1フレーム送り・キーフレーム編集バー */}
              {!isImage && (
                <div className="md:hidden bg-slate-900 border-t border-slate-800 p-2 flex flex-col gap-2 text-xs select-none">
                  {/* Row 1: 再生/停止 + シークバー + 時間表示 */}
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={togglePlay}
                      className="p-1.5 bg-indigo-600 active:bg-indigo-700 text-white rounded-lg shadow font-bold flex items-center justify-center shrink-0 w-8 h-8"
                      title={isPlaying ? '一時停止' : '再生'}
                    >
                      {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
                    </button>

                    <div className="flex-1 flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max={duration || 1}
                        step="0.033333"
                        value={currentTime}
                        onChange={(e) => handleSeek(Number(e.target.value))}
                        className="w-full accent-indigo-500 h-2 bg-slate-800 rounded-lg cursor-pointer"
                      />
                      <span className="font-mono text-[11px] text-slate-300 shrink-0">
                        {formatTimeStr(currentTime)} / {formatTimeStr(duration)}
                      </span>
                    </div>
                  </div>

                  {/* Row 2: 1コマ送り・戻し ＆ キーフレーム固定・移動コントロール */}
                  <div className="flex items-center justify-between gap-1 bg-slate-950/60 p-1.5 rounded-lg border border-slate-800">
                    {/* コマ送り/戻し & KFジャンプ */}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleJumpToKeyframe('prev')}
                        disabled={!selectedTrack || selectedTrack.keyframes.length === 0}
                        className="p-1.5 bg-slate-800 hover:bg-slate-700 active:bg-slate-600 disabled:opacity-30 disabled:pointer-events-none text-slate-300 rounded font-semibold flex items-center justify-center"
                        title="前のキーフレームへ"
                      >
                        <ChevronFirst size={15} />
                      </button>
                      <button
                        onClick={() => handleStepFrame(-1)}
                        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-200 rounded font-mono font-bold flex items-center gap-0.5 text-[11px]"
                        title="1コマ戻る (-1F)"
                      >
                        <ChevronLeft size={13} />
                        <span>-1F</span>
                      </button>
                    </div>

                    {/* フレーム番号表示バッジ */}
                    <div className="flex flex-col items-center px-1 font-mono text-[10px] text-slate-400">
                      <span className="text-cyan-400 font-bold text-[11px]">
                        F{Math.round(currentTime * 30)}
                      </span>
                      <span>/ {Math.max(1, Math.round(duration * 30))}</span>
                    </div>

                    {/* コマ進み & KFジャンプ */}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleStepFrame(1)}
                        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-200 rounded font-mono font-bold flex items-center gap-0.5 text-[11px]"
                        title="1コマ進む (+1F)"
                      >
                        <span>+1F</span>
                        <ChevronRight size={13} />
                      </button>
                      <button
                        onClick={() => handleJumpToKeyframe('next')}
                        disabled={!selectedTrack || selectedTrack.keyframes.length === 0}
                        className="p-1.5 bg-slate-800 hover:bg-slate-700 active:bg-slate-600 disabled:opacity-30 disabled:pointer-events-none text-slate-300 rounded font-semibold flex items-center justify-center"
                        title="次のキーフレームへ"
                      >
                        <ChevronLast size={15} />
                      </button>
                    </div>

                    {/* 枠固定（キーフレーム登録・更新）ボタン */}
                    {selectedTrack && (
                      <button
                        onClick={handleAddKeyframeAtCurrentTime}
                        className={`px-2.5 py-1 text-[11px] font-bold rounded flex items-center gap-1 transition-colors ${
                          hasKeyframeAtCurrentTime
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/50'
                            : 'bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white shadow'
                        }`}
                        title="現在コマのモザイク位置・形をキーフレームとして記録"
                      >
                        <span>{hasKeyframeAtCurrentTime ? '枠固定済' : '枠固定'}</span>
                      </button>
                    )}
                  </div>

                  {/* Row 3: 選択枠の操作クイックボタン */}
                  {selectedTrack && (
                    <div className="flex items-center justify-between gap-2 pt-0.5">
                      <span className="text-[11px] text-cyan-400 font-semibold truncate max-w-[130px]">
                        {selectedTrack.name}
                        {selectedTrack.keyframes.length > 0 && (
                          <span className="text-[10px] text-slate-400 font-normal ml-1">
                            ({selectedTrack.keyframes.length}点)
                          </span>
                        )}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {selectedTrack.type === 'tracked' && (
                          <button
                            onClick={() => runTrackingForTrack(selectedTrack.id)}
                            disabled={isTrackingProcessing}
                            className="px-2 py-0.5 bg-indigo-900/80 hover:bg-indigo-800 border border-indigo-500 text-indigo-200 text-[10px] font-bold rounded flex items-center gap-1"
                          >
                            <Play size={10} className="fill-indigo-300" />
                            <span>{isTrackingProcessing ? '解析中...' : '自動追従'}</span>
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteTrack(selectedTrack.id)}
                          className="px-2 py-0.5 bg-rose-950/80 hover:bg-rose-900 border border-rose-600/70 text-rose-200 text-[10px] font-bold rounded flex items-center gap-0.5"
                        >
                          <Trash2 size={10} />
                          <span>削除</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 人物・指定領域リスト サイドパネル（スマホではmobileTab === 'list'の時またはPCで表示） */}
            <div
              className={`w-full md:w-64 ${
                mobileTab === 'list' ? 'flex flex-1' : 'hidden md:flex'
              }`}
            >
              <PersonListPanel
                tracks={tracks}
                selectedTrackId={selectedTrackId}
                onSelectTrack={setSelectedTrackId}
                onToggleTrackEnabled={handleToggleTrackEnabled}
                onToggleAllAITracks={handleToggleAllAITracks}
                onDeleteTrack={handleDeleteTrack}
                onDeleteAllUserTracks={handleDeleteAllUserTracks}
              />
            </div>

            {/* スマホ専用のタイムライン画面（mobileTab === 'timeline'の時のみ表示） */}
            {mediaUrl && !isImage && (
              <div
                className={`w-full ${
                  mobileTab === 'timeline' ? 'block flex-1' : 'hidden'
                }`}
              >
                <Timeline
                  duration={duration}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  tracks={tracks}
                  selectedTrackId={selectedTrackId}
                  onSeek={handleSeek}
                  onTogglePlay={togglePlay}
                  onSelectTrack={setSelectedTrackId}
                  onUpdateTrackTime={handleUpdateTrackTime}
                  onToggleTrackEnabled={handleToggleTrackEnabled}
                  onDeleteTrack={handleDeleteTrack}
                  onSetInPoint={handleSetInPoint}
                  onSetOutPoint={handleSetOutPoint}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* PC専用のタイムライン（PC表示時 md:block で下部に常時表示） */}
      {mediaUrl && !isImage && (
        <div className="hidden md:block">
          <Timeline
            duration={duration}
            currentTime={currentTime}
            isPlaying={isPlaying}
            tracks={tracks}
            selectedTrackId={selectedTrackId}
            onSeek={handleSeek}
            onTogglePlay={togglePlay}
            onSelectTrack={setSelectedTrackId}
            onUpdateTrackTime={handleUpdateTrackTime}
            onToggleTrackEnabled={handleToggleTrackEnabled}
            onDeleteTrack={handleDeleteTrack}
            onSetInPoint={handleSetInPoint}
            onSetOutPoint={handleSetOutPoint}
          />
        </div>
      )}

      {/* エクスポート進行＆完成プレビューモーダル */}
      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        progress={exportProgress}
        exportedBlob={exportedBlob}
        isImage={isImage}
      />
    </div>
  );
};
