'use client';

/**
 * F219 Checkpoint D — Hook management panel.
 * Displays hook segments (H1/H2/H3) with health status from the
 * agent-hooks API, and provides one-click sync + known issue notes.
 */

import type { AgentHookTargetHealth } from '@/hooks/useAgentHookHealth';
import { useAgentHookHealth } from '@/hooks/useAgentHookHealth';
import { SettingsBadge, SettingsSecondaryButton, SettingsText } from './primitives';

interface HookSegment {
  id: string;
  name: string;
  source: string;
  trigger: string;
  userExplanation: string;
  disableable: boolean;
  knownIssue?: string;
}

const HOOK_SEGMENTS: HookSegment[] = [
  {
    id: 'H1',
    name: 'Startup Hook 输出',
    source: '.claude/hooks/user-level/session-start-recall.sh',
    trigger: 'Session start',
    userExplanation: '开工自检——检查未提交的文档、未 push 的 commit、根目录杂物等，生成诊断通知',
    disableable: true,
    knownIssue: '包含"向铲屎官汇报"语言，抢夺对话方向，应降级为纯诊断通知',
  },
  {
    id: 'H2',
    name: 'PostCompact 注入',
    source: '.claude/hooks/user-level/',
    trigger: 'PostCompact event',
    userExplanation: '上下文压缩后重新注入会话摘要和 SOP 书签，防止压缩导致关键信息丢失',
    disableable: true,
  },
  {
    id: 'H3',
    name: 'Stop Hook 输出',
    source: '.claude/hooks/user-level/session-stop-check.sh',
    trigger: 'Session stop',
    userExplanation: '退出自检——验证 commit 和文档状态，仅用于退出治理通知',
    disableable: true,
    knownIssue: '包含"向铲屎官汇报/商量处理方式"语言，应降级为纯诊断通知',
  },
];

/** Map agent-hook target names to hook segment IDs */
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
    configured: '正常',
    missing: '缺失',
    stale: '过期',
    unsupported: '未启用',
    error: '异常',
  };
  return labels[status] ?? '未知';
}

export function HookManagementPanel() {
  const { health, loading, syncing, synced, error, sync } = useAgentHookHealth({ enabled: true });

  // Build a map from hook ID to its target health
  const hookHealth = new Map<string, AgentHookTargetHealth>();
  if (health?.targets) {
    for (const t of health.targets) {
      const hid = matchTargetToHook(t);
      if (hid) hookHealth.set(hid, t);
    }
  }

  return (
    <div className="space-y-4">
      {/* Overall status + sync */}
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

      {/* Hook segments */}
      <div className="space-y-2">
        {HOOK_SEGMENTS.map((hook) => {
          const target = hookHealth.get(hook.id);
          return (
            <div
              key={hook.id}
              className="flex items-start gap-3 rounded-lg px-3 py-2"
              style={{ backgroundColor: 'var(--console-panel-bg)' }}
            >
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
                  {hook.knownIssue && (
                    <SettingsBadge tone="amber" size="xxs">
                      已知问题
                    </SettingsBadge>
                  )}
                </div>
                <SettingsText as="p" variant="xs" tone="secondary" className="mt-0.5">
                  {hook.userExplanation}
                </SettingsText>
                {hook.knownIssue && (
                  <SettingsText as="p" variant="xs" tone="amber" className="mt-1">
                    {hook.knownIssue}
                  </SettingsText>
                )}
                <div className="mt-1 flex flex-wrap gap-3">
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
                </div>
                {target?.diff?.message && (
                  <SettingsText as="p" variant="xs" tone="muted" className="mt-1 font-mono">
                    {target.diff.message}
                  </SettingsText>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
