/**
 * HonestGuitar — Gemini performance analyser
 *
 * Extracts visual frames from the user's clip and sends those frames to Gemini
 * for posture/strumming analysis, while a separate audio track is analysed for
 * buzz, timing, and tone.
 */

import { GoogleGenAI, createPartFromUri, createUserContent } from '@google/genai';
import ffmpeg from 'fluent-ffmpeg';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';

const GEMINI_MEDIA_MODEL = 'gemini-3-flash-preview';

const VIDEO_SCHEMA = {
  type: 'object',
  properties: {
    strummingPattern: { type: 'string' },
    strummingScore: { type: 'number' },
    timingConsistency: { type: 'string' },
    timingScore: { type: 'number' },
    chordShapesObserved: { type: 'array', items: { type: 'string' } },
    handPositionNotes: { type: 'string' },
    strumHandNotes: { type: 'string' },
    transitionFeedback: { type: 'string' },
    postureSummary: { type: 'string' },
    visualCorrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          focusArea: { type: 'string' },
          wrong: { type: 'string' },
          correct: { type: 'string' }
        },
        required: ['focusArea', 'wrong', 'correct']
      }
    },
    frameFeedback: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          frameIndex: { type: 'number' },
          focusArea: { type: 'string' },
          wrong: { type: 'string' },
          correct: { type: 'string' }
        },
        required: ['frameIndex', 'focusArea', 'wrong', 'correct']
      }
    },
    positives: { type: 'array', items: { type: 'string' } },
    topImprovements: { type: 'array', items: { type: 'string' } },
    overallAssessment: { type: 'string' }
  },
  required: [
    'strummingPattern',
    'strummingScore',
    'timingConsistency',
    'timingScore',
    'chordShapesObserved',
    'handPositionNotes',
    'strumHandNotes',
    'transitionFeedback',
    'postureSummary',
    'visualCorrections',
    'frameFeedback',
    'positives',
    'topImprovements',
    'overallAssessment'
  ]
};

const AUDIO_SCHEMA = {
  type: 'object',
  properties: {
    soundQualitySummary: { type: 'string' },
    soundScore: { type: 'number' },
    buzzRisk: { type: 'string' },
    buzzNotes: { type: 'string' },
    rhythmNotes: { type: 'string' },
    dynamicsNotes: { type: 'string' },
    toneNotes: { type: 'string' },
    noiseIssues: { type: 'array', items: { type: 'string' } },
    audioPositives: { type: 'array', items: { type: 'string' } },
    topAudioFixes: { type: 'array', items: { type: 'string' } },
    overallAssessment: { type: 'string' }
  },
  required: [
    'soundQualitySummary',
    'soundScore',
    'buzzRisk',
    'buzzNotes',
    'rhythmNotes',
    'dynamicsNotes',
    'toneNotes',
    'noiseIssues',
    'audioPositives',
    'topAudioFixes',
    'overallAssessment'
  ]
};

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  return new GoogleGenAI({ apiKey });
}

function safeAverage(...values) {
  const nums = values.filter(v => typeof v === 'number' && !Number.isNaN(v));
  if (!nums.length) return null;
  return Math.round(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function uniqueStrings(...lists) {
  return [...new Set(lists.flat().filter(Boolean).map(item => String(item).trim()).filter(Boolean))];
}

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

async function createTempMediaFiles(videoBuffer, mimeType) {
  const tmpId = randomBytes(8).toString('hex');
  const dir = join(tmpdir(), `hg-${tmpId}`);
  const videoPath = join(dir, `input.${extensionFromMimeType(mimeType)}`);
  const audioPath = join(dir, 'input-audio.mp3');
  const framePattern = join(dir, 'frame-%02d.jpg');

  await mkdir(dir, { recursive: true });
  await writeFile(videoPath, videoBuffer);

  return { dir, videoPath, audioPath, framePattern };
}

async function extractAudioTrack(videoPath, audioPath) {
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .format('mp3')
      .outputOptions(['-ac 1', '-ar 16000'])
      .save(audioPath)
      .on('end', resolve)
      .on('error', reject);
  });
}

async function probeVideoDuration(videoPath) {
  return await new Promise(resolve => {
    ffmpeg.ffprobe(videoPath, (error, metadata) => {
      if (error) {
        resolve(0);
        return;
      }

      resolve(Number(metadata?.format?.duration || 0));
    });
  });
}

