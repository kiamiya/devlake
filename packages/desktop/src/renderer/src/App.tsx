import { SettingsPage } from './components/SettingsPage.js';
import { StatusBar } from './components/StatusBar.js';

/** Coque minimale ; les onglets de projets arrivent avec T04. */
export function App() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center border-b border-border px-4">
        <span className="font-semibold">AgentLake</span>
      </header>
      <main className="flex-1 overflow-auto">
        <SettingsPage />
      </main>
      <StatusBar />
    </div>
  );
}
