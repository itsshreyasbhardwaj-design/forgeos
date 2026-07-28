import { AppShell } from '@/components/app-shell';
import { getActiveWorkspace, getRuntimeStatus } from '@/lib/server/context';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const workspace = await getActiveWorkspace();
  const runtime = await getRuntimeStatus();

  return (
    <AppShell
      workspaceName={workspace.name}
      runtime={{
        storage: runtime.storage,
        defaultModel: runtime.defaultModel,
        auth: runtime.auth,
      }}
    >
      {children}
    </AppShell>
  );
}
