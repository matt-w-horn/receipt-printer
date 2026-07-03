// AI morning briefing → receipt. printAIMorningBriefing() pulls weather + a Gemini
// briefing (with Google Search grounding) and prints it. Shares the CMD table and
// stringToBytes with the calendar path, and sends via that path's sendToPi.

import { CMD, stringToBytes } from './escpos';
import { sendToPi } from './calendar';

// --- CONFIGURATION ---
const DRY_RUN = false; // Set to FALSE to print physically

// Persona: Clear, Professional, Smart.
const PERSONA =
  'You are a smart daily briefing assistant. Tone: Clear, professional, and natural. Do not use robotic commands. Use plain English to explain what comes next.';

interface Source {
  title: string;
  url: string;
}

interface AiResult {
  text: string;
  sources: Source[];
}

export interface WeatherData {
  current: number;
  feels_like: number;
  high: number;
  low: number;
  humidity: unknown;
  wind: number;
  uv: unknown;
  rain_chance: number;
  code: string;
  forecast: string;
  currentConditions: string;
}

export function printAIMorningBriefing(): void {
  const props = PropertiesService.getScriptProperties();
  const lat = props.getProperty('LAT');
  const lon = props.getProperty('LON');
  const geminiKey = props.getProperty('GEMINI_KEY');
  const newsKey = props.getProperty('NEWS_KEY');

  if (!lat || !geminiKey || !newsKey) {
    Logger.log('❌ Missing Configuration. Check Project Settings.');
    return;
  }

  // 1. Fetch Hardcoded Data (Ground Truth)
  // We fetch these first to give the AI a solid baseline
  Logger.log('📡 Fetching Telemetry...');
  let weatherData: WeatherData | null = null;
  //let newsData = { text: "No news signal.", sources: [] };

  try {
    weatherData = getDeepWeather(lat, lon, geminiKey);
    //newsData = fetchNewsStream(newsKey);
  } catch (e) {
    Logger.log('⚠️ Sensor malfunction: ' + e.toString());
  }

  // 2. Generate Content (Gemini 3 Pro + Search)
  Logger.log('🧠 Querying Gemini 3 Node...');

  const aiResult = generateDeepBriefing(lat, lon, geminiKey, weatherData);

  if (!aiResult) {
    Logger.log('❌ AI Generation failed.');
    return;
  }

  // --- DRY RUN ---
  if (DRY_RUN) {
    Logger.log('--- DRY RUN OUTPUT ---');
    Logger.log(`WEATHER GRID: ${weatherData ? weatherData.current + '°' : 'N/A'}`);
    Logger.log(`TEXT: \n${aiResult.text}`);
    Logger.log(`SOURCES: ${aiResult.sources.length}`);
    return;
  }

  // 3. Build & Send Payload
  const payload = buildDeepReceipt(aiResult, weatherData);
  sendToPi(payload);
}

