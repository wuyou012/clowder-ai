'use client';

/**
 * F219 Checkpoint D + AC-9 — Hook management panel.
 * Displays hook segments (H1/H2/H3) with health status, per-hook
 * enable/disable toggle, dry-run output, and one-click sync.
 */

import { useCallback, useState } from 'react';
import type { AgentHookTargetHealth } from '@/hooks/useAgentHookHealth';
import { useAgentHookHealth } from '@/hooks/useAgentHookHealth';
import { apiFetch } from '@/utils/api-client';
import { SettingsBadge, SettingsSecondaryButton, SettingsText } from './primitives';

// ── Types & constants ─────────────────────────────────────────

interface HookSegment {
  id: string;
  name: string;
  source: string;
  trigger: string;
  userExplanation: string;
  toggleable: boolean; // H1/H3 via claude settings; H2 not yet
}

const HOOK_SEGMENTS: HookSegment[] = [
  {
    id: 'H1',
    name: 'Startup Hook 输出',
    source: '.claude/hooks/user-level/session-start-recall.sh',
    trigger: 'Session start',
    userExplanation: '开工自检——检查未提交的文档、未 push 的 commit、根目录杂物等，生成诊断通知',
    toggleable: true,
  },
  {
    id: 'H2',
    name: 'PostCompact 注入',
    source: '.claude/hooks/user-level/',
    trigger: 'PostCompact event',
    userExplanation: '上下文压缩后重新注入会话摘要和 SOP 书签，防止压缩导致关键信息丢失',
    toggleable: false,
  },
  {
    id: 'H3',
    name: 'Stop Hook 输出',
    source: '.claude/hooks/user-level/session-stop-check.sh',
    trigger: 'Session stop',
    userExplanation: '退出自检——验证 commit 和文档状态，仅用于退出治理通知',
    toggleable: true,
  },
];

/** Maps hookId → settings.json event name for per-hook enabled state */
const HOOK_EVENT_MAP: Record<string, string> = { H1: 'SessionStart', H3: 'Stop' };

function matchTargetToHook(target: AgentHookTargetHealth): string | null {
  const n = target.name.toLowerCase();
  if (n.includes('session-start') || n.includes('start')) return 'H1';
  if (n.includes('session-stop') || n.includes('stop')) return 'H3';
  return null;
}

type StatusTone = 'emerald' | 'amber' | 'red' | 'slate';
function statusTone(status: string): StatusTone {
  if (status === 'configured') return 'emerald';
  if (status === 'missing' || status === 'stale') return 'amber';
  if (status === 'error') return 'red';
  return 'slate';
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    configured: '已启用',
    missing: '已禁用',
    stale: '过期',
    unsupported: '未启用',
    error: '异常',
  };
  return labels[status] ?? '未知';
}

// ── Component ─────────────────────────────────────────────────

