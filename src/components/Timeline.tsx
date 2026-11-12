import React, { useRef, useState, useEffect } from 'react';
import { MosaicTrack } from '../types';
import { Play, Pause, ChevronLeft, ChevronRight, SkipBack, SkipForward } from 'lucide-react';

interface TimelineProps {
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  tracks: MosaicTrack[];
  selectedTrackId: string | null;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  onSelectTrack: (id: string | null) => void;
  onUpdateTrackTime: (id: string, startTime: number, endTime: number) => void;
  onToggleTrackEnabled: (id: string) => void;
  onDeleteTrack: (id: string) => void;
  onSetInPoint: () => void;
  onSetOutPoint: () => void;
}

// タイムライン両端の余白（画面端でのタッチ操作性・最後までの確実な伸縮を担保）
const TIMELINE_GUTTER = 20;

export const Timeline: React.FC<TimelineProps> = ({
  duration,
  currentTime,
  isPlaying,
  tracks,
  selectedTrackId,
  onSeek,
  onTogglePlay,
  onSelectTrack,
  onUpdateTrackTime,
  onToggleTrackEnabled,
  onDeleteTrack,
  onSetInPoint,
  onSetOutPoint,
}) => {
  const rulerRef = useRef<HTMLDivElement>(null);
  const [draggingHandle, setDraggingHandle] = useState<{
    trackId: string;
    type: 'start' | 'end' | 'move';
    initialMouseX: number;
    initialStart: number;
    initialEnd: number;
  } | null>(null);

  // 時間フォーマット (分:秒.1/10秒)
  const formatTime = (sec: number) => {
    const s = Math.max(0, sec);
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  };

  // 画面X座標からタイムライン時間（秒）を計算（両端GUTTER余白考慮・スナップ付き）
  const getTimeFromClientX = (clientX: number) => {
    if (!rulerRef.current || duration <= 0) return 0;
    const rect = rulerRef.current.getBoundingClientRect();
    const trackWidth = Math.max(1, rect.width - TIMELINE_GUTTER * 2);
    const relX = clientX - (rect.left + TIMELINE_GUTTER);
    const ratio = Math.max(0, Math.min(1, relX / trackWidth));
    return ratio * duration;
  };

  // ルーラー上のクリック/ドラッグでシーク
  const handleRulerMouseDown = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
    if (!rulerRef.current || duration <= 0) return;
    const clientX = 'touches' in e && e.touches.length > 0 ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const time = getTimeFromClientX(clientX);
    onSeek(time);
  };

  // トラックバーのドラッグ（In点・Out点・全体の移動）開始
  const handleStartDrag = (
    e: React.MouseEvent | React.TouchEvent,
    track: MosaicTrack,
    type: 'start' | 'end' | 'move'
  ) => {
    e.stopPropagation();
    const clientX = 'touches' in e && e.touches.length > 0 ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    setDraggingHandle({
      trackId: track.id,
      type,
      initialMouseX: clientX,
      initialStart: track.startTime,
      initialEnd: track.endTime,
    });
    onSelectTrack(track.id);
  };

  useEffect(() => {
    if (!draggingHandle) return;

    const handleMouseMove = (e: MouseEvent | TouchEvent) => {
      if (!rulerRef.current || duration <= 0) return;
      const rect = rulerRef.current.getBoundingClientRect();
      const clientX = 'touches' in e && e.touches.length > 0 ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const trackWidth = Math.max(1, rect.width - TIMELINE_GUTTER * 2);
      const deltaRatio = (clientX - draggingHandle.initialMouseX) / trackWidth;
      const deltaTime = deltaRatio * duration;

      if (draggingHandle.type === 'start') {
        let newStart = Math.max(0, Math.min(draggingHandle.initialEnd - 0.1, draggingHandle.initialStart + deltaTime));
        // 先頭（0秒）付近でのマグネットスナップ
        if (newStart < 0.25) newStart = 0;
        // 現在の再生ヘッド付近でのスナップ
        if (Math.abs(newStart - currentTime) < 0.12) newStart = currentTime;
        onUpdateTrackTime(draggingHandle.trackId, newStart, draggingHandle.initialEnd);
      } else if (draggingHandle.type === 'end') {
        let newEnd = Math.min(duration, Math.max(draggingHandle.initialStart + 0.1, draggingHandle.initialEnd + deltaTime));
        // 末尾（最後）付近でのマグネットスナップ（目一杯伸ばしやすくする）
        if (duration - newEnd < 0.25) newEnd = duration;
        // 現在の再生ヘッド付近でのスナップ
        if (Math.abs(newEnd - currentTime) < 0.12) newEnd = currentTime;
        onUpdateTrackTime(draggingHandle.trackId, draggingHandle.initialStart, newEnd);
      } else if (draggingHandle.type === 'move') {
        const trackLen = draggingHandle.initialEnd - draggingHandle.initialStart;
        let newStart = draggingHandle.initialStart + deltaTime;
        let newEnd = draggingHandle.initialEnd + deltaTime;
        if (newStart < 0) {
          newStart = 0;
          newEnd = trackLen;
        }
        if (newEnd > duration) {
          newEnd = duration;
          newStart = Math.max(0, duration - trackLen);
        }
        onUpdateTrackTime(draggingHandle.trackId, newStart, newEnd);
      }
    };

    const handleMouseUp = () => {
      setDraggingHandle(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('touchmove', handleMouseMove);
    window.addEventListener('touchend', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchmove', handleMouseMove);
      window.removeEventListener('touchend', handleMouseUp);
    };
  }, [draggingHandle, duration, currentTime, onUpdateTrackTime]);

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const selectedTrack = tracks.find((t) => t.id === selectedTrackId);

  return (
    <div className="bg-slate-900 border-t border-slate-800 p-2 sm:p-3 select-none flex flex-col gap-2">
      {/* タイムライン操作バー */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
        {/* 再生制御＆時間表示 */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => onSeek(Math.max(0, currentTime - 1 / 30))}
            className="p-1.5 hover:bg-slate-800 rounded text-slate-300 hover:text-white"
            title="1フレーム戻る"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={onTogglePlay}
            className="p-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full transition shadow"
            title={isPlaying ? '一時停止' : '再生'}
          >
            {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
          </button>
          <button
            onClick={() => onSeek(Math.min(duration, currentTime + 1 / 30))}
            className="p-1.5 hover:bg-slate-800 rounded text-slate-300 hover:text-white"
            title="1フレーム進む"
          >
            <ChevronRight size={16} />
          </button>

          {/* 時間表示 */}
          <div className="ml-2 font-mono bg-slate-950 px-2 py-1 rounded border border-slate-800 text-cyan-400 font-semibold text-[11px] sm:text-xs">
            {formatTime(currentTime)} <span className="text-slate-500">/ {formatTime(duration)}</span>
          </div>
        </div>

        {/* In点・Out点 & 端まで伸ばすクイック操作ボタン群 */}
        <div className="flex flex-wrap items-center gap-1 sm:gap-1.5">
          {/* 先頭（0秒）まで伸ばす一発ボタン */}
          <button
            type="button"
            onClick={() => {
              if (selectedTrack) {
                onUpdateTrackTime(selectedTrack.id, 0, selectedTrack.endTime);
              }
            }}
            disabled={!selectedTrackId}
            className="flex items-center gap-1 px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-[11px] font-semibold rounded border border-slate-700 text-amber-300 hover:text-amber-200 transition shadow-sm"
            title="選択中モザイクの開始時間を動画の先頭（0秒）まで一発で伸ばす"
          >
            <SkipBack size={12} className="text-amber-400" />
            <span className="hidden sm:inline">0秒まで</span>
            <span className="sm:hidden">0秒</span>
          </button>

          {/* In点指定 */}
          <button
            type="button"
            onClick={onSetInPoint}
            disabled={!selectedTrackId}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-[11px] font-medium rounded border border-slate-700 text-slate-200 transition shadow-sm"
            title="選択中のモザイクの開始時間を現在の再生位置に設定"
          >
            [ In点
          </button>

          {/* Out点指定 */}
          <button
            type="button"
            onClick={onSetOutPoint}
            disabled={!selectedTrackId}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-[11px] font-medium rounded border border-slate-700 text-slate-200 transition shadow-sm"
            title="選択中のモザイクの終了時間を現在の再生位置に設定"
          >
            Out点 ]
          </button>

          {/* 最後（動画末尾）まで伸ばす一発ボタン */}
          <button
            type="button"
            onClick={() => {
              if (selectedTrack && duration > 0) {
                onUpdateTrackTime(selectedTrack.id, selectedTrack.startTime, duration);
              }
            }}
            disabled={!selectedTrackId || duration <= 0}
            className="flex items-center gap-1 px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-[11px] font-semibold rounded border border-slate-700 text-amber-300 hover:text-amber-200 transition shadow-sm"
            title="選択中モザイクの終了時間を動画の最後（末尾）まで一発で伸ばす"
          >
            <span className="hidden sm:inline">最後まで</span>
            <span className="sm:hidden">最後</span>
            <SkipForward size={12} className="text-amber-400" />
          </button>
        </div>
      </div>

      {/* タイムルーラー＆トラックレーン */}
      <div
        ref={rulerRef}
        onMouseDown={handleRulerMouseDown}
        onTouchStart={handleRulerMouseDown}
        className="relative bg-slate-950 border border-slate-800 rounded h-32 overflow-hidden cursor-pointer"
      >
        {/* 目盛りライン */}
        <div
          className="absolute inset-y-0 flex justify-between pointer-events-none opacity-20"
          style={{ left: TIMELINE_GUTTER, right: TIMELINE_GUTTER }}
        >
          {[...Array(11)].map((_, i) => (
            <div key={i} className="h-full border-r border-slate-400" />
          ))}
        </div>

        {/* 左右余白インジケーター（先頭と末尾の境界線） */}
        <div
          className="absolute top-0 bottom-0 w-px bg-slate-800 pointer-events-none"
          style={{ left: TIMELINE_GUTTER }}
        />
        <div
          className="absolute top-0 bottom-0 w-px bg-slate-800 pointer-events-none"
          style={{ right: TIMELINE_GUTTER }}
        />

        {/* 各トラックのレーン（左右余白内に整然と配置） */}
        <div
          className="absolute inset-y-0 py-1.5 flex flex-col gap-1.5 overflow-y-auto"
          style={{ left: TIMELINE_GUTTER, right: TIMELINE_GUTTER }}
        >
          {tracks.map((track) => {
            const isSelected = track.id === selectedTrackId;
            const leftPercent = duration > 0 ? (track.startTime / duration) * 100 : 0;
            const widthPercent = duration > 0 ? ((track.endTime - track.startTime) / duration) * 100 : 100;

            const barColor = !track.enabled
              ? 'bg-slate-700/80 border-slate-600'
              : track.type === 'ai'
              ? isSelected
                ? 'bg-emerald-600 border-emerald-300 ring-2 ring-emerald-400/40 shadow-md'
                : 'bg-emerald-800/80 border-emerald-600/70 hover:bg-emerald-700/80'
              : isSelected
              ? 'bg-indigo-600 border-indigo-300 ring-2 ring-indigo-400/40 shadow-md'
              : 'bg-indigo-800/80 border-indigo-600/70 hover:bg-indigo-700/80';

            return (
              <div
                key={track.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectTrack(track.id);
                }}
                className={`relative ${
                  isSelected ? 'h-8 sm:h-9 z-10' : 'h-6 sm:h-7'
                } text-xs flex items-center transition-all ${
                  isSelected ? 'bg-slate-900/60 rounded' : ''
                }`}
              >
                {/* トラック名ラベル */}
                <div className="absolute left-1 z-10 flex items-center gap-1 text-[10px] font-semibold text-slate-200 drop-shadow-md pointer-events-none truncate max-w-[120px]">
                  <span>{track.name}</span>
                </div>

                {/* タイムバー本体 */}
                <div
                  style={{
                    left: `${leftPercent}%`,
                    width: `${Math.max(1, widthPercent)}%`,
                  }}
                  onMouseDown={(e) => handleStartDrag(e, track, 'move')}
                  onTouchStart={(e) => handleStartDrag(e, track, 'move')}
                  className={`absolute h-full rounded-md border cursor-grab active:cursor-grabbing flex items-center justify-between shadow-sm select-none ${barColor}`}
                >
                  {/* 左端ハンドル（広域タッチ領域 28px + 視覚的ピルグリップ） */}
                  <div
                    onMouseDown={(e) => handleStartDrag(e, track, 'start')}
                    onTouchStart={(e) => handleStartDrag(e, track, 'start')}
                    className="absolute -left-3.5 top-0 bottom-0 w-7 flex items-center justify-center cursor-ew-resize z-20 touch-none group/handle"
                    title="ドラッグで開始時間を調整"
                  >
                    <div
                      className={`w-2 h-[85%] rounded-full shadow-md flex flex-col items-center justify-center gap-0.5 border transition ${
                        isSelected
                          ? 'bg-amber-300 border-amber-500 shadow-amber-400/50 scale-110'
                          : 'bg-white/90 border-slate-600 group-hover/handle:bg-white'
                      }`}
                    >
                      <div className="w-1 h-0.5 bg-slate-700/60 rounded-full" />
                      <div className="w-1 h-0.5 bg-slate-700/60 rounded-full" />
                    </div>
                  </div>

                  {/* キーフレーム目印 */}
                  <div className="flex gap-1 overflow-hidden pointer-events-none mx-2">
                    {track.keyframes.map((k, kidx) => {
                      const kPercent =
                        track.endTime > track.startTime
                          ? ((k.time - track.startTime) / (track.endTime - track.startTime)) * 100
                          : 0;
                      return (
                        <div
                          key={kidx}
                          style={{ left: `${kPercent}%` }}
                          className="w-1.5 h-1.5 bg-yellow-300 rotate-45 rounded-[1px] shadow-sm"
                        />
                      );
                    })}
                  </div>

                  {/* 右端ハンドル（広域タッチ領域 28px + 視覚的ピルグリップ） */}
                  <div
                    onMouseDown={(e) => handleStartDrag(e, track, 'end')}
                    onTouchStart={(e) => handleStartDrag(e, track, 'end')}
                    className="absolute -right-3.5 top-0 bottom-0 w-7 flex items-center justify-center cursor-ew-resize z-20 touch-none group/handle"
                    title="ドラッグで終了時間を調整"
                  >
                    <div
                      className={`w-2 h-[85%] rounded-full shadow-md flex flex-col items-center justify-center gap-0.5 border transition ${
                        isSelected
                          ? 'bg-amber-300 border-amber-500 shadow-amber-400/50 scale-110'
                          : 'bg-white/90 border-slate-600 group-hover/handle:bg-white'
                      }`}
                    >
                      <div className="w-1 h-0.5 bg-slate-700/60 rounded-full" />
                      <div className="w-1 h-0.5 bg-slate-700/60 rounded-full" />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* 再生ヘッド（現在の再生位置インジケーター） */}
        <div
          className="absolute inset-y-0 pointer-events-none"
          style={{ left: TIMELINE_GUTTER, right: TIMELINE_GUTTER }}
        >
          <div
            style={{ left: `${progressPercent}%` }}
            className="absolute top-0 bottom-0 w-0.5 bg-rose-500 z-30"
          >
            <div className="w-2.5 h-2.5 -ml-1 -mt-0.5 bg-rose-500 rotate-45 rounded-[1px] shadow" />
          </div>
        </div>
      </div>
    </div>
  );
};
