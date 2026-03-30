/**
 * HonestGuitar — Synthesiser Agent
 *
 * Takes raw output from all agents (video analysis, tab scraping, forum mining,
 * gear intel) and uses OpenAI GPT-4o to synthesise it into a personalised,
 * honest guitar learning roadmap.
 */

import OpenAI from 'openai';

const ROADMAP_MODEL = process.env.ROADMAP_MODEL || 'gpt-4o';
const ROADMAP_FALLBACK_MODEL = process.env.ROADMAP_FALLBACK_MODEL || 'gpt-4o-mini';
const ROADMAP_TIMEOUT_MS = Math.max(30_000, Number(process.env.ROADMAP_TIMEOUT_MS || 180_000));
const SONG_TIPS_TIMEOUT_MS = Math.max(15_000, Number(process.env.SONG_TIPS_TIMEOUT_MS || 90_000));

function getOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: ROADMAP_TIMEOUT_MS,
    maxRetries: 1
  });
}

function parseJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {}

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return JSON.parse(fencedMatch[1].trim());
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    return JSON.parse(objectMatch[0]);
  }

  throw new Error('Synthesis failed to produce valid JSON: ' + text.slice(0, 200));
}

function normaliseDifficultyScore(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'easy') return 3;
  if (raw === 'hard') return 7;
  if (raw === 'medium') return 5;
  return 4;
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean).map(item => String(item).trim()).filter(Boolean))];
}

function buildSimplifiedVersion(newChord) {
  if (!newChord) return null;
  if (['F', 'Bm', 'Bb', 'B'].includes(newChord)) {
    return `Use a simplified ${newChord} shape first and add the full barre once the song feels steady.`;
  }
  return `Strip the rhythm back and isolate the ${newChord} change before adding the full groove.`;
}

function buildPracticeApproach(song, newChord) {
  const progression = (song.chords || []).slice(0, 4).join(' - ');
  if (progression) {
    return `Spend 3 minutes drilling ${newChord}, 3 minutes looping ${progression} slowly, and 4 minutes playing the song with a metronome.`;
  }
  return `Spend 4 minutes drilling ${newChord}, then 6 minutes alternating between the hardest change and a slow full-song run-through.`;
}

function formatCheapUpgrade(upgrade) {
  if (!upgrade?.item) return null;
  const cost = upgrade.cost_estimate ? ` (${upgrade.cost_estimate})` : '';
  const impact = upgrade.impact ? ` — ${upgrade.impact}` : '';
  return `${upgrade.item}${cost}${impact}`;
}

