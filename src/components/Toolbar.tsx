import React from 'react';
import { EditorMode, MosaicType, MosaicTrack } from '../types';
import {
  MousePointer,
  Square,
  Paintbrush,
  Pentagon,
  UserCheck,
  Sliders,
  Trash2,
  Eye,
  EyeOff,
  Crosshair,
  CheckCircle2,
} from 'lucide-react';

interface ToolbarProps {
  editorMode: EditorMode;
  onSelectMode: (mode: EditorMode) => void;
  selectedTrack: MosaicTrack | null;
  onUpdateTrackSettings: (updates: Partial<MosaicTrack>) => void;
  onDeleteSelectedTrack: () => void;
  onAddKeyframeAtCurrentTime: () => void;
  hasKeyframeAtCurrentTime: boolean;
  onRunAIFaceDetection: () => void;
  isAIDetecting: boolean;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  editorMode,
  onSelectMode,
  selectedTrack,
  onUpdateTrackSettings,
  onDeleteSelectedTrack,
  onAddKeyframeAtCurrentTime,
  hasKeyframeAtCurrentTime,
  onRunAIFaceDetection,
  isAIDetecting,
}) => {
  return (
    <div className="bg-slate-900 border-b border-slate-800 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
      {/* ツール選択ボタン群 */}
      <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
        <button
          onClick={() => onSelectMode('select')}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md font-medium transition ${
            editorMode === 'select'
              ? 'bg-indigo-600 text-white shadow'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="選択・移動・調整"
        >
          <MousePointer size={14} />
          <span className="hidden sm:inline">選択・移動</span>
        </button>

        <button
          onClick={() => onSelectMode('add_rect')}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md font-medium transition ${
            editorMode === 'add_rect'
              ? 'bg-indigo-600 text-white shadow'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="ドラッグして矩形領域を指定し自動追従"
        >
          <Square size={14} />
          <span>矩形追従</span>
        </button>

        <button
          onClick={() => onSelectMode('add_brush')}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md font-medium transition ${
            editorMode === 'add_brush'
              ? 'bg-indigo-600 text-white shadow'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="指やマウスで自由になぞって指定"
        >
          <Paintbrush size={14} />
          <span>ブラシ</span>
        </button>

        <button
          onClick={() => onSelectMode('add_polygon')}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md font-medium transition ${
            editorMode === 'add_polygon'
              ? 'bg-indigo-600 text-white shadow'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="クリックして多角形領域を指定"
        >
          <Pentagon size={14} />
          <span className="hidden sm:inline">ポリゴン</span>
        </button>

        <div className="w-px h-5 bg-slate-800 mx-1" />

        <button
          onClick={onRunAIFaceDetection}
          disabled={isAIDetecting}
          className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-500/40 text-emerald-300 rounded-md font-semibold transition"
          title="MediaPipeで動画内の人物・顔を自動検出して追跡"
        >
          <UserCheck size={14} />
          <span>{isAIDetecting ? 'AI解析中...' : 'AI顔自動検出'}</span>
        </button>
      </div>

      {/* 選択中のモザイクの設定コントロール */}
      {selectedTrack ? (
        <div className="flex flex-wrap items-center gap-2 bg-slate-950 px-2 py-1.5 rounded-lg border border-slate-800">
          <div className="flex items-center gap-1 font-semibold text-slate-300">
            <span className="text-cyan-400">[{selectedTrack.name}]</span>
          </div>

          {/* モザイク種類 */}
          <div className="flex items-center bg-slate-900 rounded p-0.5 border border-slate-800">
            {(['pixel', 'blur', 'black'] as MosaicType[]).map((mType) => (
              <button
                key={mType}
                onClick={() => onUpdateTrackSettings({ mosaicType: mType })}
                className={`px-2 py-1 rounded text-[11px] font-medium capitalize transition ${
                  selectedTrack.mosaicType === mType
                    ? 'bg-indigo-600 text-white font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {mType === 'pixel' ? 'モザイク' : mType === 'blur' ? 'すりガラス' : '黒塗り'}
              </button>
            ))}
          </div>

          {/* 強度スライダー */}
          {selectedTrack.mosaicType !== 'black' && (
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <span>強度:</span>
              <input
                type="range"
                min="4"
                max="40"
                value={selectedTrack.strength}
                onChange={(e) => onUpdateTrackSettings({ strength: Number(e.target.value) })}
                className="w-16 sm:w-20 accent-indigo-500 h-1.5 bg-slate-800 rounded cursor-pointer"
              />
              <span className="font-mono text-slate-200 w-4">{selectedTrack.strength}</span>
            </div>
          )}

          {/* 手動キーフレーム補正ボタン（ズレ修正） */}
          <button
            onClick={onAddKeyframeAtCurrentTime}
            className={`flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-medium transition ${
              hasKeyframeAtCurrentTime
                ? 'bg-amber-950/70 border-amber-500 text-amber-300'
                : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
            }`}
            title="現在の再生位置に位置を記録（前後のズレを線形補間）"
          >
            <Crosshair size={13} />
            <span>{hasKeyframeAtCurrentTime ? '位置更新済' : '位置を補正 (Key)'}</span>
          </button>

          {/* ON/OFF 切り替え */}
          <button
            onClick={() => onUpdateTrackSettings({ enabled: !selectedTrack.enabled })}
            className={`p-1.5 rounded transition ${
              selectedTrack.enabled
                ? 'text-emerald-400 hover:bg-emerald-950/50'
                : 'text-slate-500 hover:bg-slate-800'
            }`}
            title={selectedTrack.enabled ? '無効にする' : '有効にする'}
          >
            {selectedTrack.enabled ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>

          {/* 削除 */}
          <button
            onClick={onDeleteSelectedTrack}
            className="p-1.5 text-rose-400 hover:text-rose-300 hover:bg-rose-950/50 rounded transition"
            title="このモザイクを削除"
          >
            <Trash2 size={15} />
          </button>
        </div>
      ) : (
        <div className="text-slate-500 text-[11px] hidden md:block">
          💡 画面上をドラッグして領域を指定するか、モザイク枠をタップして選択してください
        </div>
      )}
    </div>
  );
};
