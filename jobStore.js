import { randomUUID } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { del, head, put } from '@vercel/blob';

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const LOCAL_JOB_DIR = join(ROOT_DIR, '.job-data');
const isVercelDeployment = Boolean(process.env.VERCEL);
const blobStoreConfigured = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const useBlobStoreLocally = process.env.USE_BLOB_STORE_LOCALLY === '1';
const useBlobStore = blobStoreConfigured && (isVercelDeployment || useBlobStoreLocally);
const blobAccessMode = process.env.BLOB_ACCESS_MODE === 'private' ? 'private' : 'public';

function extensionFromMimeType(mimeType = 'video/mp4') {
  const mapping = {
    'video/mp4': 'mp4',
    'video/mpeg': 'mpeg',
    'video/mov': 'mov',
    'video/quicktime': 'mov',
    'video/avi': 'avi',
    'video/webm': 'webm'
  };

  return mapping[mimeType] || mimeType.split('/')[1] || 'mp4';
}

function statePath(jobId) {
  return `jobs/${jobId}/state.json`;
}

function localStatePath(jobId) {
  return join(LOCAL_JOB_DIR, `${jobId}.json`);
}

function localVideoPath(jobId, mimeType) {
  return join(LOCAL_JOB_DIR, `${jobId}.${extensionFromMimeType(mimeType)}`);
}

function videoPath(jobId, mimeType) {
  return `jobs/${jobId}/input.${extensionFromMimeType(mimeType)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureLocalDir() {
  await mkdir(LOCAL_JOB_DIR, { recursive: true });
}

async function writeBlobJson(pathname, value) {
  await put(pathname, JSON.stringify(value), {
    access: blobAccessMode,
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

async function readBlobJson(pathname) {
  let lastError = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const metadata = await head(pathname);
      const response = await fetch(metadata.downloadUrl, { cache: 'no-store' });
      if (!response.ok) {
        lastError = new Error(`Blob fetch failed with ${response.status}`);
      } else {
        const text = await response.text();
        return JSON.parse(text);
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(Math.min(250 * (attempt + 1), 1500));
  }

  if (lastError) {
    console.warn(`Blob state read failed for ${pathname}:`, lastError.message || lastError);
  }

  return null;
}

export function getJobStoreMode() {
  if (isVercelDeployment) return blobStoreConfigured ? `vercel-blob-${blobAccessMode}` : 'missing';
  if (useBlobStore) return `blob-${blobAccessMode}`;
  return 'filesystem';
}

export function isJobStoreReady() {
  return !isVercelDeployment || useBlobStore;
}

export function createEmptyAgents(hasVideo) {
  return {
    video: { status: hasVideo ? 'idle' : 'done', text: hasVideo ? 'waiting' : 'skipped' },
    tab: { status: 'idle', text: 'waiting' },
    forum: { status: 'idle', text: 'waiting' },
    synth: { status: 'idle', text: 'waiting' }
  };
}

export async function writeJob(job) {
  const nextJob = {
    ...job,
    updatedAt: new Date().toISOString()
  };

  if (useBlobStore) {
    await writeBlobJson(statePath(job.id), nextJob);
    return nextJob;
  }

  await ensureLocalDir();
  await writeFile(localStatePath(job.id), JSON.stringify(nextJob, null, 2));
  return nextJob;
}

export async function readJob(jobId) {
  if (useBlobStore) {
    return await readBlobJson(statePath(jobId));
  }

  try {
    const raw = await readFile(localStatePath(jobId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function createJob({ profile, video }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  let videoRef = null;

  if (video?.buffer) {
    const pathname = videoPath(id, video.mimeType);

    if (useBlobStore) {
      await put(pathname, video.buffer, {
        access: blobAccessMode,
        contentType: video.mimeType,
        addRandomSuffix: false,
        allowOverwrite: true
      });
    } else {
      await ensureLocalDir();
      await writeFile(localVideoPath(id, video.mimeType), video.buffer);
    }

    videoRef = {
      pathname,
      mimeType: video.mimeType,
      size: video.buffer.byteLength,
      name: video.name || `upload.${extensionFromMimeType(video.mimeType)}`
    };
  }

  const job = {
    id,
    status: 'queued',
    progress: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    error: null,
    profile,
    video: videoRef,
    logs: [
      {
        type: 'log',
        agent: 'orchestrator',
        message: 'Analysis job queued on the backend',
        ts: now
      }
    ],
    agents: createEmptyAgents(Boolean(videoRef)),
    result: null
  };

  return await writeJob(job);
}

export async function readJobVideoBuffer(job) {
  if (!job?.video?.pathname) return null;

  if (useBlobStore) {
    let lastError = null;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const metadata = await head(job.video.pathname);
        const response = await fetch(metadata.downloadUrl, { cache: 'no-store' });
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          return Buffer.from(arrayBuffer);
        }
        lastError = new Error(`Blob fetch failed with ${response.status}`);
      } catch (error) {
        lastError = error;
      }

      await sleep(Math.min(250 * (attempt + 1), 1500));
    }

    if (lastError) {
      console.warn(`Blob video read failed for ${job.video.pathname}:`, lastError.message || lastError);
    }

    return null;
  }

  try {
    return await readFile(localVideoPath(job.id, job.video.mimeType));
  } catch {
    return null;
  }
}

export async function cleanupJobArtifacts(job) {
  if (!job?.video?.pathname) return;

  if (useBlobStore) {
    await del(job.video.pathname).catch(() => {});
    return;
  }

  await rm(localVideoPath(job.id, job.video.mimeType), { force: true }).catch(() => {});
}

export function toClientJob(job) {
  if (!job) return null;

  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    logs: job.logs || [],
    agents: job.agents || createEmptyAgents(false),
    data: job.result
  };
}
