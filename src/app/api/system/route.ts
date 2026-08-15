/**
 * GET /api/system — environment readiness.
 *
 * Powers the status strip in the UI and doubles as the health check: FFmpeg
 * detection, which AI provider is active, and which API keys are configured.
 * Secrets are reported as booleans only.
 */

import { handleRoute, jsonOk } from '@/lib/api';
import { describeConfig } from '@/config/env';
import { registeredProviderIds } from '@/ai/registry';
import { isAppError, toAppError } from '@/lib/errors';
import { getRuntime } from '@/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const rt = getRuntime();

  return handleRoute(rt.logger, 'GET /api/system', async () => {
    const toolchain = await rt.media.toolchain();

    // An unimplemented provider is a configuration state to report, not a crash.
    let provider: { id: string; displayName: string; capabilities: readonly string[]; ok: boolean; detail: string };
    try {
      const resolved = rt.aiProvider();
      const health = await resolved.health();
      provider = {
        id: resolved.id,
        displayName: resolved.displayName,
        capabilities: resolved.capabilities,
        ok: health.ok,
        detail: health.detail,
      };
    } catch (error) {
      const app = toAppError(error);
      if (!isAppError(error)) rt.logger.error('provider resolution failed', error);
      provider = {
        id: rt.config.ai.provider,
        displayName: rt.config.ai.provider,
        capabilities: [],
        ok: false,
        detail: app.message,
      };
    }

    return jsonOk({
      phase: 1,
      config: describeConfig(rt.config),
      ffmpeg: {
        available: toolchain.available,
        ffmpegVersion: toolchain.ffmpeg.version,
        ffprobeVersion: toolchain.ffprobe.version,
        ffmpegError: toolchain.ffmpeg.error,
        ffprobeError: toolchain.ffprobe.error,
      },
      ai: { active: provider, registered: registeredProviderIds() },
    });
  });
}
