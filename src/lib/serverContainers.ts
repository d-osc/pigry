/** Server containers — Docker-like managed processes backed by the
 * `container_*` Tauri commands (repo store: `.orbit/containers.json`).
 * No-ops / empty in browser preview (no backend).
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauriClient';

export interface ServerContainer {
  id: string;
  name: string;
  command: string;
  cwd: string;
  env: string[];
  source: string;
  image: string;
  os: string;
  hostname: string;
  ports: string[];
  pid: number | null;
  /** running / exited / stopped */
  state: string;
  createdAt: number;
}

export async function containerList(repoPath: string): Promise<ServerContainer[]> {
  if (!isTauri() || !repoPath) return [];
  return invoke('container_list', { repoPath });
}

export async function containerCreate(
  repoPath: string,
  name: string,
  command: string,
  cwd = '',
  env: string[] = [],
  image = '',
  source = 'manual',
  os = '',
  hostname = '',
  password = '',
): Promise<ServerContainer> {
  if (!isTauri()) throw new Error('Server containers need the desktop app');
  return invoke('container_create', {
    repoPath,
    name,
    command,
    cwd,
    env,
    image,
    source,
    os,
    hostname,
    password,
  });
}

export async function containerStart(repoPath: string, id: string): Promise<ServerContainer> {
  if (!isTauri()) throw new Error('Server containers need the desktop app');
  return invoke('container_start', { repoPath, id });
}

export async function containerStop(repoPath: string, id: string): Promise<ServerContainer> {
  if (!isTauri()) throw new Error('Server containers need the desktop app');
  return invoke('container_stop', { repoPath, id });
}

export async function containerRemove(repoPath: string, id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('container_remove', { repoPath, id });
}

export async function containerLogs(repoPath: string, id: string): Promise<string> {
  if (!isTauri()) return '';
  return invoke('container_logs', { repoPath, id });
}

export interface ComposeService {
  name: string;
  /** The service's own command in string form ('' when image/build-only). */
  command: string;
  image: string;
  workingDir: string;
  env: string[];
  ports: string[];
  /** False when the service has no runnable local command. */
  localRunnable: boolean;
}

export async function composeServices(repoPath: string): Promise<ComposeService[]> {
  if (!isTauri() || !repoPath) return [];
  return invoke('compose_services', { repoPath });
}

/** Registers a compose service as a managed container (local process). */
export async function composeServiceRun(
  repoPath: string,
  service: ComposeService,
): Promise<ServerContainer> {
  if (!isTauri()) throw new Error('Server containers need the desktop app');
  return invoke('compose_service_run', {
    repoPath,
    name: service.name,
    command: service.command,
    workingDir: service.workingDir,
    env: service.env,
    ports: service.ports,
    image: service.image,
  });
}

/** Registers AND starts a compose service in one call. */
export async function composeServiceStart(
  repoPath: string,
  service: ComposeService,
): Promise<ServerContainer> {
  if (!isTauri()) throw new Error('Server containers need the desktop app');
  await invoke('compose_service_start', {
    repoPath,
    name: service.name,
    command: service.command,
    workingDir: service.workingDir,
    env: service.env,
    ports: service.ports,
    image: service.image,
  });
  const list = await invoke<ServerContainer[]>('container_list', { repoPath });
  return (
    list.find((c) => c.id === `ctr-${service.name}`) ??
    ({ id: `ctr-${service.name}`, name: service.name, state: 'running' } as ServerContainer)
  );
}
