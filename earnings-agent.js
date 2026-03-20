const https = require("https");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const FINANCIAL_DATASETS_KEY = process.env.FINANCIAL_DATASETS_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = process.env.TO_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";

const WATCHLIST = [
  "AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA","AVGO","LLY","JPM",
  "V","UNH","XOM","MA","JNJ","PG","HD","COST","MRK","ABBV",
  "CVX","KO","PEP","BAC","WMT","CRM","TMO","ACN","CSCO","ABT",
  "MCD","AMD","NFLX","WFC","LIN","DHR","PM","NEE","TXN","MS",
  "GS","RTX","CAT","HON","AMGN","INTU","QCOM","LOW","SPGI","BLK"
];

function httpsGet(url, apiKey) {
  return new Promise((resolve, reject) => {
    const options = { headers: apiKey ? { "X-API-KEY": apiKey } : {} };
    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

function httpsPost(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers }
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function getToday() { return new Date().toISOString().split("T")[0]; }
function getPastDate(days) { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().split("T")[0]; }

// Earnings calendar via Finnhub
async function getTodayEarnings() {
  const today = getToday();
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${today}&token=${FINNHUB_API_KEY}`;
  const data = await httpsGet(url);
  if (!data.earningsCalendar) return [];
  return data.earningsCalendar
    .filter(e => WATCHLIST.includes(e.symbol))
    .map(e => ({ ticker: e.symbol, epsEstimate: e.epsEstimate, revenueEstimate: e.revenueEstimate }));
}

// Transcript via Finnhub
async function getTranscript(ticker) {
  const listUrl = `https://finnhub.io/api/v1/stock/transcripts/list?symbol=${ticker}&token=${FINNHUB_API_KEY}`;
  const list = await httpsGet(listUrl);
  if (!list.transcripts || list.transcripts.length === 0) return null;
  const latest = list.transcripts[0];
  const url = `https://finnhub.io/api/v1/stock/transcripts?id=${latest.id}&token=${FINNHUB_API_KEY}`;
  const transcript = await httpsGet(url);
  if (!transcript.transcript) return null;
  const fullText = transcript.transcript
    .map(s => `${s.name}: ${s.speech}`).join("\n").substring(0, 8000);
  return { text: fullText, date: latest.time };
}

// Slotkoers via Financial Datasets
async function getLatestPrice(ticker) {
  try {
    const url = `https://api.financialdatasets.ai/prices/?ticker=${ticker}&interval=day&interval_multiplier=1&start_date=${getPastDate(10)}&end_date=${getToday()}`;
    const data = await httpsGet(url, FINANCIAL_DATASETS_KEY);
    if (!data.prices || data.prices.length === 0) return null;
    const sorted = data.prices.sort((a, b) => new Date(b.time) - new Date(a.time));
    return { close: sorted[0].close, high: sorted[0].high, low: sorted[0].low };
  } catch (e) { return null; }
}

// Claude analyseert earnings + berekent trade parameters
async function analyseEarnings(ticker, transcript, price, epsEstimate, revenueEstimate) {
  const prompt = `Je bent een expert swing trade analist gespecialiseerd in earnings sentiment analyse.

TICKER: ${ticker}
Laatste slotkoers: $${price ? price.close.toFixed(2) : "onbekend"}
Dagrange: $${price ? price.low.toFixed(2) : "?"} - $${price ? price.high.toFixed(2) : "?"}
EPS verwachting: ${epsEstimate || "onbekend"}
Revenue verwachting: ${revenueEstimate ? `$${(revenueEstimate/1e9).toFixed(1)}B` : "onbekend"}

EARNINGS CALL TRANSCRIPT:
${transcript}

Analyseer de toon en geef ALLEEN dit exacte JSON object terug, geen tekst erbuiten:
{
  "signaal": "KOOP" of "VERKOOP" of "WACHT",
  "sterkte": getal 1-10,
  "sentiment_score": getal -10 tot +10,
  "toon": "OFFENSIEF" of "DEFENSIEF" of "NEUTRAAL",
  "beat_miss": "BEAT" of "MISS" of "IN LINE" of "ONBEKEND",
  "defensieve_taal": true of false,
  "verwachting": "OPTIMISTISCH" of "VOORZICHTIG" of "NEGATIEF",
  "entry_min": getal (prijs in $),
  "entry_max": getal (prijs in $),
  "stop_loss": getal (prijs in $),
  "take_profit_1": getal (prijs in $),
  "take_profit_2": getal (prijs in $),
  "rr_ratio": getal met 1 decimaal,
  "houdduur": "X-Y dagen",
  "positieve_signalen": ["max 3 korte punten"],
  "negatieve_signalen": ["max 3 korte punten"],
  "key_quote": "meest opvallende uitspraak management (max 20 woorden)",
  "samenvatting": "max 2 zinnen waarom dit signaal",
  "niet_instappen_als": "concrete conditie"
}

Regels:
- Geef alleen KOOP of VERKOOP bij sterkte >= 7 EN rr_ratio >= 2.5
- Bij KOOP: entry net boven slotkoers, SL 5-8% onder entry, TP op weerstandsniveau
- Bij VERKOOP: entry net onder slotkoers, SL 5-8% boven entry, TP op steunniveau
- Bij WACHT: vul entry/sl/tp in als indicatie maar signaal blijft WACHT`;

  const response = await httpsPost("api.anthropic.com", "/v1/messages", {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  }, { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" });

  const text = response.content[0].text;
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

function buildEmailHTML(ticker, analyse, price) {
  const isKoop = analyse.signaal === "KOOP";
  const isVerkoop = analyse.signaal === "VERKOOP";
  const topColor = isKoop ? "#0F6E56" : isVerkoop ? "#993C1D" : "#534AB7";
  const scoreColor = analyse.sentiment_score >= 3 ? "#1D9E75" : analyse.sentiment_score <= -3 ? "#E24B4A" : "#EF9F27";
  const toonColor = analyse.toon === "OFFENSIEF" ? "#1D9E75" : analyse.toon === "DEFENSIEF" ? "#E24B4A" : "#888";
  const beatColor = analyse.beat_miss === "BEAT" ? "#1D9E75" : analyse.beat_miss === "MISS" ? "#E24B4A" : "#888";
  const signaalBg = isKoop ? "#EAF3DE" : isVerkoop ? "#FCEBEB" : "#FAEEDA";
  const signaalColor = isKoop ? "#3B6D11" : isVerkoop ? "#A32D2D" : "#854F0B";
  const slPct = price ? (((analyse.stop_loss - price.close) / price.close) * 100).toFixed(1) : "?";
  const tp2Pct = price ? (((analyse.take_profit_2 - price.close) / price.close) * 100).toFixed(1) : "?";
  const now = new Date().toLocaleString("nl-BE", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:20px;">

  <!-- HEADER -->
  <div style="background:${topColor};border-radius:12px;padding:20px 24px;margin-bottom:16px;">
    <div style="font-size:11px;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">⚡ Earnings Sentiment Alert — Realtime AI Analyse</div>
    <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">
      <span style="font-size:30px;font-weight:600;color:#fff;">${ticker}</span>
      <span style="font-size:15px;color:rgba(255,255,255,0.8);">Slotkoers: $${price ? price.close.toFixed(2) : "?"}</span>
      <span style="background:${signaalBg};color:${signaalColor};font-size:12px;padding:3px 10px;border-radius:20px;font-weight:600;">${analyse.signaal} · ${analyse.sterkte}/10</span>
    </div>
    <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:6px;">${now} · Entry na 15:30 Vlaamse tijd · Houdduur: ${analyse.houdduur}</div>
  </div>

  <!-- CONTEXT SCORES -->
  <div style="background:#fff;border-radius:12px;padding:14px 18px;margin-bottom:12px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
    <div style="text-align:center;">
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">Sentiment</div>
      <div style="font-size:17px;font-weight:600;color:${scoreColor};">${analyse.sentiment_score > 0 ? "+" : ""}${analyse.sentiment_score}/10</div>
    </div>
    <div style="text-align:center;">
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">Toon</div>
      <div style="font-size:13px;font-weight:600;color:${toonColor};">${analyse.toon}</div>
    </div>
    <div style="text-align:center;">
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">Resultaat</div>
      <div style="font-size:13px;font-weight:600;color:${beatColor};">${analyse.beat_miss}</div>
    </div>
    <div style="text-align:center;">
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">Outlook</div>
      <div style="font-size:12px;font-weight:600;color:#534AB7;">${analyse.verwachting}</div>
    </div>
  </div>

  <!-- TRADE PARAMETERS — zelfde format als swing briefing -->
  <div style="background:#EEEDFE;border:1px solid #c8c4f0;border-radius:12px;padding:16px 20px;margin-bottom:12px;">
    <div style="font-size:10px;color:#534AB7;text-transform:uppercase;font-weight:600;letter-spacing:1px;margin-bottom:14px;">Trade parameters</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;text-align:center;">
      <div>
        <div style="font-size:10px;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">Entry zone</div>
        <div style="font-size:17px;font-weight:600;color:#26215C;">$${analyse.entry_min}–$${analyse.entry_max}</div>
        <div style="font-size:11px;color:#534AB7;margin-top:2px;">Bij marktopen of pullback</div>
      </div>
      <div>
        <div style="font-size:10px;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">Stop-loss</div>
        <div style="font-size:17px;font-weight:600;color:#26215C;">$${analyse.stop_loss}</div>
        <div style="font-size:11px;color:#E24B4A;margin-top:2px;">${slPct}%</div>
      </div>
      <div>
        <div style="font-size:10px;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">Take profit</div>
        <div style="font-size:17px;font-weight:600;color:#26215C;">$${analyse.take_profit_2}</div>
        <div style="font-size:11px;color:#1D9E75;margin-top:2px;">+${tp2Pct}%</div>
      </div>
    </div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid #c8c4f0;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:12px;color:#534AB7;">Risico/rendement</span>
      <span style="font-size:14px;font-weight:600;color:#26215C;">1 : ${analyse.rr_ratio} ✓</span>
    </div>
  </div>

  <!-- KEY QUOTE -->
  <div style="background:#fff;border-radius:12px;padding:14px 18px;margin-bottom:12px;border-left:4px solid ${topColor};">
    <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:6px;">Meest opvallende uitspraak management</div>
    <div style="font-size:13px;color:#1a1a1a;font-style:italic;line-height:1.6;">"${analyse.key_quote}"</div>
    <div style="margin-top:8px;font-size:11px;font-weight:500;color:${analyse.defensieve_taal ? "#A32D2D" : "#1D9E75"};">
      ${analyse.defensieve_taal ? "⚠️ Defensieve taal gedetecteerd — verhoogd risico op koersdaling" : "✓ Geen defensieve taal — management spreekt met vertrouwen"}
    </div>
  </div>

  <!-- SIGNALEN -->
  <div style="background:#fff;border-radius:12px;padding:14px 18px;margin-bottom:12px;">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div>
        <div style="font-size:10px;color:#1D9E75;text-transform:uppercase;font-weight:600;margin-bottom:8px;">✓ Positief</div>
        ${analyse.positieve_signalen.map(s => `<div style="font-size:12px;color:#1a1a1a;padding:5px 0;border-bottom:1px solid #f5f5f5;line-height:1.5;">${s}</div>`).join("")}
      </div>
      <div>
        <div style="font-size:10px;color:#E24B4A;text-transform:uppercase;font-weight:600;margin-bottom:8px;">✗ Negatief</div>
        ${analyse.negatieve_signalen.map(s => `<div style="font-size:12px;color:#1a1a1a;padding:5px 0;border-bottom:1px solid #f5f5f5;line-height:1.5;">${s}</div>`).join("")}
      </div>
    </div>
  </div>

  <!-- SAMENVATTING -->
  <div style="background:#fff;border-radius:12px;padding:14px 18px;margin-bottom:12px;border-left:3px solid #534AB7;">
    <div style="font-size:13px;color:#1a1a1a;line-height:1.7;">${analyse.samenvatting}</div>
  </div>

  <!-- NIET INSTAPPEN -->
  <div style="font-size:12px;color:#e05a00;padding:10px 14px;background:#fff3ec;border-radius:8px;margin-bottom:12px;">
    🚫 Niet instappen als: ${analyse.niet_instappen_als}
  </div>

  <!-- CHECKLIST -->
  <div style="background:#fff;border-radius:12px;padding:14px 18px;margin-bottom:12px;">
    <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:10px;">Checklist voor instap</div>
    ${[
      "Controleer pre-market reactie op earnings — gap up of down?",
      `Stop-loss instellen op $${analyse.stop_loss} direct bij aankoop`,
      "Wacht 5-10 minuten na open voor je instapt",
      `Eerste winst nemen op $${analyse.take_profit_1}`,
      `Volledig sluiten op $${analyse.take_profit_2} of na ${analyse.houdduur}`
    ].map(s => `
      <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#1a1a1a;padding:5px 0;border-bottom:1px solid #f5f5f5;">
        <div style="width:16px;height:16px;border-radius:50%;background:#EAF3DE;display:flex;align-items:center;justify-content:center;font-size:9px;color:#3B6D11;font-weight:600;flex-shrink:0;">✓</div>
        ${s}
      </div>`).join("")}
  </div>

  <div style="text-align:center;font-size:11px;color:#aaa;padding:16px;line-height:1.6;">
    Earnings sentiment analyse · Claude AI · Geen financieel advies.<br>
    Entry altijd na 15:30 Vlaamse tijd · R:R filter: alleen signalen ≥ 2.5
  </div>
</div></body></html>`;
}

async function sendEmail(html, ticker, signaal) {
  const emoji = signaal === "KOOP" ? "🟢" : signaal === "VERKOOP" ? "🔴" : "🟡";
  const result = await httpsPost("api.resend.com", "/emails", {
    from: FROM_EMAIL,
    to: TO_EMAIL,
    subject: `${emoji} Earnings Alert — ${ticker} | ${signaal}`,
    html,
  }, { Authorization: `Bearer ${RESEND_API_KEY}` });
  console.log(`Email verstuurd voor ${ticker}:`, JSON.stringify(result));
}

async function runEarningsAgent() {
  console.log("⚡ Earnings Agent gestart —", new Date().toLocaleString("nl-BE"));
  console.log("FINNHUB_API_KEY:", FINNHUB_API_KEY ? "✅" : "❌");
  console.log("FINANCIAL_DATASETS_KEY:", FINANCIAL_DATASETS_KEY ? "✅" : "❌");

  const todayEarnings = await getTodayEarnings();
  console.log(`📅 ${todayEarnings.length} tickers met earnings vandaag:`, todayEarnings.map(e => e.ticker).join(", ") || "geen");

  if (todayEarnings.length === 0) { console.log("Klaar — geen earnings vandaag."); return; }

  for (const earning of todayEarnings) {
    try {
      console.log(`\n🔍 ${earning.ticker} — transcript ophalen...`);
      const transcript = await getTranscript(earning.ticker);
      if (!transcript) { console.log(`  ⚠️ Geen transcript voor ${earning.ticker}`); continue; }

      console.log(`  📈 Prijs ophalen...`);
      const price = await getLatestPrice(earning.ticker);

      console.log(`  🤖 Claude analyseert...`);
      const analyse = await analyseEarnings(earning.ticker, transcript.text, price, earning.epsEstimate, earning.revenueEstimate);
      console.log(`  → ${analyse.signaal} | Sentiment: ${analyse.sentiment_score}/10 | R:R: 1:${analyse.rr_ratio}`);

      if (analyse.sterkte >= 7 && analyse.rr_ratio >= 2.5) {
        const html = buildEmailHTML(earning.ticker, analyse, price);
        await sendEmail(html, earning.ticker, analyse.signaal);
        console.log(`  ✅ Email verstuurd!`);
      } else {
        console.log(`  ℹ️ Geen email — sterkte ${analyse.sterkte}/10 of R:R 1:${analyse.rr_ratio} onder drempel`);
      }
      await sleep(2000);
    } catch (err) {
      console.error(`  ❌ Fout bij ${earning.ticker}:`, err.message);
    }
  }
  console.log("\n✅ Earnings Agent klaar!");
}

runEarningsAgent().catch(console.error);