// --- GEMINI 3 CLIENT (REST API) ---
function generateDeepBriefing(
  lat: string,
  lon: string | null,
  apiKey: string,
  wData: WeatherData | null,
): AiResult | null {
  const model = 'gemini-3-pro-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const userPrompt = `
    SYSTEM TELEMETRY (Ground Truth):
    - Location: ${lat}, ${lon}
    - Current Conditions: ${wData ? wData.code : 'Unknown'}

    MISSION:
    1. **Weather Outlook:** A natural summary of the *next 24 hours* and the *week ahead*. (Do not repeat current temp, it is already in the header).
    2. **News Sync:** Summarize 3-4 of the most critical global news stories, aiming for the most comprehensive possible look locally, nationally and globally. In your thinking, consider as many news stories as possible and then rank based on consequentalness when deciding what to surface. (This should account for about 2/3 of the text)
    3. **System Status:** A short, motivating thought.

    CONSTRAINT:
    - Max 150 words.
    - Use **Bold Headers** for sections (e.g. **Weather Outlook**).
    - Write in smooth, human-readable paragraphs.
  `;

  const payload = {
    system_instruction: { parts: [{ text: PERSONA }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],

    // Tools: CamelCase for REST
    tools: [{ googleSearch: {} }],

    // Config: Thinking Level High + Temp 1.0 (Required for Gemini 3)
    generationConfig: {
      temperature: 1.0,
      thinkingConfig: {
        thinkingLevel: 'high',
      },
    },

    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const res = UrlFetchApp.fetch(url, options);

  if (res.getResponseCode() !== 200) {
    Logger.log(`❌ Gemini API Error (${res.getResponseCode()}): ${res.getContentText()}`);
    return null;
  }

  const json = JSON.parse(res.getContentText());
  const candidate = json.candidates?.[0];

  if (!candidate) return null;

  const text = candidate.content.parts
    .map((p: { text: string }) => p.text)
    .join('')
    .trim();

  // Extract Sources (Gemini 3 Search Results)
  const sources: Source[] = [];
  if (candidate.groundingMetadata?.groundingChunks) {
    candidate.groundingMetadata.groundingChunks.forEach(
      (c: { web?: { uri?: string; title?: string } }) => {
        if (c.web?.uri) sources.push({ title: c.web.title ?? '', url: c.web.uri });
      },
    );
  }

  return { text: text, sources: sources };
}

// --- RECEIPT BUILDER ---
export function buildDeepReceipt(aiResult: AiResult, w: WeatherData | null): number[] {
  let p: number[] = [];
  const now = new Date();
  const dateStr = now
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    .toUpperCase();

  // Header
  p = p.concat(CMD.INIT, CMD.CP437, CMD.ALIGN_CENTER);
  p = p.concat(CMD.GET_BORDER_TOP());
  p = p.concat(CMD.BOLD_ON, stringToBytes(` ${dateStr} \n`), CMD.BOLD_OFF);
  p = p.concat(CMD.GET_BORDER_BOTTOM());

  // Weather Grid (Top Section)
  if (w) {
    p = p.concat(CMD.ALIGN_CENTER, CMD.FEED_LINES(1));
    p = p.concat(CMD.SIZE_2X, stringToBytes(`${w.current}°\n`), CMD.SIZE_NORMAL);
    p = p.concat(CMD.BOLD_ON, stringToBytes(`${w.code.toUpperCase()}\n`), CMD.BOLD_OFF);
    p = p.concat(CMD.FEED_LINES(1));
    p = p.concat(CMD.ALIGN_LEFT);
    p = p.concat(
      stringToBytes(` H:${w.high}° L:${w.low}°  |  Feels: ${w.feels_like}°\n`),
    );
    p = p.concat(stringToBytes(` Wind: ${w.wind}mph  |  Rain: ${w.rain_chance}%\n`));
    p = p.concat(CMD.ALIGN_CENTER);
    p = p.concat(stringToBytes('------------------------------------------\n'));
  }

  // AI Content (Markdown Parsing)
  p = p.concat(CMD.FEED_LINES(1), CMD.ALIGN_LEFT, CMD.SIZE_NORMAL);

  const paragraphs = aiResult.text.split('\n');

  paragraphs.forEach((para) => {
    const line = para.trim();
    if (line.length === 0) return;

    // Detect Bold Headers (e.g. **Weather Outlook**)
    if (line.startsWith('**') && line.endsWith('**')) {
      const headerText = line.replace(/\*\*/g, ''); // Strip asterisks
      p = p.concat(CMD.BOLD_ON, stringToBytes(headerText + '\n'), CMD.BOLD_OFF);
    } else {
      // Body Text - Clean inline markdown and wrap
      const cleanLine = line.replace(/\*\*/g, '');
      wrapText(cleanLine, 42).forEach((l) => (p = p.concat(stringToBytes(l + '\n'))));
      p = p.concat(stringToBytes('\n')); // Add spacing after paragraph
    }
  });

  // Sources (Deduplicated)
  if (aiResult.sources.length > 0) {
    p = p.concat(stringToBytes('------------------------------------------\n'));
    p = p.concat(CMD.BOLD_ON, stringToBytes('DATA LINKS:\n'), CMD.BOLD_OFF);

    const unique: Source[] = [];
    const seen = new Set<string>();
    aiResult.sources.forEach((s) => {
      if (!s.url || seen.has(s.url)) return;
      seen.add(s.url);
      unique.push(s);
    });

    unique.slice(0, 5).forEach((d, i) => {
      let domain = 'Web';
      try {
        domain = d.url.replace('https://', '').split('/')[0].replace('www.', '');
      } catch (e) {}
      p = p.concat(stringToBytes(`[${i + 1}] ${domain}\n`));
    });
  }

  // Footer
  p = p.concat(CMD.FEED_LINES(4), CMD.CUT_PAPER);
  return p;
}

// --- UTILITY: WORD WRAPPER ---
// The briefing's own wrapper (no long-word breaking). The calendar module has a
// different one; keeping them module-local removes the old global collision.
function wrapText(text: string, maxLength: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    if (currentLine.length + 1 + words[i].length <= maxLength) {
      currentLine += ' ' + words[i];
    } else {
      lines.push(currentLine);
      currentLine = words[i];
    }
  }
  lines.push(currentLine);
  return lines;
}

// ==========================================
//           SENSORS (HARDCODED)
// ==========================================

// Currently unused (the news path is commented out of the briefing), kept for
// when it's re-enabled.
function fetchNewsStream(apiKey: string): { text: string; sources: Source[] } {
  const url = `https://newsapi.org/v2/top-headlines?country=us&pageSize=10&apiKey=${apiKey}`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

  if (res.getResponseCode() !== 200) {
    Logger.log(`⚠️ NewsAPI Error: ${res.getContentText()}`);
    return { text: 'NEWS_OFFLINE', sources: [] };
  }
  const json = JSON.parse(res.getContentText());
  if (!json.articles || json.articles.length === 0)
    return { text: 'NEWS_EMPTY', sources: [] };

  let contextString = 'HEADLINES:\n';
  const sourceLinks: Source[] = [];
  json.articles.forEach((art: any, index: number) => {
    const source = art.source.name || 'Unknown';
    const title = art.title || 'Redacted';
    contextString += `- [${source}] ${title}\n`;
    if (index < 5 && art.url) sourceLinks.push({ title: source, url: art.url });
  });
  return { text: contextString, sources: sourceLinks };
}

