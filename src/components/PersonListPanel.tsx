import React from 'react';
import { MosaicTrack } from '../types';
import { UserCheck, Eye, EyeOff, Users, Sliders, Shield } from 'lucide-react';

interface PersonListPanelProps {
  tracks: MosaicTrack[];
  selectedTrackId: string | null;
  onSelectTrack: (id: string | null) => void;
  onToggleTrackEnabled: (id: string) => void;
  onToggleAllAITracks: (enable: boolean) => void;
}

export const PersonListPanel: React.FC<PersonListPanelProps> = ({
  tracks,
  selectedTrackId,
  onSelectTrack,
  onToggleTrackEnabled,
  onToggleAllAITracks,
}) => {
  const aiTracks = tracks.filter((t) => t.type === 'ai');
  const userTracks = tracks.filter((t) => t.type !== 'ai');

  return (
    <div className="bg-slate-900 border-l border-slate-800 w-full md:w-64 flex flex-col p-3 text-xs overflow-y-auto max-h-48 md:max-h-full">
      {/* AI人物セクション */}
      <div className="mb-4">
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
                      ? 'bg-emerald-950/40 border-emerald-500/80'
                      : 'bg-slate-950/50 border-slate-800/80 hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <div
                      className={`w-2.5 h-2.5 rounded-full ${
                        track.enabled ? 'bg-emerald-400 shadow-sm' : 'bg-slate-600'
                      }`}
                    />
                    <span className="font-semibold text-slate-200 truncate">{track.name}</span>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleTrackEnabled(track.id);
                    }}
                    className={`p-1 rounded transition ${
                      track.enabled
                        ? 'text-emerald-400 hover:bg-emerald-900/50'
                        : 'text-slate-500 hover:bg-slate-800'
                    }`}
                    title={track.enabled ? 'モザイクをOFFにする' : 'モザイクをONにする'}
                  >
                    {track.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ユーザー指定領域セクション */}
      <div>
        <div className="font-bold text-slate-200 mb-2 flex items-center gap-1.5">
          <Shield size={14} className="text-cyan-400" />
          <span>指定追従領域 ({userTracks.length})</span>
        </div>

        {userTracks.length === 0 ? (
          <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80 text-slate-500 text-[11px] text-center">
            画面上のPC画面や書類を囲むと自動追従します
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
                      ? 'bg-indigo-950/40 border-indigo-500/80'
                      : 'bg-slate-950/50 border-slate-800/80 hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <div
                      className={`w-2.5 h-2.5 rounded-full ${
                        track.enabled ? 'bg-indigo-400 shadow-sm' : 'bg-slate-600'
                      }`}
                    />
                    <span className="font-semibold text-slate-200 truncate">{track.name}</span>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleTrackEnabled(track.id);
                    }}
                    className={`p-1 rounded transition ${
                      track.enabled
                        ? 'text-indigo-400 hover:bg-indigo-900/50'
                        : 'text-slate-500 hover:bg-slate-800'
                    }`}
                    title={track.enabled ? 'モザイクをOFFにする' : 'モザイクをONにする'}
                  >
                    {track.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

