// functions/api/betfair-odds.js
// ─── Cloudflare Pages Function — Betfair Exchange proxy ──────────────────────
// Variables de entorno (Cloudflare Pages dashboard → Settings → Variables):
//   BETFAIR_APP_KEY  |  BETFAIR_USERNAME  |  BETFAIR_PASSWORD
//
// Ruta automática: /api/betfair-odds  (no requiere config extra)
// ─────────────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

// Caché de sesión en memoria (dura mientras el isolate está activo)
let _session = { token: null, expiry: 0 };

// Betfair runner name → código de 3 letras WCQF
const BF_MAP = {
  'Spain':'ESP','France':'FRA','Argentina':'ARG','England':'ENG',
  'Brazil':'BRA','Portugal':'POR','Germany':'GER','Netherlands':'NED',
  'Japan':'JPN','Morocco':'MAR','Senegal':'SEN','Colombia':'COL',
  'Uruguay':'URU','Belgium':'BEL','Croatia':'CRO','Norway':'NOR',
  'Switzerland':'SUI','Ecuador':'ECU','Turkey':'TUR','Türkiye':'TUR',
  'South Korea':'KOR','Korea Republic':'KOR','Mexico':'MEX','USA':'USA',
  'United States':'USA','Canada':'CAN','Australia':'AUS','Austria':'AUT',
  'Sweden':'SWE','Tunisia':'TUN','Egypt':'EGY','Iran':'IRN',
  'Saudi Arabia':'KSA','New Zealand':'NZL','Bosnia and Herzegovina':'BIH',
  'Bosnia & Herzegovina':'BIH','Qatar':'QAT','Cape Verde':'CPV',
  'Cabo Verde':'CPV','Paraguay':'PAR','South Africa':'RSA',
  'Czech Republic':'CZE','Czechia':'CZE','Scotland':'SCO','Haiti':'HAI',
  'Curacao':'CUW','Curaçao':'CUW',"Côte d'Ivoire":'CIV','Ivory Coast':'CIV',
  'Algeria':'ALG','Jordan':'JOR','DR Congo':'COD','Congo DR':'COD',
  'Uzbekistan':'UZB','Ghana':'GHA','Panama':'PAN','Iraq':'IRQ',
  'The Draw':'X',
};

function toCode(name) { return BF_MAP[name] || null; }

async function getSession(appKey, user, pass) {
  if (_session.token && Date.now() < _session.expiry) return _session.token;
  const res = await fetch('https://identitysso.betfair.com/api/login', {
    method: 'POST',
    headers: {
      'X-Application': appKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: `username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`,
  });
  const body = await res.json();
  if (body.status !== 'SUCCESS') throw new Error('BF_LOGIN_FAILED: ' + body.error);
  _session = { token: body.token, expiry: Date.now() + 6.5 * 3600_000 };
  return _session.token;
}

async function bfCall(token, appKey, method, params) {
  const res = await fetch('https://api.betfair.com/exchange/betting/json-rpc/v1', {
    method: 'POST',
    headers: {
      'X-Application': appKey,
      'X-Authentication': token,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify([{
      jsonrpc: '2.0',
      method: `SportsAPING/v1.0/${method}`,
      params,
      id: 1,
    }]),
  });
  const body = await res.json();
  if (body[0].error) throw new Error(JSON.stringify(body[0].error));
  return body[0].result;
}

export async function onRequest({ request, env }) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const APP_KEY = env.BETFAIR_APP_KEY;
  const USER    = env.BETFAIR_USERNAME;
  const PASS    = env.BETFAIR_PASSWORD;

  const json = (data) =>
    new Response(JSON.stringify(data), { status: 200, headers: CORS_HEADERS });

  // Sin credenciales → respuesta clara (la app usa cuotas estáticas)
  if (!APP_KEY || !USER || !PASS) {
    return json({
      data: null,
      source: 'no_credentials',
      message: 'Agrega BETFAIR_APP_KEY, BETFAIR_USERNAME y BETFAIR_PASSWORD en Cloudflare Pages → Settings → Variables.',
    });
  }

  try {
    const token = await getSession(APP_KEY, USER, PASS);

    // 1. Buscar eventos de Mundial 2026
    const events = await bfCall(token, APP_KEY, 'listEvents', {
      filter: { eventTypeIds: ['1'], textQuery: 'World Cup 2026' },
    });
    if (!events?.length) throw new Error('NO_EVENTS');

    const eventIds = events.map(e => e.event.id);

    // 2. Mercados MATCH_ODDS
    const markets = await bfCall(token, APP_KEY, 'listMarketCatalogue', {
      filter: { eventIds, marketTypeCodes: ['MATCH_ODDS'] },
      marketProjection: ['EVENT', 'RUNNERS', 'MARKET_START_TIME'],
      maxResults: '120',
    });
    if (!markets?.length) throw new Error('NO_MARKETS');

    // 3. Precios back/lay
    const marketIds = markets.map(m => m.marketId);
    const books = await bfCall(token, APP_KEY, 'listMarketBook', {
      marketIds,
      priceProjection: {
        priceData: ['EX_BEST_OFFERS'],
        exBestOffersOverrides: { bestPricesDepth: 1 },
      },
    });

    const bookMap = {};
    books.forEach(b => { bookMap[b.marketId] = b; });

    const now = new Date().toISOString();
    const result = {};

    markets.forEach(mkt => {
      const book = bookMap[mkt.marketId];
      if (!book || book.status !== 'OPEN') return;
      const runners = mkt.runners;
      if (!runners || runners.length < 3) return;

      let homeCode = null, awayCode = null;
      const runnerData = {};

      runners.forEach(r => {
        const code = toCode(r.runnerName);
        const rb = book.runners?.find(x => x.selectionId === r.selectionId);
        if (!rb) return;
        const back = rb.ex?.availableToBack?.[0]?.price;
        const lay  = rb.ex?.availableToLay?.[0]?.price;
        const vol  = rb.ex?.availableToBack?.reduce((s, x) => s + (x.size || 0), 0) || 0;
        if (code === 'X') {
          runnerData.X = { back, lay, vol };
        } else if (code) {
          if (!homeCode) { homeCode = code; runnerData['1'] = { back, lay, vol }; }
          else           { awayCode = code; runnerData['2'] = { back, lay, vol }; }
        }
      });

      if (!homeCode || !awayCode || !runnerData['1'] || !runnerData['2'] || !runnerData.X) return;

      result[`${homeCode}|${awayCode}`] = {
        back1: runnerData['1'].back,
        backX: runnerData.X.back,
        back2: runnerData['2'].back,
        lay1:  runnerData['1'].lay,
        layX:  runnerData.X.lay,
        lay2:  runnerData['2'].lay,
        vol:   (runnerData['1'].vol + runnerData['2'].vol + runnerData.X.vol).toFixed(0),
        startTime: mkt.marketStartTime,
        fetchedAt: now,
      };
    });

    return json({
      data: result,
      fetchedAt: now,
      source: 'betfair_live',
      count: Object.keys(result).length,
    });

  } catch (err) {
    console.error('Betfair error:', err.message);
    return json({ data: null, source: 'error', message: err.message });
  }
}
