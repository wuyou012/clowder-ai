'use client';

/**
 * F219 Checkpoints A+C+D — Injection manifest viewer + overlay editor + hook panel.
 * Fetches manifest from GET /api/prompt-injection/manifest and displays
 * all segments grouped by category with safety tier badges.
 * Template-backed segments support inline editing (Checkpoint C).
 * Hook category shows dedicated management panel (Checkpoint D).
 */

import { useEffect, useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { CatDimensionSelector, isSegmentActiveForCat } from './CatDimensionSelector';
import { HookManagementPanel } from './HookManagementPanel';
import { SettingsBadge, SettingsCollapsibleCard, SettingsSection, SettingsText } from './primitives';
import { SegmentEditor } from './SegmentEditor';

// ── Types ──────────────────────────────────────────────────────

interface ManifestSegment {
  id: string;
  name: string;
  category: string;
  lifecycleStage: string;
  source: string;
  sourceType: string;
  trigger: string;
  purpose: string;
  userExplanation: string;
  priority: string;
  safetyTier: string;
  transparencyTier: string;
  governanceTier: string;
  allowLocalOverride: boolean;
  disableable: boolean;
  consumer: string;
  relatedFeature: string | null;
  _knownIssue?: string;
  _status?: string;
}

interface ManifestResponse {
  schemaVersion: string;
  segments: ManifestSegment[];
  totalActive: number;
  totalLegacy: number;
}

// ── Constants ──────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  'l0-native': 'L0 Native',
  identity: '身份 Identity',
  collaboration: '协作 Collaboration',
  'feature-injection': '功能注入 Feature',
  hook: 'Hook',
  route: '路由 Route',
  invocation: '调用 Invocation',
  session: '会话 Session',
  'mcp-fallback': 'MCP Fallback',
  navigation: '导航 Navigation',
};

const CATEGORY_ORDER = [
  'l0-native',
  'identity',
  'collaboration',
  'feature-injection',
  'route',
  'invocation',
  'session',
  'mcp-fallback',
  'navigation',
  'hook',
];

type SafetyTone = 'red' | 'amber' | 'emerald';
const SAFETY_TIER_BADGE: Record<string, { label: string; tone: SafetyTone }> = {
  readonly: { label: '只读', tone: 'red' },
  'limited-edit': { label: '受限编辑', tone: 'amber' },
  editable: { label: '可编辑', tone: 'emerald' },
};

type GovernanceTone = 'red' | 'amber' | 'blue';
const GOVERNANCE_TIER_BADGE: Record<string, { label: string; tone: GovernanceTone }> = {
  immutable: { label: '不可变', tone: 'red' },
  'human-gated': { label: '人工审批', tone: 'amber' },
  'auto-evolve': { label: '自动迭代', tone: 'blue' },
};

// ── Component ──────────────────────────────────────────────────

export function InjectionManifestContent() {
  const [data, setData] = useState<ManifestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);
  const { cats } = useCatData();
  const selectedCat = cats.find((c) => c.id === selectedCatId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/prompt-injection/manifest');
        if (cancelled) return;
        if (!res.ok) {
          setError('注入段清单加载失败');
          return;
        }
        setData((await res.json()) as ManifestResponse);
      } catch {
        if (!cancelled) setError('网络错误');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, ManifestSegment[]>();
    for (const seg of data.segments) {
      if (seg._status?.startsWith('legacy')) continue;
      const cat = seg.category;
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(seg);
    }
    return CATEGORY_ORDER.filter((cat) => map.has(cat)).map((cat) => ({
      category: cat,
      label: CATEGORY_LABELS[cat] ?? cat,
      segments: map.get(cat)!,
    }));
  }, [data]);

  if (error) {
    return (
      <SettingsText as="p" variant="sm" tone="red">
        {error}
      </SettingsText>
    );
  }
  if (!data) {
    return (
      <SettingsText as="p" variant="sm" tone="muted">
        加载中...
      </SettingsText>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <SettingsSection
        title="注入段全景"
        description="猫的 effective prompt 中所有非用户消息的注入内容。每段有安全分级和治理分级。"
        badge={
          <SettingsBadge tone="slate">
            {data.totalActive} 活跃 · {data.totalLegacy} 遗留
          </SettingsBadge>
        }
      >
        <TierLegend />
        <CatDimensionSelector selected={selectedCatId} onSelect={setSelectedCatId} />
      </SettingsSection>

      {/* Per-category collapsible groups */}
      {grouped.map((group) =>
        group.category === 'hook' ? (
          <HookCategoryGroup key="hook" label={group.label} count={group.segments.length} />
        ) : (
          <CategoryGroup
            key={group.category}
            label={group.label}
            segments={group.segments}
            catBreed={selectedCat?.breedId}
            catProvider={selectedCat?.provider}
          />
        ),
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────

function TierLegend() {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', padding: '0.75rem 0' }}
    >
      <div>
        <SettingsText as="p" variant="xs" tone="muted" className="mb-1">
          安全分级 (safetyTier)
        </SettingsText>
        <div className="flex flex-wrap gap-2">
          {Object.entries(SAFETY_TIER_BADGE).map(([key, val]) => (
            <SettingsBadge key={key} tone={val.tone} size="xxs">
              {val.label}
            </SettingsBadge>
          ))}
        </div>
      </div>
      <div>
        <SettingsText as="p" variant="xs" tone="muted" className="mb-1">
          治理分级 (governanceTier)
        </SettingsText>
        <div className="flex flex-wrap gap-2">
          {Object.entries(GOVERNANCE_TIER_BADGE).map(([key, val]) => (
            <SettingsBadge key={key} tone={val.tone} size="xxs">
              {val.label}
            </SettingsBadge>
          ))}
        </div>
      </div>
    </div>
  );
}

function HookCategoryGroup({ label, count }: { label: string; count: number }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <SettingsCollapsibleCard title={label} count={count} collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)}>
      <HookManagementPanel />
    </SettingsCollapsibleCard>
  );
}

