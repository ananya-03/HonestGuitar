/**
 * HonestGuitar — Synthesiser Agent
 *
 * Takes raw output from all agents (video analysis, tab scraping, forum mining,
 * gear intel) and uses OpenAI GPT-4o to synthesise it into a personalised,
 * honest guitar learning roadmap.
 */

import OpenAI from 'openai';

function getOpenAIClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── Main roadmap synthesiser ─────────────────────────────────────────────────
export async function synthesiseRoadmap({ profile, videoFeedback, tabs, forums, gear }) {
  const { artists, genres, chords, guitar, extras, gearNotes, spotify = {}, preferredArtists = [] } = profile;

  // Build a rich context blob from all agent outputs
  const context = buildContext({ profile, videoFeedback, tabs, forums, gear });

  const systemPrompt = `You are HonestGuitar's synthesis engine — a no-bullshit guitar coach for beginners.

You receive raw data from three web agents that just scraped the internet:
- A chord tab scraper (Ultimate Guitar, Chordify)
- A forum intelligence miner (Reddit r/guitarlessons, r/Guitar, JustGuitar)
- A gear community scraper (r/acousticguitar, Sweetwater)
${spotify.topArtists?.length ? '- A Spotify taste import containing the user\'s top artists and tracks' : ''}
${videoFeedback ? '- A Gemini audio + video analysis of the user\'s actual playing clip' : ''}

Your job is to synthesise all of this into a personalised learning roadmap.

CRITICAL RULES:
1. Every song must require EXACTLY ONE chord the user does not already know
2. NEVER recommend songs with barre chords the user hasn't declared knowing
3. Be brutally honest about cheap gear — don't pretend a $50 acoustic sounds like a Martin
4. The hard_spots must come from real forum reports, not generic advice
5. Gear notes must be specific to their exact setup (${guitar}, ${extras.join(', ')})
6. Songs must genuinely match their taste (${artists || genres.join(', ')})
7. Order songs from easiest to hardest — this is a progressive curriculum
8. If preferred artists are available, recommend songs by those artists first. Only fall back to adjacent artists if there are not enough playable matches.

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
      "hardSpots": [
        "Specific real transition that catches beginners e.g. 'G to C change in bar 3 — most beginners flatten their finger on the B string'",
        "Second hard spot if any"
      ],
      "capoPosition": 2,
      "simplifiedVersion": "How to simplify e.g. 'Skip the Em7 and play Em instead — sounds 90% the same' or null",
      "gearNote": "Honest note for their exact setup e.g. 'On a cheap acoustic the open G will ring well but the C chord may buzz until your calluses build'",
      "cheapUpgrade": "One specific cheap upgrade e.g. 'New set of light gauge strings ($8) — makes C chord significantly easier on high action' or null",
      "forumQuote": "Paraphrased real tip from Reddit about this song e.g. 'r/guitarlessons users say the verse rhythm is more forgiving than the chorus strum' or null",
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

  const userMessage = `Here is the aggregated data from all agents:\n\n${context}\n\nGenerate the HonestGuitar roadmap JSON. Return ONLY the JSON object, no markdown, no explanation.`;

  const completion = await getOpenAIClient().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 4000,
    temperature: 0.4,
    messages: [
      { role: 'system', content: systemPrompt + '\n\n' + schema },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' }
  });

  const raw = completion.choices[0].message.content || '{}';

  try {
    const roadmap = JSON.parse(raw);
    // Ensure songs array exists and has animation delays
    roadmap.songs = (roadmap.songs || []).map((s, i) => ({ ...s, animDelay: i * 0.07 }));
    return roadmap;
  } catch {
    throw new Error('Synthesis failed to produce valid JSON: ' + raw.slice(0, 200));
  }
}

// ─── On-demand single song deep dive ─────────────────────────────────────────
export async function synthesiseSongTips({ title, artist, userChords, forumTips, gearTips, guitar }) {
  const completion = await getOpenAIClient().chat.completions.create({
    model: 'gpt-4o',
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
  });

  return JSON.parse(completion.choices[0].message.content || '{}');
}

// ─── Build context string from all agent outputs ──────────────────────────────
function buildContext({ profile, videoFeedback, tabs, forums, gear }) {
  const lines = [];

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
    lines.push('\n=== CLIP ANALYSIS (Gemini audio + video) ===');
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
    if (videoFeedback.visualCorrections?.length) {
      lines.push('Visual corrections:');
      videoFeedback.visualCorrections.forEach(correction => {
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
    tabs.songs.slice(0, 12).forEach(s => {
      lines.push(`- "${s.title}" by ${s.artist} | Preferred artist: ${s.preferredArtist ? 'yes' : 'no'} | Chords: ${(s.chords||[]).join(', ')} | Difficulty: ${s.difficulty}`);
    });
  }

  if (forums?.tips?.length > 0) {
    lines.push('\n=== FORUM INTELLIGENCE (Reddit + JustGuitar) ===');
    lines.push('Beginner tips from community:');
    forums.tips.slice(0, 10).forEach(t => lines.push(`  • ${t}`));
    if (forums.hardSpots?.length > 0) {
      lines.push('Common hard spots reported:');
      forums.hardSpots.slice(0, 6).forEach(h => lines.push(`  ⚠ ${h}`));
    }
    if (forums.capoAlternatives?.length > 0) {
      lines.push('Capo alternatives mentioned:');
      forums.capoAlternatives.forEach(c => lines.push(`  🎸 ${c}`));
    }
  }

  if (gear?.tips?.length > 0) {
    lines.push('\n=== GEAR INTEL (Budget guitar communities) ===');
    gear.tips.slice(0, 8).forEach(t => lines.push(`  • ${t}`));
    if (gear.upgrades?.length > 0) {
      lines.push('Cheap upgrades from community:');
      gear.upgrades.forEach(u => lines.push(`  💡 ${u.item} (~${u.cost_estimate}) — ${u.impact}`));
    }
    if (gear.techniqueAdjustments?.length > 0) {
      lines.push('Technique adjustments for cheap gear:');
      gear.techniqueAdjustments.slice(0, 5).forEach(t => lines.push(`  🔧 ${t}`));
    }
  }

  return lines.join('\n');
}
