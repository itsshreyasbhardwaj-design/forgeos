import { getContext } from '@/lib/server/context';
import { route } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = route(async ({ user, workspace }) => {
  const { store } = await getContext();
  const workspaces = await store.listWorkspacesForUser(user.id);

  return {
    items: await Promise.all(
      workspaces.map(async (entry) => {
        const [projects, members] = await Promise.all([
          store.listProjects(entry.id, { limit: 1 }),
          store.listMembers(entry.id),
        ]);
        return {
          id: entry.id,
          name: entry.name,
          slug: entry.slug,
          createdAt: entry.createdAt,
          members: members.length,
          hasProjects: projects.length > 0,
          active: entry.id === workspace.id,
        };
      })
    ),
    activeId: workspace.id,
  };
});
