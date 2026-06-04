'use client';

/**
 * F219 Checkpoint C — Segment overlay editor.
 * Edits template-backed segments via .local overlay files.
 * Supports compile preview, save, and reset to default.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsBadge, SettingsPrimaryButton, SettingsSecondaryButton, SettingsText } from './primitives';

interface SegmentEditorProps {
  segmentId: string;
  segmentName: string;
  allowLocalOverride: boolean;
  onClose: () => void;
}

interface ContentResponse {
  segmentId: string;
  allowLocalOverride: boolean;
  hasOverride: boolean;
  content: string;
  baseContent: string;
  vars: string[];
}

export function SegmentEditor({ segmentId, segmentName, allowLocalOverride, onClose }: SegmentEditorProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<ContentResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const fetchContent = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/prompt-injection/segment/${segmentId}/content`);
      if (!res.ok) {
        setError('加载失败');
        return;
      }
      const payload = (await res.json()) as ContentResponse;
      setData(payload);
      setDraft(payload.content);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, [segmentId]);

  useEffect(() => {
    fetchContent();
  }, [fetchContent]);

  const handlePreview = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch(`/api/prompt-injection/segment/${segmentId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft }),
      });
      const payload = (await res.json()) as { rendered?: string; error?: string };
      if (!res.ok) {
        setError(payload.error ?? '预览失败');
        return;
      }
      setPreview(payload.rendered ?? '');
    } catch {
      setError('预览请求失败');
    }
  }, [segmentId, draft]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaveMsg(null);
    try {
      const res = await apiFetch(`/api/prompt-injection/segment/${segmentId}/override`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft }),
      });
      const payload = (await res.json()) as { saved?: boolean; error?: string };
      if (!res.ok) {
        setError(payload.error ?? '保存失败');
        return;
      }
      setSaveMsg('已保存，下次会话生效');
      await fetchContent();
    } catch {
      setError('保存请求失败');
    } finally {
      setSaving(false);
    }
  }, [segmentId, draft, fetchContent]);

  const handleReset = useCallback(async () => {
    setError(null);
    setSaveMsg(null);
    try {
      const res = await apiFetch(`/api/prompt-injection/segment/${segmentId}/override`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError('重置失败');
        return;
      }
      setSaveMsg('已重置为默认');
      setPreview(null);
      await fetchContent();
    } catch {
      setError('重置请求失败');
    }
  }, [segmentId, fetchContent]);

  const isReadonly = !allowLocalOverride;
  const isDirty = data ? draft !== data.content : false;

  return (
    <div className="space-y-3 rounded-lg border p-4" style={{ borderColor: 'var(--console-border)' }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SettingsText as="span" variant="sm" tone="default" className="font-medium">
            {segmentId}: {segmentName}
          </SettingsText>
          {data?.hasOverride && (
            <SettingsBadge tone="blue" size="xxs">
              已自定义
            </SettingsBadge>
          )}
          {isReadonly && (
            <SettingsBadge tone="red" size="xxs">
              只读
            </SettingsBadge>
          )}
        </div>
        <button type="button" className="text-xs opacity-60 hover:opacity-100" onClick={onClose}>
          收起
        </button>
      </div>

      {loading && (
        <SettingsText as="p" variant="xs" tone="muted">
          加载中...
        </SettingsText>
      )}

      {error && (
        <SettingsText as="p" variant="xs" tone="red">
          {error}
        </SettingsText>
      )}
      {saveMsg && (
        <SettingsText as="p" variant="xs" tone="emerald">
          {saveMsg}
        </SettingsText>
      )}

      {data && (
        <>
          {/* Editor */}
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setPreview(null);
            }}
            disabled={isReadonly}
            rows={12}
            className="w-full rounded-md border bg-transparent p-3 font-mono text-xs leading-relaxed"
            style={{
              borderColor: 'var(--console-border)',
              color: isReadonly ? 'var(--text-muted)' : 'var(--text-primary)',
              opacity: isReadonly ? 0.7 : 1,
              resize: 'vertical',
            }}
          />

          {/* Variable hint */}
          {data.vars.length > 0 && (
            <SettingsText as="p" variant="xs" tone="muted">
              模板变量：{data.vars.map((v) => `{{${v}}}`).join('、')}（运行时自动替换）
            </SettingsText>
          )}

          {/* Preview */}
          {preview !== null && (
            <div className="rounded-md border p-3" style={{ borderColor: 'var(--console-border)' }}>
              <SettingsText as="p" variant="xs" tone="muted" className="mb-1">
                编译预览
              </SettingsText>
              <pre className="whitespace-pre-wrap font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                {preview}
              </pre>
            </div>
          )}

          {/* Actions */}
          {!isReadonly && (
            <div className="flex items-center gap-2">
              <SettingsSecondaryButton onClick={handlePreview} disabled={!isDirty && preview !== null}>
                预览
              </SettingsSecondaryButton>
              <SettingsPrimaryButton onClick={handleSave} disabled={!isDirty || saving}>
                {saving ? '保存中...' : '保存覆盖'}
              </SettingsPrimaryButton>
              {data.hasOverride && <SettingsSecondaryButton onClick={handleReset}>恢复默认</SettingsSecondaryButton>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
