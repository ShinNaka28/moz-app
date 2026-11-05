import React from 'react';
import { ShieldCheck, Video, Image as ImageIcon, Sparkles, Download, PlayCircle } from 'lucide-react';

interface HeaderProps {
  onOpenFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onLoadDemo: () => void;
  onExport: () => void;
  hasMedia: boolean;
  isProcessing: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenFile,
  onLoadDemo,
  onExport,
  hasMedia,
  isProcessing,
}) => {
  return (
    <header className="bg-slate-900 border-b border-slate-800 px-3 py-2 sm:px-4 sm:py-2.5 flex flex-wrap items-center justify-between gap-2 shadow-md">
      {/* タイトル＆完全ローカルセキュリティバッジ */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-cyan-400 flex items-center justify-center font-black text-white text-base shadow">
            M
          </div>
          <div>
            <h1 className="text-sm sm:text-base font-bold text-slate-100 flex items-center gap-1.5">
              ローカルAIモザイクエディター
            </h1>
            <p className="text-[10px] text-slate-400 hidden sm:block">
              AI顔追跡 & 任意領域オプティカルフロー追従
            </p>
          </div>
        </div>

        {/* 🔒 厳格セキュリティバッジ */}
        <div className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 rounded-full text-[11px] font-medium shadow-sm">
          <ShieldCheck size={14} className="text-emerald-400" />
          <span>🔒 完全ローカル処理｜外部通信遮断済み（機内モード動作可）</span>
        </div>
      </div>

      {/* ファイル操作ボタン群 */}
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 cursor-pointer transition shadow-sm">
          <Video size={14} />
          <span>動画/画像を開く</span>
          <input
            type="file"
            accept="video/*,image/*"
            onChange={onOpenFile}
            className="hidden"
          />
        </label>

        <button
          onClick={onLoadDemo}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-950/70 hover:bg-indigo-900/80 border border-indigo-700/60 text-indigo-300 text-xs font-semibold rounded-lg transition shadow-sm"
          title="動く人物とPC画面を含むテスト動画を即座に生成"
        >
          <Sparkles size={14} className="text-indigo-400" />
          <span className="hidden sm:inline">デモ動画を生成</span>
          <span className="sm:hidden">デモ</span>
        </button>

        <button
          onClick={onExport}
          disabled={!hasMedia || isProcessing}
          className="flex items-center gap-1.5 px-3.5 py-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold rounded-lg transition shadow-md"
          title="完成動画をローカル生成し、プレビュー確認後にダウンロードします"
        >
          <PlayCircle size={15} />
          <span>プレビュー＆保存</span>
        </button>
      </div>
    </header>
  );
};

