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
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { analyseVideo } from './videoAnalyser.js';
import { scrapeTabsAndChords, scrapeSongForums, scrapeGearForums } from './webAgent.js';
import { synthesiseRoadmap, synthesiseSongTips } from './synthesiser.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB
const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const TINYFISH_MASCOT_PATH = '/Users/ananyasingh/Desktop/Screenshot 2026-03-28 at 2.26.36 PM.png';
const tinyFishConfigured = Boolean(process.env.TINYFISH_API_KEY || process.env.TINY_FISH_API_KEY);
const geminiConfigured = Boolean(process.env.GEMINI_API_KEY);
const spotifyConfigured = Boolean(process.env.SPOTIFY_CLIENT_ID);

function normaliseArray(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(item => String(item).trim()).filter(Boolean) : [];
}

function parseArtistString(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(item => String(item).trim()).filter(Boolean))];
}

function normaliseName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildPreferredArtists({ artists = '', spotifyTopArtists = [] }) {
  return uniqueStrings([...spotifyTopArtists, ...parseArtistString(artists)]);
}

function mergeTabResults(results, preferredArtists) {
  const seen = new Set();
  const preferredSet = new Set(preferredArtists.map(normaliseName));
  const songs = [];
  const raw = [];

  for (const result of results) {
    for (const song of result?.songs || []) {
      const key = `${normaliseName(song.title)}::${normaliseName(song.artist)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      songs.push({
        ...song,
        preferredArtist: preferredSet.has(normaliseName(song.artist))
      });
    }

    for (const item of result?.raw || []) {
      const key = `${normaliseName(item.title)}::${normaliseName(item.artist)}`;
      if (raw.some(existing => `${normaliseName(existing.title)}::${normaliseName(existing.artist)}` === key)) continue;
      raw.push(item);
    }
  }

  songs.sort((a, b) => {
    if (a.preferredArtist !== b.preferredArtist) return a.preferredArtist ? -1 : 1;
    return (b.votes || 0) - (a.votes || 0);
  });

  return {
    songs: songs.slice(0, 18),
    raw: raw.slice(0, 40),
    sources: ['ultimate-guitar.com', 'chordify.net']
  };
}

function mergeForumResults(results) {
  const tips = uniqueStrings(results.flatMap(result => result?.tips || [])).slice(0, 24);
  const hardSpots = uniqueStrings(results.flatMap(result => result?.hardSpots || [])).slice(0, 12);
  const capoAlternatives = uniqueStrings(results.flatMap(result => result?.capoAlternatives || [])).slice(0, 8);
  const sources = uniqueStrings(results.flatMap(result => result?.sources || []));
  const sourceCount = results.reduce((sum, result) => sum + (result?.sourceCount || 0), 0);

  return { tips, hardSpots, capoAlternatives, sourceCount, sources };
}

function createTinyFishLogBridge(stream, agent, label) {
  return event => {
    if (!event?.type) return;

    if (event.type === 'PROFILE_ATTEMPT') {
      stream.log(agent, `TinyFish ${event.browserProfile}: starting ${label}`);
      return;
    }

    if (event.type === 'STARTED') {
      stream.log(agent, `TinyFish ${event.browserProfile}: run ${event.runId || 'pending'} started`);
      return;
    }

    if (event.type === 'STREAMING_URL') {
      stream.log(agent, `TinyFish ${event.browserProfile}: live browser stream ready`);
      return;
    }

    if (event.type === 'PROGRESS' && event.purpose) {
      stream.log(agent, `TinyFish ${event.browserProfile}: ${event.purpose}`);
      return;
    }

    if (event.type === 'PROFILE_FALLBACK' && event.purpose) {
      stream.log(agent, `TinyFish ${event.browserProfile}: ${event.purpose}`);
      return;
    }

    if (event.type === 'COMPLETE') {
      stream.log(agent, `TinyFish ${event.browserProfile}: completed ${label}`);
    }
  };
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.get('/', (_, res) => res.sendFile(join(ROOT_DIR, 'honestguitar.html')));
app.get('/assets/hero-image.png', (_, res) => res.sendFile(join(ROOT_DIR, 'Gemini_Generated_Image_mhahmtmhahmtmhah.png')));
app.get('/assets/hero-video.mp4', (_, res) => res.sendFile(join(ROOT_DIR, 'playing_chords_202603281423.mp4')));
app.get('/assets/tinyfish-mascot.png', (_, res) => res.sendFile(TINYFISH_MASCOT_PATH));

// ─── Health and config ───────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/api/config', (_, res) => {
  res.json({
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || null,
    geminiConfigured,
    spotifyConfigured,
    tinyFishConfigured
  });
});

// ─── SSE helper (streams agent logs to the browser in real time) ────────────
function createSSEStream(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  return {
    log(agent, message) {
      res.write(`data: ${JSON.stringify({ type: 'log', agent, message, ts: new Date().toISOString() })}\n\n`);
    },
    progress(pct) {
      res.write(`data: ${JSON.stringify({ type: 'progress', pct })}\n\n`);
    },
    result(data) {
      res.write(`data: ${JSON.stringify({ type: 'result', data })}\n\n`);
      res.end();
    },
    error(msg) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
      res.end();
    }
  };
}

// ─── Main pipeline ───────────────────────────────────────────────────────────
app.post('/api/analyse', upload.single('video'), async (req, res) => {
  const stream = createSSEStream(res);

  try {
    let profile;
    try {
      profile = typeof req.body.profile === 'string' ? JSON.parse(req.body.profile) : req.body;
    } catch {
      return stream.error('Invalid profile JSON in request body.');
    }

    const {
      artists = '',
      genres = [],
      chords = [],
      guitar = 'acoustic',
      extras = [],
      gearNotes = '',
      spotify = {}
    } = profile;

    const spotifyTopArtists = normaliseArray(spotify.topArtists).slice(0, 12);
    const spotifyTopTracks = normaliseArray(spotify.topTracks).slice(0, 12);
    const videoBuffer = req.file?.buffer || null;
    const preferredArtists = buildPreferredArtists({ artists, spotifyTopArtists });
    const tasteSummary = [...preferredArtists.slice(0, 5), ...normaliseArray(genres).slice(0, 2)]
      .filter(Boolean)
      .join(', ');

    stream.log('orchestrator', 'HonestGuitar agent runtime started');
    stream.log('orchestrator', `Profile: chords=[${normaliseArray(chords).join(', ')}] gear=[${guitar}, ${normaliseArray(extras).join(', ')}]`);
    stream.log('orchestrator', `Music taste: "${tasteSummary || 'not provided'}"`);

    if (spotifyTopArtists.length) {
      stream.log('orchestrator', `Spotify import: ${spotifyTopArtists.slice(0, 5).join(', ')}`);
    }

    stream.progress(5);

    // ── Step 1: Gemini media analysis ───────────────────────────────────────
    let videoFeedback = null;
    if (videoBuffer) {
      stream.log('video-analyser', `Video received (${(videoBuffer.byteLength / 1024 / 1024).toFixed(1)} MB) — preparing Gemini analysis`);
      stream.log('video-analyser', 'Uploading video + extracted audio to Gemini for strumming, timing, and buzz analysis');
      stream.progress(15);

      try {
        videoFeedback = await analyseVideo(videoBuffer, req.file.mimetype, normaliseArray(chords), {
          guitar,
          extras: normaliseArray(extras),
          gearNotes,
          artistContext: tasteSummary
        });
        stream.log('video-analyser', `✓ Strumming pattern: ${videoFeedback.strummingPattern}`);
        stream.log('video-analyser', `✓ Timing consistency: ${videoFeedback.timingScore ?? 'n/a'}/10`);
        stream.log('video-analyser', `✓ Buzz risk: ${videoFeedback.buzzRisk}`);
        stream.log('video-analyser', `✓ Sound quality note: ${videoFeedback.soundNote}`);
      } catch (error) {
        stream.log('video-analyser', `⚠ Media analysis failed: ${error.message} — continuing without it`);
      }
    } else {
      stream.log('orchestrator', 'No video provided — skipping Gemini media analysis, using profile + taste data only');
      stream.progress(20);
    }

    // ── Step 2: Parallel web scraping via TinyFish ──────────────────────────
    stream.log('orchestrator', 'Spawning 3 TinyFish web agents in parallel');

    const artistQueries = preferredArtists.slice(0, 1);
    const fallbackQuery = normaliseArray(genres)[0] || 'popular beginner songs';
    const songQueries = artistQueries.length ? artistQueries : [fallbackQuery];

    const [tabData, forumData, gearData] = await Promise.allSettled([
      (async () => {
        stream.log('tab-scraper', '→ Navigating ultimate-guitar.com — bypassing bot challenge');
        stream.log('tab-scraper', '→ Lightweight mode: Ultimate Guitar only, one artist/query');
        if (artistQueries.length) {
          stream.log('tab-scraper', `→ Prioritising preferred artists: ${artistQueries.join(', ')}`);
        }
        const results = await Promise.allSettled(songQueries.map(query => scrapeTabsAndChords(
          query,
          normaliseArray(chords),
          { onEvent: createTinyFishLogBridge(stream, 'tab-scraper', `tab search for ${query}`) }
        )));
        const fulfilled = results.filter(result => result.status === 'fulfilled').map(result => result.value);
        const merged = mergeTabResults(fulfilled, preferredArtists);
        stream.log('tab-scraper', `✓ ${merged.songs.length} candidate songs extracted, artist-prioritised and chord-filtered`);
        return merged;
      })(),

      (async () => {
        stream.log('forum-miner', '→ Navigating r/guitarlessons — mining beginner difficulty threads');
        stream.log('forum-miner', '→ Lightweight mode: r/guitarlessons only, one artist/query');
        const forumTargets = songQueries.slice(0, 1);
        const results = await Promise.allSettled(forumTargets.map(query => scrapeSongForums(
          query,
          normaliseArray(chords),
          { onEvent: createTinyFishLogBridge(stream, 'forum-miner', `forum search for ${query}`) }
        )));
        const fulfilled = results.filter(result => result.status === 'fulfilled').map(result => result.value);
        const merged = mergeForumResults(fulfilled);
        stream.log('forum-miner', `✓ Difficulty intel collected from ${merged.sourceCount} forum threads`);
        return merged;
      })(),

      (async () => {
        stream.log('gear-intel', `→ Profile: "${guitar}, ${normaliseArray(extras).join(', ')}" — querying budget guitar communities`);
        stream.log('gear-intel', '→ Lightweight mode: r/acousticguitar only');
        const result = await scrapeGearForums(
          guitar,
          normaliseArray(extras),
          gearNotes,
          { onEvent: createTinyFishLogBridge(stream, 'gear-intel', `gear search for ${guitar}`) }
        );
        stream.log('gear-intel', `✓ Gear intel consolidated for ${guitar} setup`);
        return result;
      })()
    ]);

    stream.progress(72);

    const tabs = tabData.status === 'fulfilled' ? tabData.value : { songs: [], raw: '' };
    const forums = forumData.status === 'fulfilled' ? forumData.value : { tips: [], sourceCount: 0 };
    const gear = gearData.status === 'fulfilled' ? gearData.value : { tips: [], upgrades: [] };

    // ── Step 3: Synthesis ────────────────────────────────────────────────────
    stream.log('synthesiser', `Merging scraped data with ${videoFeedback ? 'Gemini media analysis + ' : ''}taste profile`);
    stream.log('synthesiser', 'Calling OpenAI to generate personalised roadmap');
    stream.progress(82);

    const roadmap = await synthesiseRoadmap({
      profile: {
        artists,
        genres: normaliseArray(genres),
        chords: normaliseArray(chords),
        guitar,
        extras: normaliseArray(extras),
        gearNotes,
        spotify: {
          topArtists: spotifyTopArtists,
          topTracks: spotifyTopTracks
        },
        preferredArtists
      },
      videoFeedback,
      tabs,
      forums,
      gear
    });

    roadmap.mediaAnalysis = videoFeedback;
    roadmap.spotifyTaste = {
      topArtists: spotifyTopArtists,
      topTracks: spotifyTopTracks
    };

    stream.progress(100);
    stream.log('synthesiser', `✓ Roadmap ready — ${roadmap.songs.length} songs, ${roadmap.nextChords.length} new chords to learn`);

    stream.result(roadmap);
  } catch (err) {
    console.error('Pipeline error:', err);
    stream.error(err.message || 'Unexpected server error');
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎸 HonestGuitar server running at http://localhost:${PORT}`);
  console.log(`   TinyFish key:  ${tinyFishConfigured ? '✓ set' : '✗ missing (set TINYFISH_API_KEY or TINY_FISH_API_KEY)'}`);
  console.log(`   OpenAI key:    ${process.env.OPENAI_API_KEY ? '✓ set' : '✗ missing (set OPENAI_API_KEY)'}`);
  console.log(`   Gemini key:    ${geminiConfigured ? '✓ set' : '✗ missing (set GEMINI_API_KEY)'}`);
  console.log(`   Spotify client:${spotifyConfigured ? ' ✓ set' : ' ✗ missing (set SPOTIFY_CLIENT_ID)'}\n`);
});
