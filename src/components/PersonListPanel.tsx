import React from 'react';
import { MosaicTrack } from '../types';
import { Users, Eye, EyeOff, Shield, Trash2 } from 'lucide-react';

interface PersonListPanelProps {
  tracks: MosaicTrack[];
  selectedTrackId: string | null;
  onSelectTrack: (id: string | null) => void;
  onToggleTrackEnabled: (id: string) => void;
  onToggleAllAITracks: (enable: boolean) => void;
  onDeleteTrack: (id: string) => void;
  onDeleteAllUserTracks?: () => void;
}

export const PersonListPanel: React.FC<PersonListPanelProps> = ({
  tracks,
  selectedTrackId,
  onSelectTrack,
  onToggleTrackEnabled,
  onToggleAllAITracks,
  onDeleteTrack,
  onDeleteAllUserTracks,
}) => {
  const aiTracks = tracks.filter((t) => t.type === 'ai');
  const userTracks = tracks.filter((t) => t.type !== 'ai');

  return (
    <div className="bg-slate-900 border-l border-slate-800 w-full flex-1 md:w-64 flex flex-col p-3 text-xs overflow-y-auto select-none min-h-[300px] md:min-h-0">
      {/* ユーザー指定領域（フリー囲み・矩形・ブラシ）セクション */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="font-bold text-slate-200 flex items-center gap-1.5">
            <Shield size={14} className="text-cyan-400" />
            <span>指定領域・囲み ({userTracks.length})</span>
          </div>

          {userTracks.length > 0 && onDeleteAllUserTracks && (
            <button
              onClick={onDeleteAllUserTracks}
              className="text-[10px] text-rose-400 hover:text-rose-300 hover:bg-rose-950/60 px-1.5 py-0.5 rounded border border-rose-800/60 transition"
              title="追加した指定領域をすべて削除"
            >
              全削除
            </button>
          )}
        </div>

        {userTracks.length === 0 ? (
          <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80 text-slate-500 text-[11px] text-center">
            画面上の人物やPC画面を囲むとリストに表示されます
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {userTracks.map((track) => {
              const isSelected = track.id === selectedTrackId;
              return (
                <div
                  key={track.id}
                  onClick={() => onSelectTrack(track.id)}
                  className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer transition ${
                    isSelected
                      ? 'bg-indigo-950/50 border-indigo-400 shadow-sm ring-1 ring-indigo-500/50'
                      : 'bg-slate-950/60 border-slate-800/80 hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate flex-1 min-w-0 pr-1">
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        track.enabled ? 'bg-indigo-400 shadow-sm' : 'bg-slate-600'
                      }`}
                    />
                    <span className="font-semibold text-slate-200 truncate">{track.name}</span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {/* ON/OFF切り替えボタン */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleTrackEnabled(track.id);
                      }}
                      className={`p-1 rounded transition ${
                        track.enabled
                          ? 'text-indigo-400 hover:bg-indigo-900/60'
                          : 'text-slate-500 hover:bg-slate-800'
                      }`}
                      title={track.enabled ? 'モザイクをOFFにする' : 'モザイクをONにする'}
                    >
                      {track.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>

                    {/* 削除ボタン */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteTrack(track.id);
                      }}
                      className="p-1 text-slate-400 hover:text-rose-400 hover:bg-rose-950/70 rounded transition"
                      title="この枠を削除"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* AI人物セクション */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 font-bold text-slate-200">
            <Users size={15} className="text-emerald-400" />
            <span>AI検出人物 ({aiTracks.length})</span>
          </div>

          {aiTracks.length > 0 && (
            <div className="flex items-center gap-1 text-[10px]">
              <button
                onClick={() => onToggleAllAITracks(true)}
                className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"
              >
                全ON
              </button>
              <button
                onClick={() => onToggleAllAITracks(false)}
                className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"
              >
                全OFF
              </button>
            </div>
          )}
        </div>

        {aiTracks.length === 0 ? (
          <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80 text-slate-500 text-[11px] text-center">
            上の「AI顔自動検出」を押すと動画内の人物を自動追従します
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {aiTracks.map((track) => {
              const isSelected = track.id === selectedTrackId;
              return (
                <div
                  key={track.id}
                  onClick={() => onSelectTrack(track.id)}
                  className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer transition ${
                    isSelected
                      ? 'bg-emerald-950/50 border-emerald-400 shadow-sm ring-1 ring-emerald-500/50'
                      : 'bg-slate-950/60 border-slate-800/80 hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate flex-1 min-w-0 pr-1">
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        track.enabled ? 'bg-emerald-400 shadow-sm' : 'bg-slate-600'
                      }`}
                    />
                    <span className="font-semibold text-slate-200 truncate">{track.name}</span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleTrackEnabled(track.id);
                      }}
                      className={`p-1 rounded transition ${
                        track.enabled
                          ? 'text-emerald-400 hover:bg-emerald-900/60'
                          : 'text-slate-500 hover:bg-slate-800'
                      }`}
                      title={track.enabled ? 'モザイクをOFFにする' : 'モザイクをONにする'}
                    >
                      {track.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteTrack(track.id);
                      }}
                      className="p-1 text-slate-400 hover:text-rose-400 hover:bg-rose-950/70 rounded transition"
                      title="このAI枠を削除"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="mt-1 text-[10px] text-slate-500 leading-tight">
              💡 手などに誤って枠が入った場合は、右のゴミ箱ボタンか画面上の「✕」で即座に削除できます
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
