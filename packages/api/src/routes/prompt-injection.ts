/**
 * Prompt Injection Template Overlay API (F219 Checkpoint C)
 *
 * Endpoints for reading, editing, previewing, and resetting
 * prompt injection template overlays (.local files).
 *
 * GET  /api/prompt-injection/segment/:id/content — current effective content
 * POST /api/prompt-injection/segment/:id/preview — compile preview with vars
 * PUT  /api/prompt-injection/segment/:id/override — save .local overlay
 * DELETE /api/prompt-injection/segment/:id/override — reset to default
 */

import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import YAML from 'yaml';
import {
  getOverrideStatus,
  getTemplateFileInfo,
  getTemplateRawContent,
  renderTemplate,
  stripComments,
  TEMPLATES_DIR,
} from '../domains/cats/services/context/prompt-template-loader.js';
import { RICH_BLOCK_SHORT } from '../domains/cats/services/context/rich-block-rules.js';
import { resolveUserId } from '../utils/request-identity.js';

// ── Segment metadata (allowLocalOverride from manifest) ──────

interface SegmentMeta {
  allowLocalOverride: boolean;
  ext: 'yaml' | 'md';
  vars: string[];
}

const EDITABLE_SEGMENTS: Record<string, SegmentMeta> = {
  S6: { allowLocalOverride: true, ext: 'yaml', vars: [] },
  S13: { allowLocalOverride: true, ext: 'md', vars: ['RICH_BLOCK_SHORT'] },
  D8: { allowLocalOverride: false, ext: 'md', vars: [] },
  D21: { allowLocalOverride: false, ext: 'md', vars: ['CC_MENTION'] },
};

/** Resolve runtime template variables for preview rendering */
function resolveVars(segmentId: string): Record<string, string> {
  const meta = EDITABLE_SEGMENTS[segmentId];
  if (!meta) return {};
  const vars: Record<string, string> = {};
  for (const v of meta.vars) {
    if (v === 'RICH_BLOCK_SHORT') vars[v] = RICH_BLOCK_SHORT;
    if (v === 'CC_MENTION') vars[v] = '@铲屎官'; // preview default
  }
  return vars;
}

// ── Route plugin ─────────────────────────────────────────────