function buildDeterministicRoadmap({ profile, videoFeedback, tabs, forums, gear }) {
  const knownChords = uniqueStrings(profile.chords || []);
  const preferredArtists = uniqueStrings(profile.preferredArtists || []);
  const preferredSet = new Set(preferredArtists.map(name => name.toLowerCase()));
  const candidates = [...(tabs?.songs || [])]
    .map(song => {
      const songChords = uniqueStrings(song.chords || []);
      const unknownChords = songChords.filter(chord => !knownChords.includes(chord));
      return {
        ...song,
        songChords,
        unknownChords,
        preferredArtist: Boolean(song.preferredArtist || preferredSet.has(String(song.artist || '').toLowerCase()))
      };
    })
    .filter(song => song.unknownChords.length >= 1)
    .sort((a, b) => {
      if (a.preferredArtist !== b.preferredArtist) return a.preferredArtist ? -1 : 1;
      if (a.unknownChords.length !== b.unknownChords.length) return a.unknownChords.length - b.unknownChords.length;
      return (b.votes || 0) - (a.votes || 0);
    });

  const selectedSongs = candidates.slice(0, 6);
  const nextChords = uniqueStrings(selectedSongs.flatMap(song => song.unknownChords)).slice(0, 4);
  const primaryGearTip = gear?.tips?.[0] || `On a ${profile.guitar}, clean fretting and lighter attack will matter more than chasing fancy tone.`;
  const cheapUpgrade = formatCheapUpgrade(gear?.upgrades?.[0]);
  const forumTip = forums?.tips?.[0] || null;

  return {
    summary: `You're building from ${knownChords.length ? knownChords.join(', ') : 'a small chord base'} toward songs that match ${profile.artists || (profile.genres || []).join(', ') || 'your current taste'} on a ${profile.guitar}.`,
    videoInsight: videoFeedback?.overallAssessment || null,
    knownChords,
    nextChords,
    songs: selectedSongs.map((song, index) => {
      const newChord = song.unknownChords[0] || nextChords[index] || 'one new chord';
      return {
        title: song.title || `Song ${index + 1}`,
        artist: song.artist || 'Unknown artist',
        newChord,
        chordProgression: song.songChords.slice(0, 4).join(' - '),
        difficulty: song.difficulty || (song.unknownChords.length > 1 ? 'medium' : 'easy'),
        difficultyScore: normaliseDifficultyScore(song.difficulty),
        whyYoullLoveIt: song.preferredArtist
          ? `This keeps you close to the artists you already like while adding just one new shape at a time.`
          : `This is a realistic next-step song for your current chord set and listening taste.`,
        hardSpots: (forums?.hardSpots || []).slice(0, 2).length
          ? (forums.hardSpots || []).slice(0, 2)
          : [`The main pressure point will be landing ${newChord} cleanly inside the progression.`],
        capoPosition: null,
        simplifiedVersion: buildSimplifiedVersion(newChord),
        gearNote: primaryGearTip,
        cheapUpgrade,
        forumQuote: forumTip,
        practiceApproach: buildPracticeApproach(song, newChord),
        sources: uniqueStrings([...(song.sources || []), ...(tabs?.sources || []), ...(forums?.sources || [])]),
        animDelay: index * 0.07
      };
    }),
    videoFeedbackHighlights: {
      topWin: videoFeedback?.positives?.[0] || null,
      topFix: videoFeedback?.topImprovements?.[0] || null,
      strummingTip: videoFeedback?.strumHandNotes || null
    },
    gearRoadmap: {
      currentSetup: `Current setup: ${profile.guitar}${profile.extras?.length ? ` with ${profile.extras.join(', ')}` : ''}${profile.gearNotes ? ` (${profile.gearNotes})` : ''}.`,
      immediateWin: cheapUpgrade || primaryGearTip,
      threeMonthUpgrade: formatCheapUpgrade(gear?.upgrades?.[1]) || 'Get a basic setup or fresh strings before buying bigger upgrades.',
      sixMonthUpgrade: formatCheapUpgrade(gear?.upgrades?.[2]) || 'Upgrade only after you can hear a repeatable limitation in your current setup.'
    },
    synthesisFallback: true
  };
}

async function requestRoadmapCompletion({ model, profile, videoFeedback, tabs, forums, gear, compact = false, maxTokens = 2200, timeoutMs = ROADMAP_TIMEOUT_MS }) {
  const { artists, genres, chords, guitar, extras, spotify = {}, preferredArtists = [] } = profile;
  const context = buildContext({ profile, videoFeedback, tabs, forums, gear, compact });

  const systemPrompt = `You are HonestGuitar's synthesis engine — a no-bullshit guitar coach for beginners.

You receive raw data from three web agents that just scraped the internet:
- A chord tab scraper (Ultimate Guitar, Chordify)
- A forum intelligence miner (Reddit r/guitarlessons, r/Guitar, JustGuitar)
- A gear community scraper (r/acousticguitar, Sweetwater)
${spotify.topArtists?.length ? '- A Spotify taste import containing the user\'s top artists and tracks' : ''}
${videoFeedback ? '- A clip analysis of the user\'s actual playing' : ''}

Your job is to synthesise all of this into a personalised learning roadmap.

CRITICAL RULES:
1. Every song must require EXACTLY ONE chord the user does not already know when possible
2. NEVER recommend songs with barre chords the user hasn't declared knowing
3. Be brutally honest about cheap gear
4. Hard spots must come from the supplied forum intelligence when available
5. Gear notes must be specific to their setup (${guitar}, ${(extras || []).join(', ')})
6. Songs must genuinely match their taste (${artists || (genres || []).join(', ')})
7. Order songs from easiest to hardest
8. If preferred artists are available (${preferredArtists.join(', ')}), prioritise them first

Return ONLY valid JSON matching this exact schema:`;

  const schema = `{
  "summary": "One sentence describing this person's learning path and current level",
  "videoInsight": "One honest sentence about their playing from the clip, or null if no clip",
  "knownChords": ["array of chords user knows"],
  "nextChords": ["3-4 new chords in recommended learning order"],
  "songs": [
    {
      "title": "Song Title",
      "artist": "Artist Name",
      "newChord": "The ONE new chord this teaches",
      "chordProgression": "e.g. G - Em - C - D",
      "difficulty": "easy|medium|hard",
      "difficultyScore": 4,
      "whyYoullLoveIt": "Sentence connecting to their taste and why this specific song",
      "hardSpots": ["Specific real transition or trap"],
      "capoPosition": 2,
      "simplifiedVersion": "How to simplify it or null",
      "gearNote": "Honest note for their exact setup",
      "cheapUpgrade": "One specific cheap upgrade or null",
      "forumQuote": "Paraphrased real tip from the supplied community intel or null",
      "practiceApproach": "Specific 10-minute practice structure for this song",
      "sources": ["r/guitarlessons", "Ultimate Guitar", "Chordify"]
    }
  ],
  "videoFeedbackHighlights": {
    "topWin": "Best thing about their playing or null",
    "topFix": "Single most impactful thing to fix or null",
    "strummingTip": "Specific tip tailored to what was seen/heard in the clip or null"
  },
  "gearRoadmap": {
    "currentSetup": "Honest description of their current setup",
    "immediateWin": "Cheapest thing they can do right now for biggest improvement",
    "threeMonthUpgrade": "Best ~$30-50 upgrade in 3 months",
    "sixMonthUpgrade": "Best investment once they're more serious"
  }
}`;

  const completion = await getOpenAIClient().chat.completions.create({
    model,
    max_tokens: maxTokens,
    temperature: compact ? 0.25 : 0.4,
    messages: [
      { role: 'system', content: `${systemPrompt}\n\n${schema}` },
      { role: 'user', content: `Here is the aggregated data from all agents:\n\n${context}\n\nGenerate the HonestGuitar roadmap JSON. Return ONLY the JSON object, no markdown, no explanation.` }
    ],
    response_format: { type: 'json_object' }
  }, {
    timeout: timeoutMs,
    maxRetries: 1
  });

  const roadmap = parseJsonObject(completion.choices[0].message.content || '{}');
  roadmap.songs = (roadmap.songs || []).map((song, index) => ({ ...song, animDelay: index * 0.07 }));
  return roadmap;
}

