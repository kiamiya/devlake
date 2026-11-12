import { SettingsPage } from '../components/SettingsPage.js';
import { StatusBar } from '../components/StatusBar.js';
import { HOME } from '../features/tabs/model.js';
import { useTabsPersistence } from '../features/tabs/persistence.js';
import { useTabShortcuts } from '../features/tabs/shortcuts.js';
import { tabsStore, useTabs } from '../features/tabs/store.js';
import { TabBar } from '../features/tabs/TabBar.js';
import { useProjects, useTabsSync } from '../hooks/projects.js';
import { useQuestionsSync } from '../hooks/questions.js';
import { UpdateBanner } from '../features/update/UpdateBanner.js';
import { HomeView } from './HomeView.js';
import { ProjectView } from './ProjectView.js';

export function App() {
  useTabsPersistence(tabsStore);
  useTabShortcuts(tabsStore);
  const tabs = useTabs((s) => s.tabs);
  const active = useTabs((s) => s.active);
  const settingsOpen = useTabs((s) => s.settingsOpen);
  const projects = useProjects().data ?? [];
  useTabsSync(tabs);
  // Questions de tous les projets, onglet ouvert ou non : notifications et badges.
  useQuestionsSync();

  return (
    <div className="flex h-full flex-col">
      <UpdateBanner />
      <TabBar projects={projects} />
      <main className="flex-1 overflow-auto">
        {settingsOpen ? (
          <SettingsPage />
        ) : active === HOME ? (
          <HomeView projects={projects} />
        ) : (
          <ProjectView key={active} projectId={active} />
        )}
      </main>
      <StatusBar />
    </div>
  );
}
