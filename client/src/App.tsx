import React, { useState, useEffect } from 'react';
import { HostRoute } from './routes/HostRoute';
import { PlayRoute } from './routes/PlayRoute';
import { ScreenRoute } from './routes/ScreenRoute';
import { Monitor, Smartphone, Laptop, Sparkles } from 'lucide-react';

export const App: React.FC = () => {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onLocationChange = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onLocationChange);
    return () => window.removeEventListener('popstate', onLocationChange);
  }, []);

  const navigate = (newPath: string) => {
    window.history.pushState({}, '', newPath);
    setPath(newPath);
  };

  if (path.startsWith('/host')) {
    return <HostRoute />;
  }

  if (path.startsWith('/play')) {
    return <PlayRoute />;
  }

  if (path.startsWith('/screen')) {
    return <ScreenRoute />;
  }

  // Root Hub Landing Page
  return (
    <div className="min-h-screen bg-[#EFF2EE] text-[#14181A] flex flex-col items-center justify-center p-6 font-sans">
      <div className="max-w-xl w-full bg-white border border-[#D2DACF] rounded-3xl p-8 shadow-sm text-center">
        <div className="inline-flex p-3 rounded-2xl bg-[#D9EDE5] text-[#1B7A5A] mb-4">
          <Sparkles size={28} />
        </div>

        <h1 className="text-3xl font-extrabold tracking-tight mb-2">Trivia Night App</h1>
        <p className="text-sm text-[#5C6B64] mb-8">
          The digital whiteboard trivia system with finger-written ink and live big-screen judging.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <button
            onClick={() => navigate('/host')}
            className="p-5 rounded-2xl border border-[#D2DACF] hover:border-[#1B7A5A] hover:bg-[#D9EDE5]/20 flex flex-col items-center text-center transition-all group"
          >
            <div className="w-12 h-12 rounded-xl bg-[#EFF2EE] group-hover:bg-[#1B7A5A] group-hover:text-white flex items-center justify-center mb-3 transition-colors">
              <Laptop size={22} />
            </div>
            <div className="font-bold text-sm mb-1">Host Console</div>
            <div className="text-xs text-[#5C6B64]">Run events & mark answers live</div>
          </button>

          <button
            onClick={() => navigate('/play')}
            className="p-5 rounded-2xl border border-[#D2DACF] hover:border-[#1B7A5A] hover:bg-[#D9EDE5]/20 flex flex-col items-center text-center transition-all group"
          >
            <div className="w-12 h-12 rounded-xl bg-[#EFF2EE] group-hover:bg-[#1B7A5A] group-hover:text-white flex items-center justify-center mb-3 transition-colors">
              <Smartphone size={22} />
            </div>
            <div className="font-bold text-sm mb-1">Team App</div>
            <div className="text-xs text-[#5C6B64]">Join & write answers on your phone</div>
          </button>

          <button
            onClick={() => navigate('/screen')}
            className="p-5 rounded-2xl border border-[#D2DACF] hover:border-[#1B7A5A] hover:bg-[#D9EDE5]/20 flex flex-col items-center text-center transition-all group"
          >
            <div className="w-12 h-12 rounded-xl bg-[#EFF2EE] group-hover:bg-[#1B7A5A] group-hover:text-white flex items-center justify-center mb-3 transition-colors">
              <Monitor size={22} />
            </div>
            <div className="font-bold text-sm mb-1">Big Screen</div>
            <div className="text-xs text-[#5C6B64]">Projector answer board & scores</div>
          </button>
        </div>
      </div>
    </div>
  );
};
