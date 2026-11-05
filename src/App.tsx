import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { Toolbar } from './components/Toolbar';
import { VideoCanvas } from './components/VideoCanvas';
import { Timeline } from './components/Timeline';
import { PersonListPanel } from './components/PersonListPanel';
import { ExportModal } from './components/ExportModal';
import { EditorMode, MosaicTrack, Point } from './types';
import { initFaceDetector, updatePersonTracks } from './utils/aiDetector';
import { exportMosaicVideo, ExportProgress, saveOrShareBlob } from './utils/videoExporter';
import { generateDemoVideoBlob } from './utils/sampleGenerator';
import { renderTrackMosaic } from './utils/mosaicRenderer';

export const App: React.FC = () => {
  // メディア状態
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [isImage, setIsImage] = useState<boolean>(false);
  const [duration, setDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  // トラック・編集状態
  const [tracks, setTracks] = useState<MosaicTrack[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>('select');

  // AIおよびエクスポート進行状態
  const [isAIDetecting, setIsAIDetecting] = useState<boolean>(false);
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
      setDuration(videoRef.current.duration || 1);
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
  };

  // トラック削除
  const handleDeleteTrack = (id: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== id));
    if (selectedTrackId === id) setSelectedTrackId(null);
  };

  // トラック更新
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

    // 現在の補間位置を取得しキーフレームとして固定
    const pos = track.keyframes[0]; // 直近
    if (!pos) return;

    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== selectedTrackId) return t;
        const filtered = t.keyframes.filter((k) => Math.abs(k.time - currentTime) > 0.05);
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
            },
          ].sort((a, b) => a.time - b.time),
        };
      })
    );
  };

  const handleUpdateTrackKeyframe = (
    trackId: string,
    box: { x: number; y: number; width: number; height: number; points?: Point[] }
  ) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;

        // 既存のキーフレームのうち、現在時刻に近いものを更新、なければ追加
        const existingIdx = t.keyframes.findIndex(
          (k) => Math.abs(k.time - currentTime) < 0.15
        );
        let updatedKeyframes = [...t.keyframes];

        if (existingIdx !== -1) {
          updatedKeyframes[existingIdx] = {
            ...updatedKeyframes[existingIdx],
            ...box,
          };
        } else {
          updatedKeyframes.push({
            time: currentTime,
            ...box,
          });
          updatedKeyframes.sort((a, b) => a.time - b.time);
        }

        return {
          ...t,
          keyframes: updatedKeyframes,
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

  // MediaPipe によるAI人物・顔の自動検出＆追跡
  const handleRunAIFaceDetection = async () => {
    if (!videoRef.current && !imageRef.current) return;
    setIsAIDetecting(true);

    try {
      const detector = await initFaceDetector();

      if (isImage && imageRef.current) {
        // 静止画の場合
        const result = detector.detect(imageRef.current);
        const newAITracks: MosaicTrack[] = (result.detections || []).map((det, idx) => {
          const bb = det.boundingBox;
          const x = bb ? bb.originX : 0;
          const y = bb ? bb.originY : 0;
          const w = bb ? bb.width : 50;
          const h = bb ? bb.height : 50;
          return {
            id: `ai-face-${Date.now()}-${idx}`,
            name: `AI人物 #${idx + 1}`,
            type: 'ai',
            shape: 'rect',
            enabled: true,
            mosaicType: 'pixel',
            strength: 14,
            startTime: 0,
            endTime: 1,
            keyframes: [{ time: 0, x, y, width: w, height: h }],
          };
        });
        setTracks((prev) => [...prev, ...newAITracks]);
      } else if (videoRef.current) {
        // 動画の場合: 全体をスキャンし各人物のキーフレーム列を構築
        const video = videoRef.current;
        const origTime = video.currentTime;
        const totalDuration = video.duration || 5;
        const step = 0.25; // 0.25秒間隔でサンプリング
        const totalSteps = Math.floor(totalDuration / step);

        let currentDetectedPersons: any[] = [];
        const personKeyframesMap = new Map<number, any[]>();

        for (let i = 0; i <= totalSteps; i++) {
          const sampleTime = Math.min(totalDuration, i * step);
          video.currentTime = sampleTime;

          await new Promise<void>((res) => {
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              res();
            };
            video.addEventListener('seeked', onSeeked);
          });

          const result = detector.detect(video);
          const rawBoxes = (result.detections || []).map((det) => {
            const bb = det.boundingBox!;
            return {
              x: bb.originX,
              y: bb.originY,
              width: bb.width,
              height: bb.height,
              score: det.categories?.[0]?.score || 0.9,
            };
          });

          // IoUトラッキングと見失い補間
          currentDetectedPersons = updatePersonTracks(
            currentDetectedPersons,
            rawBoxes,
            sampleTime,
            6 // 6フレーム見失いバッファ
          );

          for (const p of currentDetectedPersons) {
            if (!personKeyframesMap.has(p.trackId)) {
              personKeyframesMap.set(p.trackId, []);
            }
            personKeyframesMap.get(p.trackId)!.push({
              time: sampleTime,
              x: p.box.x,
              y: p.box.y,
              width: p.box.width,
              height: p.box.height,
            });
          }
        }

        // トラックへ変換
        const newTracks: MosaicTrack[] = [];
        personKeyframesMap.forEach((kfs, personId) => {
          if (kfs.length > 0) {
            newTracks.push({
              id: `ai-track-${personId}-${Date.now()}`,
              name: `AI人物 #${personId}`,
              type: 'ai',
              shape: 'rect',
              enabled: true,
              mosaicType: 'pixel',
              strength: 14,
              startTime: kfs[0].time,
              endTime: kfs[kfs.length - 1].time + 0.5,
              keyframes: kfs,
              aiPersonId: personId,
            });
          }
        });

        video.currentTime = origTime;
        setTracks((prev) => [...prev, ...newTracks]);
      }
    } catch (err) {
      console.error('AI Detection failed', err);
      alert('AI検出の実行に失敗しました: ' + (err as Error).message);
    } finally {
      setIsAIDetecting(false);
    }
  };

  // エクスポート実行
  const handleExport = async () => {
    if (!mediaFile) return;

    setIsExportModalOpen(true);
    setExportedBlob(null);

    if (isImage && imageRef.current) {
      // 画像の場合: Canvas から PNG Blob を生成
      const canvas = document.createElement('canvas');
      canvas.width = imageRef.current.naturalWidth;
      canvas.height = imageRef.current.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(imageRef.current, 0, 0);

      // モザイク適用
      tracks.forEach((track) => {
        if (track.enabled && track.keyframes[0]) {
          const k = track.keyframes[0];
          renderTrackMosaic(ctx, track, k, canvas);
        }
      });
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
    selectedTrack?.keyframes.some((k) => Math.abs(k.time - currentTime) < 0.1)
  );

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
      {/* 隠しメディア要素 */}
      {mediaUrl && (
        <>
          {isImage ? (
            <img
              ref={imageRef}
              src={mediaUrl}
              alt="Source"
              className="hidden"
            />
          ) : (
            <video
              ref={videoRef}
              src={mediaUrl}
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleEnded}
              playsInline
              crossOrigin="anonymous"
              className="hidden"
            />
          )}
        </>
      )}

      {/* ヘッダー（完全ローカルセキュリティバッジ & ファイル読み込み & 書き出し） */}
      <Header
        onOpenFile={handleOpenFile}
        onLoadDemo={handleLoadDemo}
        onExport={handleExport}
        hasMedia={Boolean(mediaFile)}
        isProcessing={isAIDetecting}
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
        onRunAIFaceDetection={handleRunAIFaceDetection}
        isAIDetecting={isAIDetecting}
      />

      {/* メインプレビュー＆サイドパネルエリア */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        {!mediaUrl ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-slate-400 gap-4">
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
            <VideoCanvas
              videoRef={videoRef}
              imageRef={imageRef}
              isImage={isImage}
              tracks={tracks}
              selectedTrackId={selectedTrackId}
              editorMode={editorMode}
              currentTime={currentTime}
              isPlaying={isPlaying}
              onSelectTrack={setSelectedTrackId}
              onAddTrack={handleAddTrack}
              onUpdateTrackKeyframe={handleUpdateTrackKeyframe}
              onToggleTrackEnabled={handleToggleTrackEnabled}
              onUpdateTrackFrameOut={handleUpdateTrackFrameOut}
            />

            {/* 人物・指定領域リスト サイドパネル */}
            <PersonListPanel
              tracks={tracks}
              selectedTrackId={selectedTrackId}
              onSelectTrack={setSelectedTrackId}
              onToggleTrackEnabled={handleToggleTrackEnabled}
              onToggleAllAITracks={handleToggleAllAITracks}
            />
          </>
        )}
      </div>

      {/* タイムライン（動画の場合のみ表示） */}
      {mediaUrl && !isImage && (
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
      )}

      {/* エクスポート進行モーダル */}
      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        progress={exportProgress}
        exportedBlob={exportedBlob}
      />
    </div>
  );
};
