'use client';
import { useEffect, useState } from 'react';
import ScheduleWidget from './ScheduleWidget';
import WatchesWidget from './WatchesWidget';
import PollsWidget from './PollsWidget';
import ProjectsWidget from './ProjectsWidget';
import QuickActions from './QuickActions';
import AskModal from './AskModal';
import AvailabilityModal from './AvailabilityModal';
import MealModal from './MealModal';
import InboxWidget from './InboxWidget';
import WeeklyAnalysisWidget from './WeeklyAnalysisWidget';
import TasksWidget from './TasksWidget';
import Top3Widget from './Top3Widget';

export default function Dashboard() {
  const [askOpen, setAskOpen] = useState(false);
  const [availOpen, setAvailOpen] = useState(false);
  const [mealOpen, setMealOpen] = useState(false);
  const [pollsBump, setPollsBump] = useState(0);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/secretary/sw.js', { scope: '/secretary/', updateViaCache: 'none' }).then((reg) => {
        // Force update check on load
        reg.update().catch(() => {});
        // Listen for update messages
        navigator.serviceWorker.addEventListener('message', (e) => {
          if (e.data?.type === 'sw-updated') {
            // Auto-reload to pick up the new HTML/JS
            window.location.reload();
          }
        });
      }).catch(() => {});
    }
  }, []);

  return (
    <div className="min-h-screen pb-32">
      <header className="sticky top-0 z-20 bg-zinc-950/80 backdrop-blur border-b border-zinc-900 px-4 py-3">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold">秘書 <span className="text-[9px] text-zinc-600 font-normal ml-1">v3-08-04</span></h1>
          <span className="text-xs text-zinc-500">{new Date().toLocaleDateString('ja-JP', { weekday: 'short', month: 'numeric', day: 'numeric' })}</span>
        </div>
      </header>

      <main className="px-3 py-4 space-y-4 max-w-screen-sm mx-auto">
        <WatchesWidget />
        <QuickActions
          onOpenAsk={() => setAskOpen(true)}
          onOpenAvail={() => setAvailOpen(true)}
          onOpenMeal={() => setMealOpen(true)}
        />
        <InboxWidget />
        <Top3Widget />
        <ScheduleWidget />
        <WeeklyAnalysisWidget />
        <TasksWidget />
        <PollsWidget bump={pollsBump} />
        <ProjectsWidget />
      </main>

      {askOpen && <AskModal onClose={() => setAskOpen(false)} onSent={() => { setAskOpen(false); setPollsBump(b => b + 1); }} />}
      {availOpen && <AvailabilityModal onClose={() => setAvailOpen(false)} />}
      {mealOpen && <MealModal onClose={() => setMealOpen(false)} />}
    </div>
  );
}