// ─── Main roadmap synthesiser ─────────────────────────────────────────────────
export async function synthesiseRoadmap({ profile, videoFeedback, tabs, forums, gear }) {
  try {
    return await requestRoadmapCompletion({
      model: ROADMAP_MODEL,
      profile,
      videoFeedback,
      tabs,
      forums,
      gear
    });
  } catch (primaryError) {
    try {
      return await requestRoadmapCompletion({
        model: ROADMAP_FALLBACK_MODEL,
        profile,
        videoFeedback,
        tabs,
        forums,
        gear,
        compact: true,
        maxTokens: 1400,
        timeoutMs: Math.min(ROADMAP_TIMEOUT_MS, 90_000)
      });
    } catch (fallbackError) {
      console.error('Roadmap synthesis fell back to deterministic mode:', {
        primary: primaryError?.message || primaryError,
        fallback: fallbackError?.message || fallbackError
      });
      return buildDeterministicRoadmap({ profile, videoFeedback, tabs, forums, gear });
    }
  }
}

// ─── On-demand single song deep dive ─────────────────────────────────────────
export async function synthesiseSongTips({ title, artist, userChords, forumTips, gearTips, guitar }) {
  const completion = await getOpenAIClient().chat.completions.create({
    model: ROADMAP_FALLBACK_MODEL,
    max_tokens: 1000,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: `You are HonestGuitar providing a deep-dive on a specific song. 
Return ONLY JSON with: hardSpots (array), practiceSequence (array of steps), gearSpecificTips (array), timeEstimate (string), forumConsensus (string).`
      },
      {
        role: 'user',
        content: `Song: "${title}" by ${artist}
User knows: ${(userChords || []).join(', ')}
Guitar: ${guitar}
Forum data: ${JSON.stringify(forumTips?.tips?.slice(0,8) || [])}
Gear tips: ${JSON.stringify(gearTips?.tips?.slice(0,5) || [])}

Generate the deep-dive JSON.`
      }
    ],
    response_format: { type: 'json_object' }
  }, {
    timeout: SONG_TIPS_TIMEOUT_MS,
    maxRetries: 1
  });

  return parseJsonObject(completion.choices[0].message.content || '{}');
}