async function extractSingleFrame(videoPath, outputPath, timestamp) {
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(Math.max(0, timestamp))
      .outputOptions(['-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '6'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function extractPreviewFrames(videoPath, framePattern, frameCount = 5) {
  const duration = await probeVideoDuration(videoPath);
  const timestamps = duration > 1
    ? Array.from({ length: frameCount }, (_, index) => {
        const ratio = (index + 1) / (frameCount + 1);
        return Math.min(Math.max(duration * ratio, 0.15), Math.max(duration - 0.12, 0.15));
      })
    : [0.15];

  for (let index = 0; index < timestamps.length; index += 1) {
    const framePath = framePattern.replace('%02d', String(index + 1).padStart(2, '0'));
    try {
      await extractSingleFrame(videoPath, framePath, timestamps[index]);
    } catch {
      // Keep going so one bad timestamp does not kill the whole preview strip.
    }
  }

  const frames = [];
  for (let index = 1; index <= frameCount; index += 1) {
    const framePath = framePattern.replace('%02d', String(index).padStart(2, '0'));
    try {
      const buffer = await readFile(framePath);
      const base64 = buffer.toString('base64');
      frames.push({
        frameIndex: index,
        dataUrl: `data:image/jpeg;base64,${base64}`,
        inlinePart: {
          inlineData: {
            mimeType: 'image/jpeg',
            data: base64
          }
        }
      });
    } catch {
      break;
    }
  }

  return frames;
}

async function analyseUploadedFile(ai, uploadedFile, prompt, schema) {
  const response = await ai.models.generateContent({
    model: GEMINI_MEDIA_MODEL,
    contents: createUserContent([
      createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
      prompt
    ]),
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: schema
    }
  });

  return JSON.parse(response.text || '{}');
}

async function analyseFrameSet(ai, frameSet, prompt, schema) {
  const response = await ai.models.generateContent({
    model: GEMINI_MEDIA_MODEL,
    contents: createUserContent([
      prompt,
      ...frameSet.map(frame => frame.inlinePart)
    ]),
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: schema
    }
  });

  return JSON.parse(response.text || '{}');
}

async function uploadAudioFile(ai, audioPath) {
  return await ai.files.upload({
    file: audioPath,
    config: { mimeType: 'audio/mpeg' }
  });
}

function buildVideoPrompt(knownChords, context, frameCount) {
  const taste = context.artistContext ? `Taste context: ${context.artistContext}.` : 'No taste context provided.';
  const setup = [context.guitar, ...(context.extras || [])].filter(Boolean).join(', ');
  const known = knownChords.length
    ? `The player claims to know these chords: ${knownChords.join(', ')}.`
    : 'The player has not declared their known chords.';

  return `You are an expert beginner guitar coach analysing ${frameCount} extracted frames from a single performance clip.

${known}
${taste}
Setup context: ${setup || 'unknown'}.
Extra setup note: ${context.gearNotes || 'none'}.

The frames are ordered chronologically from earliest to latest.
When you return frameFeedback, use 1-based frameIndex values that refer to these extracted frames.

Focus only on what is visually supported by the clip:
- visible strumming pattern and consistency
- chord shapes and fretting posture
- right-hand movement and tension
- smoothness of chord changes
- whether the player looks in control or overloaded
- 2 to 4 visual corrections with a "wrong" vs "correct" phrasing a beginner can act on immediately
- 2 to 5 frame-specific corrections mapped to frame indices so the UI can show green/red feedback on the extracted frames

Do not invent details you cannot see.
Keep scores on a 0-10 scale.
Return only JSON matching the schema.`;
}

function buildAudioPrompt(knownChords, context) {
  const known = knownChords.length
    ? `The player claims to know these chords: ${knownChords.join(', ')}.`
    : 'The player has not declared their known chords.';
  const setup = [context.guitar, ...(context.extras || [])].filter(Boolean).join(', ');

  return `You are an expert beginner guitar coach analysing the audio from a practice clip.

${known}
Setup context: ${setup || 'unknown'}.
Extra setup note: ${context.gearNotes || 'none'}.

Focus on audio evidence only:
- buzz or fret noise
- muted or dead strings
- timing and rhythm steadiness
- attack consistency and dynamics
- likely tone limitations from cheap gear versus technique issues

If the audio is too noisy or unclear, say so directly.
Keep scores on a 0-10 scale.
Return only JSON matching the schema.`;
}

