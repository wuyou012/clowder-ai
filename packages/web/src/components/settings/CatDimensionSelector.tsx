'use client';

/**
 * F219 AC-10 — Per-cat dimension selector.
 * Shows a dropdown of available cats and highlights which segments
 * would be active for the selected cat based on breed and provider.
 */

import { useCatData } from '@/hooks/useCatData';
import { SettingsBadge, SettingsText } from './primitives';

interface CatDimensionSelectorProps {
  onSelect: (catId: string | null) => void;
  selected: string | null;
}

export function CatDimensionSelector({ onSelect, selected }: CatDimensionSelectorProps) {
  const { cats } = useCatData();
  const availableCats = cats.filter((c) => c.roster?.available !== false);

  if (availableCats.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <SettingsText as="span" variant="xs" tone="muted">
        视角：
      </SettingsText>
      <select
        value={selected ?? ''}
        onChange={(e) => onSelect(e.target.value || null)}
        className="rounded-md border bg-transparent px-2 py-1 text-xs"
        style={{ borderColor: 'var(--console-border)', color: 'var(--text-primary)' }}
      >
        <option value="">全部段（无过滤）</option>
        {availableCats.map((cat) => (
          <option key={cat.id} value={cat.id}>
            {cat.displayName}
            {cat.breedId ? ` (${cat.breedId})` : ''}
            {cat.provider ? ` · ${cat.provider}` : ''}
          </option>
        ))}
      </select>
      {selected && (
        <SettingsBadge tone="blue" size="xxs">
          已过滤
        </SettingsBadge>
      )}
    </div>
  );
}

/**
 * Determine if a segment would be active for a given cat.
 * Uses heuristic matching based on trigger conditions in the manifest.
 */
export function isSegmentActiveForCat(
  trigger: string,
  catBreed: string | undefined,
  catProvider: string | undefined,
): boolean {
  const t = trigger.toLowerCase();

  // Always-on segments
  if (t === 'always' || t === 'session start' || t === 'session stop') return true;

  // MCP segments: Claude-only
  if (t.includes('mcpavailable') || t.includes('mcp')) {
    return catProvider === 'anthropic' || catProvider === 'claude';
  }

  // Breed-specific workflow triggers
  if (t.includes('workflow_triggers') || t.includes('breedid')) {
    // Active for all breeds that have triggers defined
    return true;
  }

  // A2A segments: active when not parallel
  if (t.includes('a2aenabled') || t.includes("mode !== 'parallel'")) {
    return true; // A2A is typically enabled
  }

  // Default: assume active
  return true;
}
