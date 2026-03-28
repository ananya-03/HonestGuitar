/**
 * HonestGuitar — TinyFish Web Agent
 *
 * Uses TinyFish browser automation with SSE streaming so each scrape appears
 * as a real TinyFish automation run and can emit live progress updates.
 */

const TINYFISH_BASE = 'https://agent.tinyfish.ai/v1';
const TINYFISH_KEY = process.env.TINYFISH_API_KEY || process.env.TINY_FISH_API_KEY;
const AUTOMATION_PROFILES = ['lite'];
const DEFAULT_PROXY_CONFIG = {
  enabled: true,
  country_code: 'US'
};

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function tryParseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch {}
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {}
  }

  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {}
  }

  return null;
}

function hasMeaningfulValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') {
    return Object.values(value).some(hasMeaningfulValue);
  }
  return Boolean(String(value || '').trim());
}

function extractStructuredResult(value) {
  if (value == null) return null;

  const direct = tryParseJson(value);
  if (direct && typeof direct === 'object') return direct;

  if (typeof value === 'object') {
    const candidates = [
      value.resultJson,
      value.result,
      value.output,
      value.data,
      value.final_output,
      value.response,
      value.content,
      value.text
    ];

    for (const candidate of candidates) {
      const parsed = tryParseJson(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  }

  return null;
}

function normaliseSseEvent(event, browserProfile) {
  return {
    ...event,
    browserProfile,
    runId: event?.run_id || event?.runId || null,
    purpose: event?.purpose || event?.message || null
  };
}

async function consumeTinyFishSse(response, browserProfile, onEvent) {
  if (!response.body) throw new Error('TinyFish SSE response body missing');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalEvent = null;

  const flushChunk = chunk => {
    const dataLines = chunk
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(Boolean);

    if (!dataLines.length) return;

    let parsed;
    try {
      parsed = JSON.parse(dataLines.join('\n'));
    } catch {
      parsed = { type: 'MESSAGE', raw: dataLines.join('\n') };
    }

    const event = normaliseSseEvent(parsed, browserProfile);
    onEvent?.(event);

    if (event.type === 'COMPLETE') {
      finalEvent = event;
      return;
    }

    if (event.type === 'ERROR' || event.status === 'FAILED') {
      throw new Error(event.message || event.error?.message || 'TinyFish automation failed');
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || '';

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      flushChunk(chunk);
    }

    if (done) break;
  }

  if (buffer.trim()) flushChunk(buffer);
  if (!finalEvent) throw new Error(`TinyFish ${browserProfile} run ended without a COMPLETE event`);
  return finalEvent;
}

async function runTinyFishAutomationOnce({ url, goal, browserProfile, onEvent }) {
  if (!TINYFISH_KEY) throw new Error('TINYFISH_API_KEY not set');

  onEvent?.({
    type: 'PROFILE_ATTEMPT',
    browserProfile,
    purpose: `Launching ${browserProfile} automation`
  });

  const response = await fetch(`${TINYFISH_BASE}/automation/run-sse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': TINYFISH_KEY
    },
    body: JSON.stringify({
      url,
      goal,
      browser_profile: browserProfile,
      proxy_config: DEFAULT_PROXY_CONFIG,
      api_integration: 'honestguitar'
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`TinyFish ${browserProfile} error ${response.status}: ${errorText}`);
  }

  const finalEvent = await consumeTinyFishSse(response, browserProfile, onEvent);
  const structuredResult = extractStructuredResult(finalEvent.resultJson || finalEvent.result || finalEvent);

  if (!hasMeaningfulValue(structuredResult)) {
    throw new Error(`TinyFish ${browserProfile} completed without structured JSON output`);
  }

  return structuredResult;
}

async function runTinyFishAutomation({ url, instructions, outputShape, onEvent }) {
  let lastError = null;
  const goal = compactWhitespace(`
    ${instructions}
    Return strict JSON only. Do not wrap the answer in markdown.
    If data is missing, use empty arrays or nulls instead of prose.
    Required JSON shape:
    ${JSON.stringify(outputShape)}
  `);

  for (const browserProfile of AUTOMATION_PROFILES) {
    try {
      return await runTinyFishAutomationOnce({
        url,
        goal,
        browserProfile,
        onEvent
      });
    } catch (error) {
      lastError = error;
      onEvent?.({
        type: 'PROFILE_FALLBACK',
        browserProfile,
        purpose: error.message
      });
    }
  }

  throw lastError || new Error('TinyFish automation failed');
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean).map(value => String(value).trim()).filter(Boolean))];
}

// ─── 1. Scrape chord tabs ─────────────────────────────────────────────────────
export async function scrapeTabsAndChords(artistQuery, knownChords = [], options = {}) {
  const BARRE_CHORDS = ['F', 'Bm', 'Bb', 'B', 'F#m', 'C#m', 'G#m', 'Ab', 'Eb', 'Db'];
  const canPlayBarre = knownChords.some(c => BARRE_CHORDS.includes(c));

  const ugData = await runTinyFishAutomation({
    url: `https://www.ultimate-guitar.com/search.php?search_type=title&value=${encodeURIComponent(artistQuery)}&type=Chords`,
    instructions: `
      Extract a list of songs from the search results.
      For each song include: title, artist, chords, difficulty, votes, url.
      Prefer chord pages with meaningful vote counts.
      Return up to 15 songs.
    `,
    outputShape: {
      songs: [{
        title: '',
        artist: '',
        chords: [],
        difficulty: '',
        votes: 0,
        url: ''
      }]
    },
    onEvent: options.onEvent
  });

  const allSongs = ugData?.songs || [];

  const seen = new Set();
  const unique = allSongs.filter(song => {
    const key = `${song.title?.toLowerCase()}-${song.artist?.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const filtered = unique.filter(song => {
    const songChords = (song.chords || []).map(chord => chord.trim()).filter(Boolean);

    if (!canPlayBarre) {
      const hasHardBarre = songChords.some(chord => BARRE_CHORDS.includes(chord) && !knownChords.includes(chord));
      if (hasHardBarre) return false;
    }

    const newChords = songChords.filter(chord => !knownChords.includes(chord));
    return newChords.length >= 1 && newChords.length <= 2;
  });

  return {
    songs: filtered.slice(0, 15),
    raw: unique.slice(0, 30),
    sources: ['ultimate-guitar.com', 'chordify.net']
  };
}

// ─── 2. Scrape forums for beginner tips ───────────────────────────────────────
export async function scrapeSongForums(songQuery, knownChords = [], options = {}) {
  const guitarLessons = await runTinyFishAutomation({
    url: `https://www.reddit.com/r/guitarlessons/search/?q=${encodeURIComponent(songQuery + ' beginner')}&sort=relevance`,
    instructions: `
      Extract beginner-focused insights about learning this song on guitar.
      Focus on specific hard transitions, common mistakes, useful beginner tips,
      and hidden difficulty spikes. Ignore generic encouragement.
    `,
    outputShape: {
      threads: [{
        title: '',
        tips: [],
        hard_spots: [],
        capo_alternatives: [],
        upvotes: 0
      }]
    },
    onEvent: options.onEvent
  });

  const allTips = [];
  const allHardSpots = [];
  const allCapoAlts = [];
  let sourceCount = 0;

  const threads = guitarLessons?.threads || [];
  threads.forEach(thread => {
    allTips.push(...(thread.tips || []));
    allHardSpots.push(...(thread.hard_spots || []));
    allCapoAlts.push(...(thread.capo_alternatives || []));
  });
  sourceCount += threads.length;

  return {
    tips: uniqueStrings(allTips).slice(0, 20),
    hardSpots: uniqueStrings(allHardSpots).slice(0, 10),
    capoAlternatives: uniqueStrings(allCapoAlts).slice(0, 5),
    sourceCount,
    sources: ['r/guitarlessons']
  };
}

// ─── 3. Scrape gear intel ─────────────────────────────────────────────────────
export async function scrapeGearForums(guitar, extras = [], gearNotes = '', options = {}) {
  const gearQuery = `${guitar} ${extras.join(' ')} ${gearNotes}`.trim();

  const acousticReddit = await runTinyFishAutomation({
    url: `https://www.reddit.com/r/acousticguitar/search/?q=${encodeURIComponent('cheap acoustic guitar tips sound better ' + gearQuery)}&sort=top`,
    instructions: `
      Extract practical tips for improving sound on a cheap or budget acoustic guitar.
      Focus on cheap upgrades, string changes, setup advice, realistic expectations,
      and technique changes that help on cheap guitars.
      Ignore vague advice that just says to buy a better guitar.
    `,
    outputShape: {
      tips: [],
      cheap_upgrades: [{
        item: '',
        cost_estimate: '',
        impact: ''
      }],
      realistic_expectations: [],
      technique_adjustments: []
    },
    onEvent: options.onEvent
  });

  const tips = [];
  const upgrades = [];
  const techniqueAdjustments = [];

  tips.push(...(acousticReddit?.tips || []));
  tips.push(...(acousticReddit?.realistic_expectations || []));
  upgrades.push(...(acousticReddit?.cheap_upgrades || []));
  techniqueAdjustments.push(...(acousticReddit?.technique_adjustments || []));

  return {
    tips: uniqueStrings(tips).slice(0, 15),
    upgrades: upgrades.slice(0, 5),
    techniqueAdjustments: uniqueStrings(techniqueAdjustments).slice(0, 8),
    sources: ['r/acousticguitar']
  };
}
