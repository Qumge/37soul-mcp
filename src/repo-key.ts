/**
 * repo_key：把一个 git remote（或没有 git 时的 cwd）归一成**跨机器稳定**的
 * 工作区标识。服务端（37soul 的 app/services/repo_key.rb）和 agentd 共用同一组
 * 规则与用例：test/fixtures/repo_keys.json（与 37soul 仓库里的那份逐字节一致）。
 *
 *   git@github.com:Owner/Repo.git  ->  github.com/owner/repo
 *   https://github.com/Owner/Repo   ->  github.com/owner/repo
 *   ssh://git@host:22/a/b.git       ->  host/a/b
 *
 * 没有可用的共享 remote 时回退到 `path:<machine_id>:<绝对路径>` —— 同一台机器
 * 的同一个目录是同一个工作区，不同机器哪怕路径一模一样也绝不混同。猜一个错的
 * 共享身份比不共享更糟（会把两台机器的工作接在一起）。
 */

const SCP_LIKE = /^(?:([^@/\s]+)@)?([^:/\s]+):(.+)$/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function normalizeRemote(remote: string | null | undefined): string | null {
  const raw = (remote ?? "").trim();
  if (raw === "" || /\s/.test(raw) || WINDOWS_DRIVE.test(raw)) return null;

  if (URI_SCHEME.test(raw)) {
    try {
      const url = new URL(raw);
      const host = url.hostname;
      const path = url.pathname;
      if (!host || !path) return null;
      return normalizeHostPath(host, path);
    } catch {
      return null;
    }
  }

  const scp = SCP_LIKE.exec(raw);
  if (scp) return normalizeHostPath(scp[2], scp[3]);
  return null;
}

export function pathRepoKey(machineId: string | null | undefined, cwd: string | null | undefined): string | null {
  const machine = (machineId ?? "").trim();
  let directory = (cwd ?? "").trim();
  if (machine === "" || directory === "") return null;
  if (!directory.startsWith("/")) return null;

  directory = directory.replace(/\/+$/, "");
  if (directory === "") directory = "/";
  return `path:${machine}:${directory}`;
}

/** 与 Rails 的 RepoKey.call 同语义：remote 优先，否则 path 回退。 */
export function repoKey(input: {
  remote?: string | null;
  machineId?: string | null;
  cwd?: string | null;
}): string | null {
  return normalizeRemote(input.remote) ?? pathRepoKey(input.machineId, input.cwd);
}

function normalizeHostPath(host: string, path: string): string | null {
  const normalizedHost = (host ?? "").trim().toLowerCase();
  let p = (path ?? "").trim();
  if (normalizedHost === "" || p === "") return null;
  if (/[\s\\]/.test(p) || p.includes(":")) return null;

  p = p.replace(/^\/+/, "").replace(/\/+$/, "");
  p = p.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (p === "") return null;
  return `${normalizedHost}/${p.toLowerCase()}`;
}