export function getDeepWeather(
  lat: string,
  lon: string | null,
  apiKey: string,
): WeatherData {
  const currentUrl = `https://weather.googleapis.com/v1/currentConditions:lookup?key=${apiKey}&location.latitude=${lat}&location.longitude=${lon}&unitsSystem=IMPERIAL`;
  const currentRes = UrlFetchApp.fetch(currentUrl, { muteHttpExceptions: false });
  const currentData = JSON.parse(currentRes.getContentText());

  const forecastUrl = `https://weather.googleapis.com/v1/forecast/hours:lookup?key=${apiKey}&location.latitude=${lat}&location.longitude=${lon}&hours=24&unitsSystem=IMPERIAL`;
  const forecastRes = UrlFetchApp.fetch(forecastUrl, { muteHttpExceptions: false });
  const forecastData = JSON.parse(forecastRes.getContentText());

  let maxTemp = -100,
    minTemp = 200,
    maxRain = 0;
  if (forecastData.forecastHours) {
    forecastData.forecastHours.forEach((h: any) => {
      const t = h.temperature.degrees;
      const pr = h.precipitation?.probability?.percent || 0;
      if (t > maxTemp) maxTemp = t;
      if (t < minTemp) minTemp = t;
      if (pr > maxRain) maxRain = pr;
    });
  } else {
    maxTemp = currentData.temperature.degrees;
    minTemp = currentData.temperature.degrees;
  }

  return {
    current: Math.round(currentData.temperature.degrees),
    feels_like: Math.round(currentData.feelsLikeTemperature.degrees),
    high: Math.round(maxTemp),
    low: Math.round(minTemp),
    humidity: currentData.relativeHumidity,
    wind: Math.round(currentData.wind.speed.value),
    uv: currentData.uvIndex,
    rain_chance: maxRain,
    code: currentData.weatherCondition.description.text,
    forecast: forecastRes.getContentText(),
    currentConditions: currentRes.getContentText(),
  };
}

// Retained so treeShaking:false keeps it in the bundle until the news path is
// wired back in; referencing it here avoids an "unused" lint in strict configs.
void fetchNewsStream;
