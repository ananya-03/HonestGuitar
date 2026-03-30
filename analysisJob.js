import { analyseVideo, getMediaAnalysisProviderLabel } from './videoAnalyser.js';
import { scrapeTabsAndChords, scrapeSongForums, scrapeGearForums } from './webAgent.js';
import { synthesiseRoadmap } from './synthesiser.js';
import { cleanupJobArtifacts, readJob, readJobVideoBuffer, writeJob } from './jobStore.js';

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

function createJobStream(job) {
  let persistChain = Promise.resolve();

  function schedulePersist() {
    const snapshot = structuredClone(job);
    persistChain = persistChain
      .catch(() => {})
      .then(() => writeJob(snapshot));
    return persistChain;
  }

  return {
    log(agent, message) {
      job.logs.push({ type: 'log', agent, message, ts: new Date().toISOString() });
      schedulePersist();
    },
    progress(pct) {
      job.progress = pct;
      schedulePersist();
    },
    setAgent(agent, status, text) {
      if (!job.agents[agent]) return;
      job.agents[agent] = { status, text };
      schedulePersist();
    },
    async flush() {
      await persistChain;
    }
  };
}

export async function runAnalysisJob(jobId) {
  const mediaProviderLabel = getMediaAnalysisProviderLabel();
  let job = await readJob(jobId);
  if (!job || job.status !== 'queued') return;

  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.error = null;
  job = await writeJob(job);

  const stream = createJobStream(job);

  try {
    const {
      artists = '',
      genres = [],
      chords = [],
      guitar = 'acoustic',
      extras = [],
      gearNotes = '',
      spotify = {}
    } = job.profile || {};

    const spotifyTopArtists = normaliseArray(spotify.topArtists).slice(0, 12);
    const spotifyTopTracks = normaliseArray(spotify.topTracks).slice(0, 12);
    const knownChords = normaliseArray(chords);
    const normalisedExtras = normaliseArray(extras);
    const preferredArtists = buildPreferredArtists({ artists, spotifyTopArtists });
    const tasteSummary = [...preferredArtists.slice(0, 5), ...normaliseArray(genres).slice(0, 2)]
      .filter(Boolean)
      .join(', ');

    stream.log('orchestrator', 'HonestGuitar agent runtime started');
    stream.log('orchestrator', `Profile: chords=[${knownChords.join(', ')}] gear=[${guitar}, ${normalisedExtras.join(', ')}]`);
    stream.log('orchestrator', `Music taste: "${tasteSummary || 'not provided'}"`);
    stream.progress(5);

    if (spotifyTopArtists.length) {
      stream.log('orchestrator', `Spotify import: ${spotifyTopArtists.slice(0, 5).join(', ')}`);
    }

    let videoFeedback = null;
    if (job.video) {
      stream.setAgent('video', 'active', 'analysing');
      const videoBuffer = await readJobVideoBuffer(job);
      if (!videoBuffer) {
        stream.log('video-analyser', '⚠ Uploaded clip could not be restored from storage — continuing without media analysis');
        stream.setAgent('video', 'done', 'skipped');
        stream.progress(20);
      } else {
        stream.log('video-analyser', `Video received (${(videoBuffer.byteLength / 1024 / 1024).toFixed(1)} MB) — preparing ${mediaProviderLabel} analysis`);
        stream.log('video-analyser', `Uploading extracted frames and audio to ${mediaProviderLabel} for strumming, timing, and buzz analysis`);
        stream.progress(15);

        try {
          videoFeedback = await analyseVideo(videoBuffer, job.video.mimeType, knownChords, {
            guitar,
            extras: normalisedExtras,
            gearNotes,
            artistContext: tasteSummary
          });
          stream.log('video-analyser', `✓ Strumming pattern: ${videoFeedback.strummingPattern}`);
          stream.log('video-analyser', `✓ Timing consistency: ${videoFeedback.timingScore ?? 'n/a'}/10`);
          stream.log('video-analyser', `✓ Buzz risk: ${videoFeedback.buzzRisk}`);
          stream.log('video-analyser', `✓ Sound quality note: ${videoFeedback.soundNote}`);
          stream.setAgent('video', 'done', 'done');
        } catch (error) {
          stream.log('video-analyser', `⚠ Media analysis failed: ${error.message} — continuing without it`);
          stream.setAgent('video', 'done', 'skipped');
        }
      }
    } else {
      stream.log('orchestrator', 'No video provided — skipping clip analysis, using profile + taste data only');
      stream.setAgent('video', 'done', 'skipped');
      stream.progress(20);
    }

    stream.log('orchestrator', 'Spawning 3 TinyFish web agents in parallel');
    stream.setAgent('tab', 'active', 'scraping');
    stream.setAgent('forum', 'active', 'mining');

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
          knownChords,
          { onEvent: createTinyFishLogBridge(stream, 'tab-scraper', `tab search for ${query}`) }
        )));
        const fulfilled = results.filter(result => result.status === 'fulfilled').map(result => result.value);
        const merged = mergeTabResults(fulfilled, preferredArtists);
        stream.log('tab-scraper', `✓ ${merged.songs.length} candidate songs extracted, artist-prioritised and chord-filtered`);
        stream.setAgent('tab', 'done', 'done');
        return merged;
      })(),

      (async () => {
        stream.log('forum-miner', '→ Navigating r/guitarlessons — mining beginner difficulty threads');
        stream.log('forum-miner', '→ Lightweight mode: r/guitarlessons only, one artist/query');
        const forumTargets = songQueries.slice(0, 1);
        const results = await Promise.allSettled(forumTargets.map(query => scrapeSongForums(
          query,
          knownChords,
          { onEvent: createTinyFishLogBridge(stream, 'forum-miner', `forum search for ${query}`) }
        )));
        const fulfilled = results.filter(result => result.status === 'fulfilled').map(result => result.value);
        const merged = mergeForumResults(fulfilled);
        stream.log('forum-miner', `✓ Difficulty intel collected from ${merged.sourceCount} forum threads`);
        stream.setAgent('forum', 'done', 'done');
        return merged;
      })(),

      (async () => {
        stream.log('gear-intel', `→ Profile: "${guitar}, ${normalisedExtras.join(', ')}" — querying budget guitar communities`);
        stream.log('gear-intel', '→ Lightweight mode: r/acousticguitar only');
        const result = await scrapeGearForums(
          guitar,
          normalisedExtras,
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

    stream.setAgent('synth', 'active', 'synthesising');
    stream.log('synthesiser', `Merging scraped data with ${videoFeedback ? 'clip analysis + ' : ''}taste profile`);
    stream.log('synthesiser', 'Calling OpenAI to generate personalised roadmap');
    stream.progress(82);

    const roadmap = await synthesiseRoadmap({
      profile: {
        artists,
        genres: normaliseArray(genres),
        chords: knownChords,
        guitar,
        extras: normalisedExtras,
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

    job.status = 'succeeded';
    job.progress = 100;
    job.completedAt = new Date().toISOString();
    job.result = roadmap;
    job.error = null;
    job.agents.synth = { status: 'done', text: 'done' };
    stream.log('synthesiser', `✓ Roadmap ready — ${roadmap.songs.length} songs, ${roadmap.nextChords.length} new chords to learn`);
  } catch (error) {
    job.status = 'failed';
    job.error = error.message || 'Unexpected server error';
    job.completedAt = new Date().toISOString();
    job.agents.synth = job.agents.synth?.status === 'done'
      ? job.agents.synth
      : { status: 'active', text: 'failed' };
    stream.log('synthesiser', `⚠ Job failed: ${job.error}`);
  } finally {
    await cleanupJobArtifacts(job);
    await stream.flush();
    await writeJob(job);
  }
}