export function HookManagementPanel() {
  const { health, loading, syncing, synced, error, sync, refresh } = useAgentHookHealth({ enabled: true });
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  const [dryRunOutput, setDryRunOutput] = useState<Record<string, string>>({});
  const [dryRunning, setDryRunning] = useState<Record<string, boolean>>({});

  const hookHealth = new Map<string, AgentHookTargetHealth>();
  if (health?.targets) {
    for (const t of health.targets) {
      const hid = matchTargetToHook(t);
      if (hid) hookHealth.set(hid, t);
    }
  }

  const toggleHook = useCallback(
    async (hookId: string, enabled: boolean) => {
      setToggling((prev) => ({ ...prev, [hookId]: true }));
      try {
        await apiFetch('/api/agent-hooks/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hookId, enabled }),
        });
        await refresh();
      } finally {
        setToggling((prev) => ({ ...prev, [hookId]: false }));
      }
    },
    [refresh],
  );

  const dryRunHook = useCallback(async (hookId: string) => {
    setDryRunning((prev) => ({ ...prev, [hookId]: true }));
    setDryRunOutput((prev) => ({ ...prev, [hookId]: '' }));
    try {
      const res = await apiFetch('/api/agent-hooks/dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hookId }),
      });
      const data = (await res.json()) as { output?: string };
      setDryRunOutput((prev) => ({ ...prev, [hookId]: data.output ?? '(无输出)' }));
    } catch {
      setDryRunOutput((prev) => ({ ...prev, [hookId]: '(请求失败)' }));
    } finally {
      setDryRunning((prev) => ({ ...prev, [hookId]: false }));
    }
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SettingsText as="span" variant="sm" tone="default" className="font-medium">
            Hook 管理
          </SettingsText>
          {health && (
            <SettingsBadge tone={statusTone(health.status)} size="xxs">
              {statusLabel(health.status)}
            </SettingsBadge>
          )}
          {loading && (
            <SettingsText as="span" variant="xs" tone="muted">
              检查中...
            </SettingsText>
          )}
        </div>
        <div className="flex items-center gap-2">
          {synced && (
            <SettingsText as="span" variant="xs" tone="emerald">
              已同步
            </SettingsText>
          )}
          <SettingsSecondaryButton onClick={sync} disabled={syncing}>
            {syncing ? '同步中...' : '一键同步'}
          </SettingsSecondaryButton>
        </div>
      </div>

      {error && (
        <SettingsText as="p" variant="xs" tone="red">
          {error}
        </SettingsText>
      )}

      <div className="space-y-2">
        {HOOK_SEGMENTS.map((hook) => {
          const target = hookHealth.get(hook.id);
          // Use per-event enabled state from settings.json (not file sync target status)
          const hookEventKey = HOOK_EVENT_MAP[hook.id];
          const isConfigured = hookEventKey ? (health?.hookEvents?.[hookEventKey] ?? false) : false;
          return (
            <HookRow
              key={hook.id}
              hook={hook}
              target={target}
              isConfigured={isConfigured}
              toggling={!!toggling[hook.id]}
              onToggle={(enabled) => toggleHook(hook.id, enabled)}
              dryRunning={!!dryRunning[hook.id]}
              dryRunOutput={dryRunOutput[hook.id]}
              onDryRun={() => dryRunHook(hook.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Sub-component ─────────────────────────────────────────────

function HookRow({
  hook,
  target,
  isConfigured,
  toggling,
  onToggle,
  dryRunning,
  dryRunOutput,
  onDryRun,
}: {
  hook: HookSegment;
  target: AgentHookTargetHealth | undefined;
  isConfigured: boolean;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
  dryRunning: boolean;
  dryRunOutput: string | undefined;
  onDryRun: () => void;
}) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--console-panel-bg)' }}>
      <div className="flex items-start gap-3">
        <SettingsText as="span" variant="xs" tone="muted" className="mt-0.5 w-8 shrink-0 font-mono">
          {hook.id}
        </SettingsText>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SettingsText as="span" variant="sm" tone="default" className="font-medium">
              {hook.name}
            </SettingsText>
            {target && (
              <SettingsBadge tone={statusTone(target.status)} size="xxs">
                {statusLabel(target.status)}
              </SettingsBadge>
            )}
            {hook.toggleable && (
              <button
                type="button"
                className="ml-auto rounded px-2 py-0.5 text-xs transition-colors"
                style={{
                  backgroundColor: isConfigured
                    ? 'var(--status-error-bg, #fee2e2)'
                    : 'var(--status-success-bg, #dcfce7)',
                  color: isConfigured ? 'var(--status-error, #dc2626)' : 'var(--status-success, #16a34a)',
                }}
                disabled={toggling}
                onClick={() => onToggle(!isConfigured)}
              >
                {toggling ? '...' : isConfigured ? '禁用' : '启用'}
              </button>
            )}
            {!hook.toggleable && (
              <SettingsText as="span" variant="xs" tone="muted" className="ml-auto">
                代码级（暂不支持切换）
              </SettingsText>
            )}
          </div>
          <SettingsText as="p" variant="xs" tone="secondary" className="mt-0.5">
            {hook.userExplanation}
          </SettingsText>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <SettingsText as="span" variant="xs" tone="muted">
              触发：{hook.trigger}
            </SettingsText>
            <SettingsText as="span" variant="xs" tone="muted">
              {hook.source}
            </SettingsText>
            {target?.drifted && (
              <SettingsText as="span" variant="xs" tone="amber">
                配置漂移
              </SettingsText>
            )}
            {hook.toggleable && (
              <button
                type="button"
                className="text-xs opacity-50 hover:opacity-100"
                disabled={dryRunning}
                onClick={onDryRun}
              >
                {dryRunning ? '运行中...' : '试运行'}
              </button>
            )}
          </div>
          {target?.diff?.message && (
            <SettingsText as="p" variant="xs" tone="muted" className="mt-1 font-mono">
              {target.diff.message}
            </SettingsText>
          )}
        </div>
      </div>
      {dryRunOutput && (
        <pre
          className="mt-2 ml-11 max-h-40 overflow-auto rounded p-2 text-xs whitespace-pre-wrap"
          style={{ backgroundColor: 'var(--console-bg, #1a1a1a)', color: 'var(--text-secondary)' }}
        >
          {dryRunOutput}
        </pre>
      )}
    </div>
  );
}