export const promptInjectionRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/prompt-injection/segment/:id/content
   * Returns raw template content (base or override) + override status.
   */
  app.get<{ Params: { id: string } }>('/api/prompt-injection/segment/:id/content', async (request, reply) => {
    if (!resolveUserId(request)) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const { id } = request.params;
    const meta = EDITABLE_SEGMENTS[id];
    if (!meta) {
      reply.status(404);
      return { error: `Segment ${id} is not template-backed` };
    }

    const status = getOverrideStatus(id);
    const content = getTemplateRawContent(id, true);
    const baseContent = status?.hasOverride ? getTemplateRawContent(id, false) : content;
    const fileInfo = getTemplateFileInfo(id);
    const hasBackup = fileInfo ? existsSync(join(TEMPLATES_DIR, `${fileInfo.local}.bak`)) : false;

    return {
      segmentId: id,
      allowLocalOverride: meta.allowLocalOverride,
      hasOverride: status?.hasOverride ?? false,
      hasBackup,
      content: content ?? '',
      baseContent: baseContent ?? '',
      vars: meta.vars,
    };
  });

  /**
   * POST /api/prompt-injection/segment/:id/preview
   * Compile preview — renders template with runtime variables.
   * Body: { content: string }
   */
  app.post<{ Params: { id: string }; Body: { content: string } }>(
    '/api/prompt-injection/segment/:id/preview',
    async (request, reply) => {
      if (!resolveUserId(request)) {
        reply.status(401);
        return { error: 'Authentication required' };
      }
      const { id } = request.params;
      const meta = EDITABLE_SEGMENTS[id];
      if (!meta) {
        reply.status(404);
        return { error: `Segment ${id} is not template-backed` };
      }

      const { content } = request.body ?? {};
      if (typeof content !== 'string') {
        reply.status(400);
        return { error: 'Missing content field' };
      }

      const vars = resolveVars(id);
      let rendered: string;
      if (meta.ext === 'yaml') {
        // YAML preview: parse and show per-key values
        try {
          const parsed: unknown = YAML.parse(content);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reply.status(400);
            return { error: 'YAML must be a mapping (object), not a scalar or list' };
          }
          const entries: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed)) {
            entries[k] = typeof v === 'string' ? v.trimEnd() : String(v);
          }
          rendered = JSON.stringify(entries, null, 2);
        } catch (e) {
          reply.status(400);
          return { error: `Invalid YAML: ${e instanceof Error ? e.message : String(e)}` };
        }
      } else {
        rendered = renderTemplate(stripComments(content), vars);
      }
      return { segmentId: id, rendered };
    },
  );

  /**
   * PUT /api/prompt-injection/segment/:id/override
   * Save .local overlay file. Only allowed for allowLocalOverride: true segments.
   * Body: { content: string }
   * Backs up existing .local to .local.bak before overwriting.
   */
  app.put<{ Params: { id: string }; Body: { content: string } }>(
    '/api/prompt-injection/segment/:id/override',
    async (request, reply) => {
      if (!resolveUserId(request)) {
        reply.status(401);
        return { error: 'Authentication required' };
      }
      const { id } = request.params;
      const meta = EDITABLE_SEGMENTS[id];
      if (!meta) {
        reply.status(404);
        return { error: `Segment ${id} is not template-backed` };
      }
      if (!meta.allowLocalOverride) {
        reply.status(403);
        return { error: `Segment ${id} is readonly — override not allowed` };
      }

      const { content } = request.body ?? {};
      if (typeof content !== 'string' || content.trim().length === 0) {
        reply.status(400);
        return { error: 'Missing or empty content field' };
      }

      // Validate YAML segments parse to a plain object (not null/scalar/array)
      if (meta.ext === 'yaml') {
        try {
          const parsed: unknown = YAML.parse(content);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reply.status(400);
            return { error: 'YAML must be a mapping (object), not a scalar or list' };
          }
        } catch (e) {
          reply.status(400);
          return { error: `Invalid YAML: ${e instanceof Error ? e.message : String(e)}` };
        }
      }

      const fileInfo = getTemplateFileInfo(id);
      if (!fileInfo) {
        reply.status(500);
        return { error: 'Template file info not found' };
      }

      const localPath = join(TEMPLATES_DIR, fileInfo.local);
      mkdirSync(dirname(localPath), { recursive: true });

      // Backup existing .local to .local.bak
      if (existsSync(localPath)) {
        const bakPath = `${localPath}.bak`;
        copyFileSync(localPath, bakPath);
      }

      writeFileSync(localPath, content, 'utf-8');

      return { segmentId: id, saved: true, path: fileInfo.local };
    },
  );

  /**
   * DELETE /api/prompt-injection/segment/:id/override
   * Remove .local overlay, reverting to default template.
   */
  app.delete<{ Params: { id: string } }>('/api/prompt-injection/segment/:id/override', async (request, reply) => {
    if (!resolveUserId(request)) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const { id } = request.params;
    const meta = EDITABLE_SEGMENTS[id];
    if (!meta) {
      reply.status(404);
      return { error: `Segment ${id} is not template-backed` };
    }

    const fileInfo = getTemplateFileInfo(id);
    if (!fileInfo?.local) {
      return { segmentId: id, deleted: false, reason: 'No overlay path defined' };
    }

    const localPath = join(TEMPLATES_DIR, fileInfo.local);
    if (existsSync(localPath)) {
      unlinkSync(localPath);
      return { segmentId: id, deleted: true };
    }
    return { segmentId: id, deleted: false, reason: 'No override file exists' };
  });

  /**
   * POST /api/prompt-injection/segment/:id/restore-backup
   * Restore .local from .local.bak (one-click rollback to previous version).
   */
  app.post<{ Params: { id: string } }>('/api/prompt-injection/segment/:id/restore-backup', async (request, reply) => {
    if (!resolveUserId(request)) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const { id } = request.params;
    const meta = EDITABLE_SEGMENTS[id];
    if (!meta) {
      reply.status(404);
      return { error: `Segment ${id} is not template-backed` };
    }
    if (!meta.allowLocalOverride) {
      reply.status(403);
      return { error: `Segment ${id} is readonly` };
    }
    const fileInfo = getTemplateFileInfo(id);
    if (!fileInfo?.local) {
      reply.status(500);
      return { error: 'Template file info not found' };
    }
    const bakPath = join(TEMPLATES_DIR, `${fileInfo.local}.bak`);
    if (!existsSync(bakPath)) {
      reply.status(404);
      return { error: 'No backup file exists' };
    }
    const localPath = join(TEMPLATES_DIR, fileInfo.local);
    copyFileSync(bakPath, localPath);
    return { segmentId: id, restored: true };
  });
};