function buildEmptyVideoResult() {
  return {
    strummingPattern: 'Pattern unclear from extracted frames',
    strummingScore: null,
    timingConsistency: 'Timing unclear from extracted frames',
    timingScore: null,
    chordShapesObserved: [],
    handPositionNotes: '',
    strumHandNotes: '',
    transitionFeedback: '',
    postureSummary: '',
    visualCorrections: [],
    frameFeedback: [],
    positives: [],
    topImprovements: [],
    overallAssessment: 'Visual frame extraction did not yield enough usable evidence.'
  };
}

async function deleteUploadedFile(ai, uploadedFile) {
  if (!uploadedFile?.name) return;
  await ai.files.delete({ name: uploadedFile.name }).catch(() => {});
}

// ─── Main performance analysis function ─────────────────────────────────────
export async function analyseVideo(videoBuffer, mimeType = 'video/mp4', knownChords = [], context = {}) {
  const ai = getGeminiClient();
  const temp = await createTempMediaFiles(videoBuffer, mimeType);
  let uploadedAudio = null;
  let previewFrames = [];

  try {
    await extractAudioTrack(temp.videoPath, temp.audioPath);
    try {
      previewFrames = await extractPreviewFrames(temp.videoPath, temp.framePattern);
    } catch {
      previewFrames = [];
    }
    uploadedAudio = await uploadAudioFile(ai, temp.audioPath);

    const [videoResult, audioResult] = await Promise.all([
      previewFrames.length
        ? analyseFrameSet(ai, previewFrames, buildVideoPrompt(knownChords, context, previewFrames.length), VIDEO_SCHEMA)
        : Promise.resolve(buildEmptyVideoResult()),
      analyseUploadedFile(ai, uploadedAudio, buildAudioPrompt(knownChords, context), AUDIO_SCHEMA)
    ]);

    const topImprovements = uniqueStrings(videoResult.topImprovements, audioResult.topAudioFixes).slice(0, 4);
    const positives = uniqueStrings(videoResult.positives, audioResult.audioPositives).slice(0, 4);
    const overallAssessment = [
      videoResult.overallAssessment,
      audioResult.overallAssessment
    ].filter(Boolean).join(' ');

    return {
      analysisEngine: 'Gemini 3 Flash',
      strummingPattern: videoResult.strummingPattern || audioResult.rhythmNotes || 'Pattern unclear from clip',
      strummingScore: videoResult.strummingScore ?? null,
      timingConsistency: videoResult.timingConsistency || audioResult.rhythmNotes || 'Timing unclear from clip',
      timingScore: safeAverage(videoResult.timingScore, audioResult.soundScore),
      chordShapesObserved: videoResult.chordShapesObserved || [],
      handPositionNotes: videoResult.handPositionNotes || '',
      strumHandNotes: videoResult.strumHandNotes || '',
      transitionFeedback: videoResult.transitionFeedback || '',
      postureSummary: videoResult.postureSummary || '',
      visualCorrections: videoResult.visualCorrections || [],
      frameFeedback: (videoResult.frameFeedback || [])
        .map(item => ({
          frameIndex: Math.max(1, Math.min(previewFrames.length || 1, Math.round(Number(item.frameIndex) || 1))),
          focusArea: item.focusArea || 'Technique cue',
          wrong: item.wrong || '',
          correct: item.correct || ''
        }))
        .filter(item => item.wrong || item.correct),
      previewFrames: previewFrames.map(frame => frame.dataUrl),
      soundNote: audioResult.soundQualitySummary || audioResult.toneNotes || '',
      soundScore: audioResult.soundScore ?? null,
      buzzRisk: audioResult.buzzRisk || 'unknown',
      buzzNotes: audioResult.buzzNotes || '',
      rhythmNotes: audioResult.rhythmNotes || '',
      dynamicsNotes: audioResult.dynamicsNotes || '',
      toneNotes: audioResult.toneNotes || '',
      noiseIssues: audioResult.noiseIssues || [],
      topImprovements,
      positives,
      overallAssessment,
      rawVideoAnalysis: videoResult,
      rawAudioAnalysis: audioResult
    };
  } catch (error) {
    throw new Error(`Gemini media analysis failed: ${error.message}`);
  } finally {
    await Promise.allSettled([
      deleteUploadedFile(ai, uploadedAudio),
      rm(temp.dir, { recursive: true, force: true })
    ]);
  }
}