function CategoryGroup({
  label,
  segments,
  catBreed,
  catProvider,
}: {
  label: string;
  segments: ManifestSegment[];
  catBreed?: string;
  catProvider?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <SettingsCollapsibleCard
      title={label}
      count={segments.length}
      collapsed={collapsed}
      onToggle={() => setCollapsed((c) => !c)}
    >
      <div className="space-y-2">
        {segments.map((seg) => (
          <SegmentRow key={seg.id} segment={seg} catBreed={catBreed} catProvider={catProvider} />
        ))}
      </div>
    </SettingsCollapsibleCard>
  );
}

function SegmentRow({
  segment: s,
  catBreed,
  catProvider,
}: {
  segment: ManifestSegment;
  catBreed?: string;
  catProvider?: string;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const safety = SAFETY_TIER_BADGE[s.safetyTier];
  const governance = GOVERNANCE_TIER_BADGE[s.governanceTier];
  const isTemplate = s.sourceType === 'template';
  const isActive = !catBreed || isSegmentActiveForCat(s.trigger, catBreed, catProvider);

  return (
    <div>
      <div
        className="flex items-start gap-3 rounded-lg px-3 py-2 transition-opacity"
        style={{ backgroundColor: 'var(--console-panel-bg)', opacity: isActive ? 1 : 0.4 }}
      >
        {/* ID badge */}
        <SettingsText as="span" variant="xs" tone="muted" className="mt-0.5 w-8 shrink-0 font-mono">
          {s.id}
        </SettingsText>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SettingsText as="span" variant="sm" tone="default" className="font-medium">
              {s.name}
            </SettingsText>
            {safety && (
              <SettingsBadge tone={safety.tone} size="xxs">
                {safety.label}
              </SettingsBadge>
            )}
            {governance && (
              <SettingsBadge tone={governance.tone} size="xxs">
                {governance.label}
              </SettingsBadge>
            )}
            {s._knownIssue && (
              <SettingsBadge tone="amber" size="xxs">
                已知问题
              </SettingsBadge>
            )}
            {isTemplate && (
              <button
                type="button"
                className="ml-auto text-xs opacity-50 hover:opacity-100"
                onClick={() => setEditorOpen(!editorOpen)}
              >
                {editorOpen ? '收起' : s.allowLocalOverride ? '编辑' : '查看'}
              </button>
            )}
          </div>
          <SettingsText as="p" variant="xs" tone="secondary" className="mt-0.5">
            {s.userExplanation}
          </SettingsText>
          <div className="mt-1 flex flex-wrap gap-3">
            <SettingsText as="span" variant="xs" tone="muted">
              {s.lifecycleStage}
            </SettingsText>
            <SettingsText as="span" variant="xs" tone="muted">
              {s.sourceType}
            </SettingsText>
            {s.relatedFeature && (
              <SettingsText as="span" variant="xs" tone="muted">
                {s.relatedFeature}
              </SettingsText>
            )}
          </div>
        </div>
      </div>
      {editorOpen && (
        <div className="mt-2 pl-11">
          <SegmentEditor
            segmentId={s.id}
            segmentName={s.name}
            allowLocalOverride={s.allowLocalOverride}
            onClose={() => setEditorOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