// ─── Build context string from all agent outputs ──────────────────────────────
function buildContext({ profile, videoFeedback, tabs, forums, gear, compact = false }) {
  const lines = [];
  const songLimit = compact ? 6 : 12;
  const tipLimit = compact ? 6 : 10;
  const hardSpotLimit = compact ? 4 : 6;
  const gearTipLimit = compact ? 5 : 8;
  const adjustmentLimit = compact ? 3 : 5;

  lines.push('=== USER PROFILE ===');
  lines.push(`Artists/genres: ${profile.artists || profile.genres.join(', ')}`);
  lines.push(`Known chords: ${profile.chords.join(', ')}`);
  lines.push(`Guitar: ${profile.guitar}`);
  lines.push(`Extras: ${profile.extras.join(', ')}`);
  if (profile.gearNotes) lines.push(`Gear notes: ${profile.gearNotes}`);
  if (profile.spotify?.topArtists?.length) {
    lines.push(`Spotify top artists: ${profile.spotify.topArtists.join(', ')}`);
  }
  if (profile.spotify?.topTracks?.length) {
    lines.push(`Spotify top tracks: ${profile.spotify.topTracks.join(', ')}`);
  }
  if (profile.preferredArtists?.length) {
    lines.push(`Preferred artists in priority order: ${profile.preferredArtists.join(', ')}`);
  }

  if (videoFeedback) {
    lines.push('\n=== CLIP ANALYSIS ===');
    lines.push(`Strumming pattern: ${videoFeedback.strummingPattern}`);
    lines.push(`Strumming score: ${videoFeedback.strummingScore}/10`);
    lines.push(`Timing: ${videoFeedback.timingConsistency} (${videoFeedback.timingScore}/10)`);
    lines.push(`Hand position: ${videoFeedback.handPositionNotes}`);
    lines.push(`Transitions: ${videoFeedback.transitionFeedback}`);
    lines.push(`Sound note: ${videoFeedback.soundNote}`);
    lines.push(`Buzz risk: ${videoFeedback.buzzRisk}`);
    lines.push(`Buzz notes: ${videoFeedback.buzzNotes}`);
    lines.push(`Rhythm notes: ${videoFeedback.rhythmNotes}`);
    lines.push(`Dynamics: ${videoFeedback.dynamicsNotes}`);
    lines.push(`Posture summary: ${videoFeedback.postureSummary}`);
    if (!compact && videoFeedback.visualCorrections?.length) {
      lines.push('Visual corrections:');
      videoFeedback.visualCorrections.slice(0, 3).forEach(correction => {
        lines.push(`  ✗ ${correction.focusArea}: ${correction.wrong}`);
        lines.push(`  ✓ ${correction.focusArea}: ${correction.correct}`);
      });
    }
    lines.push(`Top improvements: ${videoFeedback.topImprovements?.join(' | ')}`);
    lines.push(`Positives: ${videoFeedback.positives?.join(' | ')}`);
    lines.push(`Overall: ${videoFeedback.overallAssessment}`);
  }

  if (tabs?.songs?.length > 0) {
    lines.push('\n=== SCRAPED SONGS (Tab agents) ===');
    tabs.songs.slice(0, songLimit).forEach(s => {
      lines.push(`- "${s.title}" by ${s.artist} | Preferred artist: ${s.preferredArtist ? 'yes' : 'no'} | Chords: ${(s.chords||[]).join(', ')} | Difficulty: ${s.difficulty}`);
    });
  }

  if (forums?.tips?.length > 0) {
    lines.push('\n=== FORUM INTELLIGENCE (Reddit + JustGuitar) ===');
    lines.push('Beginner tips from community:');
    forums.tips.slice(0, tipLimit).forEach(t => lines.push(`  • ${t}`));
    if (forums.hardSpots?.length > 0) {
      lines.push('Common hard spots reported:');
      forums.hardSpots.slice(0, hardSpotLimit).forEach(h => lines.push(`  ⚠ ${h}`));
    }
    if (forums.capoAlternatives?.length > 0) {
      lines.push('Capo alternatives mentioned:');
      forums.capoAlternatives.forEach(c => lines.push(`  🎸 ${c}`));
    }
  }

  if (gear?.tips?.length > 0) {
    lines.push('\n=== GEAR INTEL (Budget guitar communities) ===');
    gear.tips.slice(0, gearTipLimit).forEach(t => lines.push(`  • ${t}`));
    if (gear.upgrades?.length > 0) {
      lines.push('Cheap upgrades from community:');
      gear.upgrades.slice(0, compact ? 3 : 5).forEach(u => lines.push(`  💡 ${u.item} (~${u.cost_estimate}) — ${u.impact}`));
    }
    if (gear.techniqueAdjustments?.length > 0) {
      lines.push('Technique adjustments for cheap gear:');
      gear.techniqueAdjustments.slice(0, adjustmentLimit).forEach(t => lines.push(`  🔧 ${t}`));
    }
  }

  return lines.join('\n');
}
