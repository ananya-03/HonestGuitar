/**
 * HonestGuitar — Backend Server
 * Node.js + Express orchestrator for all agents
 *
 * Routes:
 *   GET  /api/config         — frontend-safe runtime config
 *   POST /api/analyse        — full pipeline (video + profile → roadmap)
 *   POST /api/scrape-song    — scrape tips for a single song on demand
 *   GET  /api/health         — health check
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { waitUntil } from '@vercel/functions';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { scrapeSongForums, scrapeGearForums } from './webAgent.js';
import { synthesiseSongTips } from './synthesiser.js';
import { runAnalysisJob } from './analysisJob.js';
import { createJob, getJobStoreMode, isJobStoreReady, readJob, toClientJob } from './jobStore.js';
import { getMediaAnalysisProvider, getMediaAnalysisProviderLabel, isMediaAnalysisConfigured } from './videoAnalyser.js';

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, 'public');
const isVercelDeployment = Boolean(process.env.VERCEL);
const uploadLimitMb = Math.max(1, Number(process.env.VIDEO_UPLOAD_LIMIT_MB || (isVercelDeployment ? 4 : 100)));
const uploadLimitBytes = Math.floor(uploadLimitMb * 1024 * 1024);
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadLimitBytes } });
const tinyFishConfigured = Boolean(process.env.TINYFISH_API_KEY || process.env.TINY_FISH_API_KEY);
const geminiConfigured = Boolean(process.env.GEMINI_API_KEY);
const spotifyConfigured = Boolean(process.env.SPOTIFY_CLIENT_ID);
const mediaAnalysisProvider = getMediaAnalysisProvider();
const mediaAnalysisProviderLabel = getMediaAnalysisProviderLabel();
const mediaAnalysisConfigured = isMediaAnalysisConfigured();

function normaliseArray(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(item => String(item).trim()).filter(Boolean) : [];
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/assets', express.static(join(PUBLIC_DIR, 'assets')));
app.get('/', (_, res) => res.sendFile(join(ROOT_DIR, 'honestguitar.html')));

// ─── Health and config ───────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/api/config', (_, res) => {
  res.json({
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || null,
    geminiConfigured,
    mediaAnalysisProvider,
    mediaAnalysisProviderLabel,
    mediaAnalysisConfigured,
    spotifyConfigured,
    tinyFishConfigured,
    uploadLimitMb,
    deploymentTarget: isVercelDeployment ? 'vercel' : 'local',
    jobStoreMode: getJobStoreMode()
  });
});

// ─── Background analysis job entrypoint ──────────────────────────────────────
app.post('/api/analyse', upload.single('video'), async (req, res) => {
  try {
    if (!isJobStoreReady()) {
      return res.status(500).json({
        ok: false,
        error: 'Background job storage is not configured. Set BLOB_READ_WRITE_TOKEN on Vercel before using analysis jobs.'
      });
    }

    let profile;
    try {
      profile = typeof req.body.profile === 'string' ? JSON.parse(req.body.profile) : req.body;
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid profile JSON in request body.' });
    }

    const job = await createJob({
      profile,
      video: req.file ? {
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        name: req.file.originalname
      } : null
    });

    const backgroundTask = runAnalysisJob(job.id, job).catch(error => {
      console.error(`Background analysis job ${job.id} failed:`, error);
    });

    if (isVercelDeployment) {
      waitUntil(backgroundTask);
    } else {
      backgroundTask.catch(() => {});
    }

    return res.status(202).json({
      ok: true,
      jobId: job.id,
      status: job.status
    });
  } catch (err) {
    console.error('Create job error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Unexpected server error'
    });
  }
});

app.get('/api/analyse/:jobId', async (req, res) => {
  const job = await readJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      ok: false,
      error: 'Analysis job not found'
    });
  }

  return res.json({
    ok: true,
    ...toClientJob(job)
  });
});

app.get('/api/analyse/:jobId/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 1500\n\n');

  let closed = false;
  let lastSnapshot = '';
  let intervalId = null;

  const closeStream = () => {
    if (closed) return;
    closed = true;
    if (intervalId) clearInterval(intervalId);
    res.end();
  };

  req.on('close', closeStream);

  const pushUpdate = async () => {
    if (closed) return;

    const job = await readJob(req.params.jobId);
    if (!job) {
      res.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: 'Analysis job not found' })}\n\n`);
      closeStream();
      return;
    }

    const payload = {
      ok: true,
      ...toClientJob(job)
    };
    const snapshot = JSON.stringify({
      status: payload.status,
      progress: payload.progress,
      logCount: payload.logs?.length || 0,
      error: payload.error,
      updatedAt: payload.updatedAt
    });

    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    if (payload.status === 'succeeded' || payload.status === 'failed') {
      closeStream();
    }
  };

  try {
    await pushUpdate();
    intervalId = setInterval(() => {
      pushUpdate().catch(error => {
        if (closed) return;
        res.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: error.message || 'Event stream failed' })}\n\n`);
        closeStream();
      });
    }, 1000);
  } catch (error) {
    res.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: error.message || 'Event stream failed' })}\n\n`);
    closeStream();
  }
});

// ─── On-demand song tips ─────────────────────────────────────────────────────
app.post('/api/scrape-song', express.json(), async (req, res) => {
  const { title, artist, chords: userChords, guitar } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required' });

  try {
    const [forumTips, gearTips] = await Promise.all([
      scrapeSongForums(`${title} ${artist}`, normaliseArray(userChords)),
      scrapeGearForums(guitar || 'acoustic', [], '')
    ]);
    const synthesis = await synthesiseSongTips({ title, artist, userChords: normaliseArray(userChords), forumTips, gearTips, guitar });
    res.json(synthesis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      ok: false,
      error: `Video must be ${uploadLimitMb}MB or smaller on this deployment.`
    });
  }

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: `Request payload exceeded the ${uploadLimitMb}MB upload limit.`
    });
  }

  return next(err);
});

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('Unhandled express error:', err);
  return res.status(err?.status || 500).json({
    ok: false,
    error: err?.message || 'Unexpected server error'
  });
});

export default app;

if (!isVercelDeployment) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`\n🎸 HonestGuitar server running at http://localhost:${PORT}`);
    console.log(`   Deployment:   local`);
    console.log(`   Upload limit: ${uploadLimitMb}MB`);
    console.log(`   Job store:    ${getJobStoreMode()}`);
    console.log(`   Media AI:     ${mediaAnalysisProviderLabel} (${mediaAnalysisProvider}) ${mediaAnalysisConfigured ? '✓ ready' : '✗ not configured'}`);
    console.log(`   TinyFish key:  ${tinyFishConfigured ? '✓ set' : '✗ missing (set TINYFISH_API_KEY or TINY_FISH_API_KEY)'}`);
    console.log(`   OpenAI key:    ${process.env.OPENAI_API_KEY ? '✓ set' : '✗ missing (set OPENAI_API_KEY)'}`);
    console.log(`   Gemini key:    ${geminiConfigured ? '✓ set' : '✗ missing (set GEMINI_API_KEY)'}`);
    console.log(`   Spotify client:${spotifyConfigured ? ' ✓ set' : ' ✗ missing (set SPOTIFY_CLIENT_ID)'}\n`);
  });
}
