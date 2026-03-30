# 🎸 HonestGuitar

> **Learn songs you can actually play, on the guitar you actually have.**

A full-stack autonomous web agent built for the **TinyFish × OpenAI Hackathon, Singapore**.

---

## What It Does

HonestGuitar is a multi-agent system that:

1. **Analyses your playing** — Upload or record a short video. Gemini analyses both the clip and its extracted audio for strumming pattern, timing, buzz risk, dynamics, and visible technique.
2. **Imports your taste** — Optional Spotify PKCE login pulls your top artists and tracks so recommendations are grounded in what you actually listen to.
3. **Scrapes the live web** — Three TinyFish agents browse Ultimate Guitar, Chordify, Reddit (r/guitarlessons, r/Guitar), JustGuitar, and Sweetwater in real time. No pre-loaded data.
4. **Filters honestly** — Removes any song with barre chords you can't play. Flags hidden difficulty spikes sourced from real beginner forum reports.
5. **Builds a roadmap** — OpenAI GPT-4o synthesises everything into a personalised progressive curriculum. Each song teaches exactly one new chord.
6. **Checks your gear** — Scrapes budget guitar communities to give honest, realistic tone notes for your specific setup. No pretending a $50 acoustic sounds like a Martin.

---

## Architecture

```
Frontend (honestguitar.html)
  ↓ POST /api/analyse (multipart: video + profile JSON)
Backend (server.js) — Express + SSE streaming
  ├── videoAnalyser.js          — Gemini video + audio analysis
  ├── webAgent.js               — TinyFish scraping (tabs + forums + gear)
  └── synthesiser.js            — OpenAI GPT-4o synthesis
```

The backend streams agent logs back to the browser via **Server-Sent Events (SSE)** so the user watches the agents work in real time.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (no framework — fast to iterate) |
| Backend | Node.js 18+ / Express |
| Web scraping | TinyFish API (anti-bot, JS-rendered pages) |
| Media analysis | Gemini video + audio understanding |
| Music taste import | Spotify Web API (PKCE) |
| Synthesis | OpenAI GPT-4o |
| Media processing | fluent-ffmpeg (audio extraction) |

---

## Quick Start

### Prerequisites
- Node.js 18+
- ffmpeg installed (`brew install ffmpeg` / `apt install ffmpeg`)
- API keys for TinyFish, OpenAI, and Gemini
- A Spotify app client ID if you want taste import

### Setup

```bash
# Clone / navigate to project
cd honestguitar

# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your keys

# Start the server
npm start
# → http://localhost:3001
```

### Environment Variables

```bash
# .env
TINYFISH_API_KEY=your_tinyfish_key_here
OPENAI_API_KEY=your_openai_key_here
MEDIA_ANALYSIS_PROVIDER=gemini
OPENAI_VISION_MODEL=gpt-4o-mini
OPENAI_AUDIO_MODEL=gpt-audio-mini
GEMINI_API_KEY=your_gemini_key_here
GEMINI_MEDIA_MODEL=gemini-2.5-flash
SPOTIFY_CLIENT_ID=your_spotify_client_id_here
BLOB_READ_WRITE_TOKEN=your_vercel_blob_read_write_token
BLOB_ACCESS_MODE=public
USE_BLOB_STORE_LOCALLY=0
PORT=3001
```

---

## API Reference

### `POST /api/analyse`
Main pipeline. Accepts `multipart/form-data`.

**Fields:**
- `video` (file, optional) — Video file for Gemini clip + audio analysis
- `profile` (string) — JSON string with user profile

**Profile schema:**
```json
{
  "artists": "Arctic Monkeys, Radiohead",
  "genres": ["indie rock", "alternative"],
  "chords": ["G", "C", "D", "Em"],
  "guitar": "cheap acoustic",
  "extras": ["basic capo", "standard strings"],
  "gearNotes": "high action, slightly buzzy",
  "spotify": {
    "topArtists": ["Phoebe Bridgers", "Radiohead"],
    "topTracks": ["Motion Sickness", "No Surprises"]
  }
}
```

**Response:** Server-Sent Events stream
```
data: {"type":"log","agent":"tab-scraper","message":"→ Navigating ultimate-guitar.com..."}
data: {"type":"progress","pct":45}
data: {"type":"result","data":{...roadmap}}
```

### `POST /api/scrape-song`
On-demand deep dive for a single song (called when user expands a card).

```json
{ "title": "Wonderwall", "artist": "Oasis", "chords": ["G","C","D"], "guitar": "cheap acoustic" }
```

### `GET /api/health`
Health check. Returns `{"status":"ok"}`.

---

## Hackathon Demo Script

**Setup before demo:**
1. `npm start` running on your laptop
2. Have a 20-second guitar video ready on your phone
3. Pre-fill the form: Arctic Monkeys + G, C, D, Em + cheap acoustic
4. Optional: connect Spotify and show top artists imported into the taste box

**Demo flow (3 minutes):**
1. Show the input form — explain the three inputs
2. Upload the video — mention Gemini is about to analyse the clip and extracted audio
3. Hit "Launch agents" — watch the live terminal log as TinyFish browses
4. Show the agent cards updating: Performance analysis → Tab scraper → Forum miner → Synthesiser
5. Results appear: walk through the Gemini clip-analysis panel first, then a song card
6. Expand the gear roadmap — show the $8 string upgrade tip

**Judge Q: "Why TinyFish?"**
> "Ultimate Guitar uses heavy bot protection and dynamic rendering — Puppeteer fails, BeautifulSoup fails. TinyFish is the only tool that can actually get chord data at runtime without a pre-built scraper. Same for Reddit JSON endpoints — rate-limited aggressively without proper session management."

**Judge Q: "What's the business case?"**
> "600 million people globally say they want to learn guitar. 90% quit in the first year. The number one reason: they start songs they can't finish. HonestGuitar is the only tool that filters against real playing ability AND real gear constraints, sourced from the same forums where beginners actually report what's hard."

---

## Project Structure

```
honestguitar/
├── server.js                  # Express server + SSE orchestrator
├── videoAnalyser.js           # Gemini clip + audio analysis
├── webAgent.js                # TinyFish scraping (3 agents)
├── synthesiser.js             # OpenAI GPT-4o synthesis
├── honestguitar.html          # Full frontend (single file)
├── package.json
├── .env.example
└── README.md
```

---

## TinyFish Hackathon Criteria Checklist

| Criterion | How HonestGuitar addresses it |
|---|---|
| **Hard real-world problem** | Millions of beginners quit guitar because tutorials ignore their actual constraints |
| **Open web as database** | Zero pre-loaded data — every result sourced live from tabs, forums, gear communities |
| **Complex data extraction** | Ultimate Guitar + Chordify are anti-bot, dynamically rendered — TinyFish is essential |
| **Autonomous research** | Agent navigates 6+ sources, synthesises beginner forum reports into structured intel |
| **Social intel** | Mines Reddit sentiment on song difficulty from hundreds of real beginner reports |
| **Technical complexity** | Multi-agent orchestration, Gemini media analysis, Spotify PKCE, SSE streaming, chord graph filtering |
| **Utility** | Immediately usable by any beginner guitarist — massive addressable audience |
| **High-leverage** | Extracting unstructured human knowledge from the messy web — the exact TinyFish use case |

---

*Built at TinyFish × OpenAI Hackathon, Singapore*
