'use strict';

/* ============================================================================
 *  ANIDARK ULTIMATE — org.anidark.kitsu.ultimate
 *  Addon Stremio (catálogo + metadados) num único ficheiro.
 * ============================================================================
 *  Arquitetura:
 *   • Kitsu API (fonte primária)  → IDs "kitsu:", títulos limpos (EN/Canon),
 *     capas em alta resolução, episódios, géneros e relações de franquia.
 *   • AniList GraphQL (EPG)       → injeta "released" com data E hora exatas
 *     (airingSchedule + nextAiringEpisode) para o Calendário do Stremio.
 *   • MALSync (redundância)       → mapeamento Kitsu → IMDb (tt...) injetado
 *     como imdb_id, para addons ocidentais (Comet, MediaFusion, Jackettio).
 *
 *  Smart Cache (RAM, duas velocidades):
 *   • Airing   → 15 minutos      • Finished → 30 dias
 *   • Upcoming → 6 horas (transição rápida para "airing" na estreia)
 *
 *  package.json:
 *   {
 *     "name": "anidark-ultimate",
 *     "version": "1.0.0",
 *     "main": "server.js",
 *     "dependencies": {
 *       "stremio-addon-sdk": "^1.6.10",
 *       "axios": "^1.7.2"
 *     }
 *   }
 *
 *  Hugging Face Spaces (SDK: Docker) — README.md do Space:
 *     ---
 *     title: AniDark Ultimate
 *     sdk: docker
 *     app_port: 7000
 *     ---
 *  Dockerfile:
 *     FROM node:20-alpine
 *     WORKDIR /app
 *     COPY package.json server.js ./
 *     RUN npm install --omit=dev
 *     EXPOSE 7000
 *     CMD ["node", "server.js"]
 *  (Ou defina a variável de ambiente PORT=7860 — o servidor usa sempre
 *   process.env.PORT || 7000.)
 * ============================================================================ */

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

/* ============================================================================
 * 1) CONSTANTES
 * ============================================================================ */

const KITSU_API = 'https://kitsu.io/api/edge';
const ANILIST_API = 'https://graphql.anilist.co';
const MALSYNC_API = 'https://api.malsync.moe/v1';

const USER_AGENT = 'AniDarkUltimate/1.0.0 (Stremio Addon; org.anidark.kitsu.ultimate)';

// Smart Cache de duas velocidades (metas) + TTLs auxiliares (catálogos/mapas)
const TTL = {
    AIRING: 15 * 60 * 1000,                   // [Requisito] airing → 15 min
    UPCOMING: 6 * 60 * 60 * 1000,             // por estrear → 6 h
    FINISHED: 30 * 24 * 60 * 60 * 1000,       // [Requisito] finished → 30 dias
    CATALOG_DYNAMIC: 15 * 60 * 1000,          // trending / airing
    CATALOG_SEMI: 12 * 60 * 60 * 1000,        // completed / movies / ovas / studios
    CATALOG_STATIC: 30 * 24 * 60 * 60 * 1000, // arquivo de temporadas (imutável)
    STATIC_MAP: 30 * 24 * 60 * 60 * 1000,     // IMDb (MALSync) e IDs de produtoras
    NEGATIVE: 6 * 60 * 60 * 1000              // caches negativos (retry periódico)
};

const STUDIO_OPTIONS = ['MAPPA', 'Ufotable', 'Wit Studio', 'Kyoto Animation', 'Madhouse'];

const SEASON_ORDER = ['winter', 'spring', 'summer', 'fall'];
const SEASON_LABELS = { winter: 'Winter', spring: 'Spring', summer: 'Summer', fall: 'Fall' };

const KITSU_PAGE_SIZE = 20; // máximo garantido pela API em listagens
const EPISODE_FIELDS = 'titles,canonicalTitle,number,airdate,thumbnail,synopsis';
const STUDIO_ANIME_FIELDS = 'titles,canonicalTitle,subtype,status,startDate,endDate,averageRating,userCount,posterImage,coverImage,synopsis';

/* ============================================================================
 * 2) CAMADA HTTP (axios + retry com backoff para 429/5xx)
 * ============================================================================ */

const kitsuApi = axios.create({
    baseURL: KITSU_API, timeout: 15000,
    headers: { 'Accept': 'application/vnd.api+json', 'User-Agent': USER_AGENT }
});
const anilistApi = axios.create({
    baseURL: ANILIST_API, timeout: 12000,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': USER_AGENT }
});
const malsyncApi = axios.create({
    baseURL: MALSYNC_API, timeout: 10000,
    headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resilientRequest(instance, url, config = {}, retries = 2) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await instance.request({ url, ...config });
        } catch (error) {
            lastError = error;
            const status = error.response && error.response.status;
            const retriable = !error.response || status === 429 || status >= 500;
            if (attempt < retries && retriable) {
                await sleep(400 * (attempt + 1) + Math.floor(Math.random() * 400));
                continue;
            }
            throw lastError;
        }
    }
    throw lastError;
}

/** GET no Kitsu — devolve o corpo JSON:API (data/included/links/meta). */
async function kitsuGet(path, params = {}) {
    const response = await resilientRequest(kitsuApi, path, { params });
    return response.data || {};
}

/* ============================================================================
 * 3) SMART CACHE EM MEMÓRIA RAM (com expiração, varrimento e teto de entradas)
 * ============================================================================ */

function createMemoryCache(maxEntries = 2000) {
    const store = new Map();
    return {
        /** undefined = miss; qualquer outro valor (incl. null) = hit. */
        get(key) {
            const entry = store.get(key);
            if (!entry) return undefined;
            if (Date.now() > entry.expires) { store.delete(key); return undefined; }
            return entry.value;
        },
        set(key, value, ttlMs) {
            store.delete(key);
            store.set(key, { value, expires: Date.now() + ttlMs });
            if (store.size > maxEntries) { // evita fuga de memória em longa sessão
                const overflow = store.size - Math.floor(maxEntries * 0.9);
                let removed = 0;
                for (const k of store.keys()) {
                    if (removed++ >= overflow) break;
                    store.delete(k);
                }
            }
        },
        sweep() {
            const now = Date.now();
            for (const [key, entry] of store) {
                if (now > entry.expires) store.delete(key);
            }
        }
    };
}

const caches = {
    meta: createMemoryCache(1500),     // metadados (2 velocidades)
    catalog: createMemoryCache(600),   // páginas de catálogo / listas de estúdio
    malsync: createMemoryCache(3000),  // kitsu → imdb (30 dias)
    company: createMemoryCache(100)    // nome de estúdio → company ID
};

const sweeper = setInterval(() => {
    Object.values(caches).forEach((cache) => cache.sweep());
}, 30 * 60 * 1000);
if (sweeper.unref) sweeper.unref();

/* ============================================================================
 * 4) UTILITÁRIOS
 * ============================================================================ */

function parseKitsuId(rawId) {
    const match = /^kitsu:(\d+)(?::\d+)?$/i.exec(String(rawId || '').trim());
    return match ? parseInt(match[1], 10) : null;
}

function offsetFromLink(link) {
    if (!link || typeof link !== 'string') return null;
    try {
        const value = parseInt(new URL(link).searchParams.get('page[offset]'), 10);
        return Number.isFinite(value) ? value : null;
    } catch (_) {
        return null;
    }
}

function sanitizeText(text) {
    return String(text || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\r/g, '')
        .trim();
}

function truncateText(text, maxLength) {
    return text.length > maxLength
        ? text.slice(0, maxLength).replace(/\s+\S*$/, '') + '…'
        : text;
}

/** Temporada atual (Winter=Jan-Mar, Spring=Abr-Jun, Summer=Jul-Set, Fall=Out-Dez). */
function getCurrentSeason(now = new Date()) {
    const month = now.getMonth();
    const year = now.getFullYear();
    if (month <= 2) return { season: 'winter', year };
    if (month <= 5) return { season: 'spring', year };
    if (month <= 8) return { season: 'summer', year };
    return { season: 'fall', year };
}

/** Últimas N temporadas ANTERIORES à atual (ex.: atual Spring 2026 → Winter 2026, Fall 2025, ...). */
function buildSeasonsArchive(count = 9) {
    const archive = [];
    const current = getCurrentSeason();
    let index = SEASON_ORDER.indexOf(current.season);
    let year = current.year;
    for (let i = 0; i < count; i++) {
        index -= 1;
        if (index < 0) { index = SEASON_ORDER.length - 1; year -= 1; }
        archive.push(`${SEASON_LABELS[SEASON_ORDER[index]]} ${year}`);
    }
    return archive;
}

/* ============================================================================
 * 5) MAPEADORES KITSU → STREMIO
 * ============================================================================ */

/** Títulos limpos: Inglês oficial → Canon (canonicalTitle) → romaji → japonês. */
function pickTitle(attributes) {
    const titles = attributes.titles || {};
    return titles.en || attributes.canonicalTitle || titles.en_jp || titles.ja_jp || 'Título desconhecido';
}

/** Capas em alta resolução (original → large → medium). */
function pickPoster(attributes) {
    const poster = attributes.posterImage || {};
    return poster.original || poster.large || poster.medium || poster.small || null;
}

function pickBackground(attributes) {
    const cover = attributes.coverImage || {};
    return cover.original || cover.large || null;
}

function buildReleaseInfo(attributes, isMovie) {
    const start = attributes.startDate ? parseInt(attributes.startDate.slice(0, 4), 10) : null;
    const end = attributes.endDate ? parseInt(attributes.endDate.slice(0, 4), 10) : null;
    if (!start) return null;
    if (isMovie || !end || end === start) return String(start);
    if (attributes.status === 'current') return `${start}–`; // ainda em exibição
    return `${start}–${end}`;
}

function collectAliases(attributes) {
    const aliases = [];
    if (attributes.titles && attributes.titles.ja_jp) aliases.push(attributes.titles.ja_jp);
    if (Array.isArray(attributes.abbreviatedTitles)) aliases.push(...attributes.abbreviatedTitles.slice(0, 4));
    return [...new Set(aliases)].slice(0, 5);
}

/** MetaPreview enxuta para catálogos (leveza: sem géneros/fields pesados). */
function toPreview(item, forcedType) {
    const attributes = (item && item.attributes) || {};
    const type = forcedType || (attributes.subtype === 'movie' ? 'movie' : 'series');
    const preview = {
        id: `kitsu:${item.id}`,
        kitsu_id: parseInt(item.id, 10),
        type,
        name: pickTitle(attributes)
    };
    const poster = pickPoster(attributes);
    if (poster) preview.poster = poster;
    const background = attributes.coverImage ? (attributes.coverImage.large || attributes.coverImage.original) : null;
    if (background) preview.background = background;
    const synopsis = sanitizeText(attributes.synopsis);
    if (synopsis) preview.description = truncateText(synopsis, 400);
    const releaseInfo = buildReleaseInfo(attributes, type === 'movie');
    if (releaseInfo) preview.releaseInfo = releaseInfo;
    if (attributes.averageRating) {
        const rating = parseFloat(attributes.averageRating);
        if (Number.isFinite(rating) && rating > 0) preview.imdbRating = (rating / 10).toFixed(1);
    }
    if (type === 'movie' && attributes.episodeLength) preview.runtime = `${attributes.episodeLength} min`;
    return preview;
}

/** Descrição final + notas de franquia (Sequela / Prequela) no fim do texto. */
function buildDescription(synopsis, franchiseNotes) {
    let text = sanitizeText(synopsis) || 'Sem descrição disponível.';
    if (Array.isArray(franchiseNotes) && franchiseNotes.length) {
        text += `\n\n— Notas de Franquia (Watch Order) —\n${franchiseNotes.slice(0, 8).map((n) => `• ${n}`).join('\n')}`;
    }
    return text;
}

/* ============================================================================
 * 6) ANILIST (EPG / CALENDÁRIO) — released com data e hora exatas
 * ============================================================================ */

// s1 = primeiros 50 episódios; s2 = janela calculada para animes longos
// (ex.: One Piece → página que contém o próximo episódio).
const ANILIST_EPG_QUERY = `
query($id: Int, $p2: Int) {
    Media(id: $id, type: ANIME) {
        nextAiringEpisode { airingAt episode }
        s1: airingSchedule(page: 1, perPage: 50) { nodes { airingAt episode } }
        s2: airingSchedule(page: $p2, perPage: 50) { nodes { airingAt episode } }
    }
}`;

/**
 * @param {number} anilistId     ID AniList (via mappings do Kitsu)
 * @param {number} nextEpisodeHint nº aproximado do próximo episódio
 * @returns {Promise<{map:Object, nextEpisode:number|null}|null>} mapa episódio→ISO
 */
async function fetchAniListSchedule(anilistId, nextEpisodeHint) {
    const page = Math.max(1, Math.min(120, Math.ceil((nextEpisodeHint || 1) / 50)));
    const response = await resilientRequest(anilistApi, '/', {
        method: 'post',
        data: { query: ANILIST_EPG_QUERY, variables: { id: anilistId, p2: page } }
    });
    const media = response.data && response.data.data && response.data.data.Media;
    if (!media) return null;

    const scheduleMap = {};
    const absorb = (nodes) => {
        (nodes || []).forEach((node) => {
            if (node && typeof node.episode === 'number' && typeof node.airingAt === 'number') {
                scheduleMap[node.episode] = new Date(node.airingAt * 1000).toISOString();
            }
        });
    };
    absorb(media.s1 && media.s1.nodes);
    if (page > 1) absorb(media.s2 && media.s2.nodes);

    const next = media.nextAiringEpisode || null;
    if (next && typeof next.episode === 'number' && typeof next.airingAt === 'number') {
        scheduleMap[next.episode] = new Date(next.airingAt * 1000).toISOString();
    }
    return { map: scheduleMap, nextEpisode: next ? next.episode : null };
}

/* ============================================================================
 * 7) MALSYNC — MOTOR DE REDUNDÂNCIA KITSU → IMDb (tt...)
 * ============================================================================ */

async function fetchImdbId(kitsuId) {
    const key = `kitsu:${kitsuId}`;
    const cached = caches.malsync.get(key);
    if (cached !== undefined) return cached;

    let imdbId = null;
    try {
        const response = await resilientRequest(malsyncApi, `/kitsu/anime/${kitsuId}`);
        const data = (response.data && response.data.data) || {};
        const imdb = data.IMDb || data.IMDB || {};
        const raw = `${imdb.id || ''} ${imdb.url || ''}`;
        const match = /tt\d{5,10}/.exec(raw);
        if (match) imdbId = match[0];
    } catch (error) {
        console.warn(`[AniDark] MALSync sem IMDb para kitsu:${kitsuId} (${error.message})`);
    }
    caches.malsync.set(key, imdbId, imdbId ? TTL.STATIC_MAP : TTL.NEGATIVE);
    return imdbId;
}

/* ============================================================================
 * 8) RELAÇÕES DE FRANQUIA (Watch Order) — parse das anime/mediaRelationships
 * ============================================================================ */

const FRANCHISE_ROLE_LABELS = {
    prequel: 'Prequela',
    sequel: 'Sequela',
    parent: 'Obra Principal',
    source: 'Obra Original',
    adaptation: 'Adaptação de',
    side_story: 'História Paralela',
    spin_off: 'Spin-off',
    alternative: 'Versão Alternativa',
    summary: 'Compilação',
    full_story: 'História Completa',
    other: 'Relacionado'
};
const FRANCHISE_ROLE_ORDER = {
    prequel: 0, sequel: 1, parent: 2, source: 2, adaptation: 3,
    side_story: 4, spin_off: 4, alternative: 5, summary: 6, full_story: 6, other: 7
};

async function fetchFranchiseNotes(animeId) {
    const body = await kitsuGet(`/anime/${animeId}/media-relationships`, {
        include: 'destination', 'page[limit]': 20, 'page[offset]': 0
    });
    const includedMap = new Map(((body && body.included) || []).map((r) => [`${r.type}:${r.id}`, r]));
    const relations = (body && body.data) || [];
    const notes = [];

    for (const relation of relations) {
        const role = relation.attributes && relation.attributes.role;
        const label = FRANCHISE_ROLE_LABELS[role];
        if (!label) continue;
        const ref = relation.relationships && relation.relationships.destination && relation.relationships.destination.data;
        const destination = ref ? includedMap.get(`${ref.type}:${ref.id}`) : null;
        const title = destination && destination.attributes
            ? (destination.attributes.canonicalTitle || (destination.attributes.titles && destination.attributes.titles.en) || null)
            : null;
        if (title) notes.push({ role, label, title });
    }
    notes.sort((a, b) => (FRANCHISE_ROLE_ORDER[a.role] ?? 8) - (FRANCHISE_ROLE_ORDER[b.role] ?? 8));
    return notes.slice(0, 8).map((note) => `${note.label}: ${note.title}`);
}

/* ============================================================================
 * 9) EPISÓDIOS (Kitsu) + CONSTRUÇÃO DOS VIDEOS (kitsu:ID:EP)
 * ============================================================================ */

/** Obtém TODOS os episódios com paginação inteligente (fan-out paralelo). */
async function fetchEpisodes(animeId) {
    const path = `/anime/${animeId}/episodes`;
    // Cascata de tentativas: limit 100 → limit 20 → sem sparse fields
    const attempts = [
        { 'fields[episodes]': EPISODE_FIELDS, 'page[limit]': 100, 'page[offset]': 0 },
        { 'fields[episodes]': EPISODE_FIELDS, 'page[limit]': 20, 'page[offset]': 0 },
        { 'page[limit]': 20, 'page[offset]': 0 }
    ];
    let first = null;
    let firstParams = null;
    let lastError = null;
    for (const params of attempts) {
        try { first = await kitsuGet(path, params); firstParams = params; break; }
        catch (error) { lastError = error; }
    }
    if (!first) throw lastError;

    const episodes = [...((first.data) || [])];
    const nextOffset = offsetFromLink(first.links && first.links.next);
    if (nextOffset === null) return episodes; // tudo numa única página

    // O offset do link "next" revela o tamanho de página REAL do servidor
    const pageSize = nextOffset > 0 ? nextOffset : (episodes.length || 20);
    const total = (first.meta && Number(first.meta.count)) || 0;

    if (total > pageSize) {
        // Caminho rápido: páginas restantes em paralelo (lotes de 8)
        const offsets = [];
        for (let off = pageSize; off < total && offsets.length < 60; off += pageSize) offsets.push(off);
        for (let i = 0; i < offsets.length; i += 8) {
            const batch = offsets.slice(i, i + 8);
            const results = await Promise.allSettled(batch.map((off) =>
                kitsuGet(path, { ...firstParams, 'page[offset]': off })
            ));
            results.forEach((result) => {
                if (result.status === 'fulfilled' && Array.isArray(result.value && result.value.data)) {
                    episodes.push(...result.value.data);
                }
            });
        }
    } else if (!total) {
        // Caminho defensivo (sem meta.count): sequencial até página curta
        let offset = pageSize;
        for (let guard = 0; guard < 60; guard++) {
            const body = await kitsuGet(path, { ...firstParams, 'page[offset]': offset });
            const data = (body && body.data) || [];
            episodes.push(...data);
            if (data.length < pageSize) break;
            offset += pageSize;
        }
    }
    return episodes;
}

/**
 * Constrói a lista de videos com IDs "kitsu:ID:EP".
 * FAILSAFE NUMÉRICO: quando a API ainda não tem os nomes individuais,
 * gera episódios genéricos até ao episodeCount total (usando as datas do
 * AniList quando existem, para manter o Calendário funcional).
 */
function buildVideos(kitsuId, kitsuEpisodes, episodeCount, anilistMap, status) {
    const byNumber = new Map();
    (kitsuEpisodes || []).forEach((episode) => {
        const attrs = episode && episode.attributes;
        if (attrs && typeof attrs.number === 'number' && !byNumber.has(attrs.number)) {
            byNumber.set(attrs.number, attrs);
        }
    });

    const maxApiEpisode = byNumber.size ? Math.max(...byNumber.keys()) : 0;
    const maxAnilistEpisode = anilistMap ? Math.max(0, ...Object.keys(anilistMap).map(Number)) : 0;
    const minimumFloor = (status === 'current' || status === 'upcoming' || status === 'tba') ? 12 : 0;
    const totalEpisodes = Math.max(episodeCount || 0, maxApiEpisode, maxAnilistEpisode, minimumFloor);

    const videos = [];
    const makeVideo = (number, attrs) => {
        const titles = (attrs && attrs.titles) || {};
        const video = {
            id: `kitsu:${kitsuId}:${number}`,
            title: (attrs && (titles.en || titles.en_jp || attrs.canonicalTitle)) || `Episódio ${number}`,
            season: 1,
            episode: number
        };
        const released = (anilistMap && anilistMap[number])
            || (attrs && attrs.airdate ? `${attrs.airdate}T00:00:00.000Z` : null);
        if (released) video.released = released;
        const thumb = attrs && attrs.thumbnail
            ? (attrs.thumbnail.original || attrs.thumbnail.large || attrs.thumbnail.medium || null)
            : null;
        if (thumb) video.thumbnail = thumb;
        const overview = attrs ? sanitizeText(attrs.synopsis) : '';
        if (overview) video.overview = overview;
        videos.push(video);
    };

    if (byNumber.has(0)) makeVideo(0, byNumber.get(0)); // episódios especiais "0"
    for (let n = 1; n <= totalEpisodes; n++) {
        makeVideo(n, byNumber.get(n) || null); // failsafe numérico
    }
    return videos;
}

/* ============================================================================
 * 10) METADADO DETALHADO (rota de metas)
 * ============================================================================ */

/** Anime principal com cascata de includes (genres+mappings → mappings → nu). */
async function fetchAnimeCore(kitsuId) {
    const attempts = ['genres,mappings', 'mappings', ''];
    let lastError = null;
    for (const include of attempts) {
        try {
            return await kitsuGet(`/anime/${kitsuId}`, include ? { include } : {});
        } catch (error) { lastError = error; }
    }
    throw lastError;
}

async function buildMetaDetail(kitsuId) {
    // ---- 1) Round paralelo: Kitsu core + episódios + franquia + MALSync
    const [animeBody, episodes, franchiseNotes, imdbId] = await Promise.all([
        fetchAnimeCore(kitsuId),
        fetchEpisodes(kitsuId).catch(() => []),        // falhou → failsafe numérico
        fetchFranchiseNotes(kitsuId).catch(() => []),  // falhou → descrição limpa
        fetchImdbId(kitsuId).catch(() => null)         // falhou → sem imdb_id
    ]);

    const item = animeBody && animeBody.data;
    if (!item || !item.attributes) return null;
    const attributes = item.attributes;
    const isMovie = attributes.subtype === 'movie';
    const included = (animeBody.included) || [];

    // ---- 2) Mapeamentos Kitsu → AniList / MAL
    const mappings = included.filter((r) => r.type === 'mappings' && r.attributes);
    const externalId = (site) => {
        const found = mappings.find((r) => r.attributes.externalSite === site);
        return found ? Number(found.attributes.externalId) : null;
    };
    const anilistId = externalId('anilist/anime');
    const malId = externalId('myanimelist/anime');

    // ---- 3) AniList EPG (sequencial: usa o nº de episódios como hint de página)
    let epg = null;
    if (!isMovie && anilistId) {
        const hint = (episodes.length || attributes.episodeCount || 1) + 1;
        epg = await fetchAniListSchedule(anilistId, hint).catch(() => null);
    }

    const airing = attributes.status === 'current' || !!(epg && epg.nextEpisode);
    const upcoming = !airing && ['upcoming', 'tba', 'unreleased'].includes(attributes.status);

    // ---- 4) Montagem da meta
    const meta = {
        id: `kitsu:${kitsuId}`,
        kitsu_id: kitsuId,
        type: isMovie ? 'movie' : 'series',
        name: pickTitle(attributes)
    };
    const poster = pickPoster(attributes);
    if (poster) meta.poster = poster;
    const background = pickBackground(attributes);
    if (background) meta.background = background;
    meta.description = buildDescription(attributes.synopsis, franchiseNotes);
    const releaseInfo = buildReleaseInfo(attributes, isMovie);
    if (releaseInfo) meta.releaseInfo = releaseInfo;
    if (attributes.startDate) meta.released = `${attributes.startDate}T00:00:00.000Z`;
    if (attributes.averageRating) {
        const rating = parseFloat(attributes.averageRating);
        if (Number.isFinite(rating) && rating > 0) meta.imdbRating = (rating / 10).toFixed(1);
    }
    const genres = included
        .filter((r) => r.type === 'genres' && r.attributes)
        .map((r) => r.attributes.name)
        .filter(Boolean);
    if (genres.length) meta.genres = genres;
    const aliases = collectAliases(attributes);
    if (aliases.length) meta.aliases = aliases;
    if (attributes.youtubeVideoId) meta.trailers = [{ source: attributes.youtubeVideoId, type: 'Trailer' }];
    meta.country = 'Japan';
    if (isMovie && attributes.episodeLength) meta.runtime = `${attributes.episodeLength} min`;

    // Motor de redundância: referência IMDb para addons ocidentais
    if (imdbId) meta.imdb_id = imdbId;
    if (malId) meta.mal_id = malId;

    if (isMovie) {
        // REGRA CRÍTICA: filmes NÃO recebem 'videos' (fica undefined) —
        // nunca gerar listas com 1 episódio; o tipo retornado é 'movie'.
    } else {
        meta.videos = buildVideos(
            kitsuId, episodes, attributes.episodeCount || 0,
            epg ? epg.map : null, attributes.status
        );
    }
    return { meta, airing, upcoming };
}

/* ============================================================================
 * 11) CATÁLOGOS
 * ============================================================================ */

/** Fan-out paralelo de páginas de 20 itens para cobrir [skip, skip+limit). */
async function kitsuList(path, params = {}, skip = 0, limit = 100) {
    skip = Math.max(0, parseInt(skip, 10) || 0);
    limit = Math.max(1, Math.min(150, parseInt(limit, 10) || 100));

    const firstPage = Math.floor(skip / KITSU_PAGE_SIZE);
    const lastPage = Math.floor((skip + limit - 1) / KITSU_PAGE_SIZE);
    const offsets = [];
    for (let page = firstPage; page <= lastPage; page++) offsets.push(page * KITSU_PAGE_SIZE);

    const results = await Promise.allSettled(offsets.map((offset) =>
        kitsuGet(path, { ...params, 'page[limit]': KITSU_PAGE_SIZE, 'page[offset]': offset })
    ));
    const items = [];
    results.forEach((result) => {
        if (result.status === 'fulfilled' && Array.isArray(result.value && result.value.data)) {
            items.push(...result.value.data);
        }
    });
    const drop = skip - firstPage * KITSU_PAGE_SIZE;
    return items.slice(drop, drop + limit);
}

/** Paginação completa (usado nas productions dos estúdios). */
async function paginateAll(path, params = {}, maxEntries = 400) {
    let first = null;
    let winnerParams = null;
    let lastError = null;
    for (const attempt of [
        { ...params, 'page[limit]': 100, 'page[offset]': 0 },
        { ...params, 'page[limit]': 20, 'page[offset]': 0 }
    ]) {
        try { first = await kitsuGet(path, attempt); winnerParams = attempt; break; }
        catch (error) { lastError = error; }
    }
    if (!first) throw lastError;

    const bodies = [first];
    const items = (first && first.data) || [];
    const nextOffset = offsetFromLink(first && first.links && first.links.next);
    if (nextOffset === null) return bodies;

    const pageSize = nextOffset > 0 ? nextOffset : (items.length || 20);
    const total = (first.meta && Number(first.meta.count)) || 0;
    const offsets = [];
    const ceiling = Math.min(total || maxEntries, maxEntries);
    for (let off = pageSize; off < ceiling && offsets.length < 20; off += pageSize) offsets.push(off);

    const rest = await Promise.allSettled(offsets.map((off) =>
        kitsuGet(path, { ...winnerParams, 'page[offset]': off })
    ));
    rest.forEach((result) => {
        if (result.status === 'fulfilled' && result.value) bodies.push(result.value);
    });
    return bodies;
}

async function cachedCatalog(key, ttl, producer) {
    const hit = caches.catalog.get(key);
    if (hit !== undefined) return hit;
    const value = await producer();
    caches.catalog.set(key, value, ttl);
    return value;
}

/** AD - Search: pesquisa global, ordenada do mais recente para o mais antigo. */
async function handleSearch(type, search, skip, limit) {
    const query = sanitizeText(search);
    if (!query) return { metas: [] };

    const params = { 'filter[text]': query, sort: '-startDate' }; // [Requisito]
    if (type === 'movie') params['filter[subtype]'] = 'movie';

    const margin = type === 'movie' ? 0 : 20; // margem para filtrar filmes localmente
    const items = await kitsuList('/anime', params, skip, limit + margin);
    let metas = items.map((item) => toPreview(item, type === 'movie' ? 'movie' : undefined));
    if (type !== 'movie') metas = metas.filter((meta) => meta.type !== 'movie').slice(0, limit);
    return { metas };
}

/** Fábrica para catálogos de fonte única (paginação estável, sem duplicados). */
function createSeriesCatalog(params, ttl, keyPrefix) {
    return async (skip, limit) => ({
        metas: await cachedCatalog(`${keyPrefix}:${skip}:${limit}`, ttl, async () => {
            const items = await kitsuList('/anime', params, skip, limit);
            return items.map((item) => toPreview(item));
        })
    });
}

// "Em Destaque e Temporada Atual": os animes em exibição com maior popularidade
// são, por definição, os destaques da temporada corrente.
const handleTrending = createSeriesCatalog(
    { 'filter[subtype]': 'TV', 'filter[status]': 'current', sort: '-userCount' },
    TTL.CATALOG_DYNAMIC, 'trending'
);
const handleAiring = createSeriesCatalog(
    { 'filter[subtype]': 'TV', 'filter[status]': 'current', sort: '-startDate' },
    TTL.CATALOG_DYNAMIC, 'airing'
);
const handleCompleted = createSeriesCatalog(
    { 'filter[subtype]': 'TV', 'filter[status]': 'finished', sort: '-userCount' },
    TTL.CATALOG_SEMI, 'completed'
);
const handleMovies = createSeriesCatalog(
    { 'filter[subtype]': 'movie', sort: '-userCount' },
    TTL.CATALOG_SEMI, 'movies'
);

/** AD - Movies & OVAs (lado séries): OVA + ONA + Especial intercalados. */
async function handleOvas(skip, limit) {
    return {
        metas: await cachedCatalog(`ovas:${skip}:${limit}`, TTL.CATALOG_SEMI, async () => {
            const [ovas, onas, specials] = await Promise.all([
                kitsuList('/anime', { 'filter[subtype]': 'OVA', sort: '-userCount' }, skip, limit),
                kitsuList('/anime', { 'filter[subtype]': 'ONA', sort: '-userCount' }, skip, limit),
                kitsuList('/anime', { 'filter[subtype]': 'special', sort: '-userCount' }, skip, limit)
            ]);
            const merged = [];
            const longest = Math.max(ovas.length, onas.length, specials.length);
            for (let i = 0; i < longest; i++) {
                if (ovas[i]) merged.push(ovas[i]);
                if (onas[i]) merged.push(onas[i]);
                if (specials[i]) merged.push(specials[i]);
            }
            return merged.slice(0, limit).map((item) => toPreview(item));
        })
    };
}

/** AD - Seasons Archive: temporadas passadas (imutáveis → cache 30 dias). */
async function handleSeasons(seasonLabel, skip, limit) {
    const label = String(seasonLabel || '').trim();
    const match = /^(winter|spring|summer|fall)\s+(\d{4})$/i.exec(label);
    if (!match) return { metas: [] };

    return {
        metas: await cachedCatalog(`season:${label}:${skip}:${limit}`, TTL.CATALOG_STATIC, async () => {
            const items = await kitsuList('/anime', {
                'filter[subtype]': 'TV',
                'filter[season]': match[1].toLowerCase(),
                'filter[seasonYear]': match[2],
                sort: '-userCount'
            }, skip, limit);
            return items.map((item) => toPreview(item));
        })
    };
}

/* ---------- AD - Studios Showcase (best-effort sobre a API do Kitsu) -------- */

async function resolveCompanyId(studioName) {
    const key = String(studioName).toLowerCase().trim();
    const cached = caches.company.get(key);
    if (cached !== undefined) return cached;

    let companyId = null;
    const attempts = [
        { 'filter[text]': studioName },
        { 'filter[slug]': key.replace(/[^a-z0-9]+/g, '-') }
    ];
    for (const params of attempts) {
        try {
            const body = await kitsuGet('/companies', { ...params, 'page[limit]': 20 });
            const companies = (body && body.data) || [];
            if (!companies.length) continue;
            const exact = companies.find((c) =>
                c.attributes && String(c.attributes.name).toLowerCase() === key
            );
            companyId = (exact || companies[0]).id;
            break;
        } catch (_) { /* tenta a variante seguinte */ }
    }
    caches.company.set(key, companyId, companyId ? TTL.STATIC_MAP : TTL.NEGATIVE);
    return companyId;
}

function extractAnimesFromIncluded(bodies) {
    const unique = new Map();
    bodies.forEach((body) => {
        ((body && body.included) || []).forEach((resource) => {
            if (resource.type === 'anime' && !unique.has(resource.id)) unique.set(resource.id, resource);
        });
    });
    return [...unique.values()];
}

async function getStudioCatalog(studioName) {
    const label = String(studioName || STUDIO_OPTIONS[0]);
    const key = `studio:${label.toLowerCase()}`;
    const cached = caches.catalog.get(key);
    if (cached !== undefined) return cached;

    let metas = [];
    const companyId = await resolveCompanyId(label);
    if (companyId) {
        // O Kitsu não filtra /anime por estúdio → usamos /productions com 3
        // estratégias de failover e validação anti-"filtro ignorado".
        const strategies = [
            { path: '/productions', extra: { 'filter[company_id]': companyId } },
            { path: '/productions', extra: { 'filter[company]': companyId } },
            { path: `/companies/${companyId}/productions`, extra: {} }
        ];
        for (const strategy of strategies) {
            try {
                const bodies = await paginateAll(strategy.path, {
                    ...strategy.extra,
                    include: 'anime',
                    'fields[anime]': STUDIO_ANIME_FIELDS
                }, 400);
                const firstPageItems = (bodies[0] && bodies[0].data) || [];
                const filterApplied = firstPageItems.every((entry) => {
                    const ref = entry.relationships && entry.relationships.company && entry.relationships.company.data;
                    return !ref || String(ref.id) === String(companyId);
                });
                if (!filterApplied) continue;

                const animes = extractAnimesFromIncluded(bodies);
                if (!animes.length) continue;

                metas = animes
                    .filter((item) => item.attributes && item.attributes.subtype !== 'movie')
                    .sort((x, y) =>
                        ((y.attributes && y.attributes.userCount) || 0) -
                        ((x.attributes && x.attributes.userCount) || 0))
                    .slice(0, 400)
                    .map((item) => toPreview(item));
                break;
            } catch (error) {
                console.warn(`[AniDark] Studios "${label}": estratégia falhou (${error.message})`);
            }
        }
    }
    if (!metas.length) {
        console.warn(`[AniDark] Studios "${label}": sem resultados na origem Kitsu.`);
    }
    caches.catalog.set(key, metas, metas.length ? TTL.CATALOG_SEMI : 30 * 60 * 1000);
    return metas;
}

async function handleStudios(studioName, skip, limit) {
    const label = STUDIO_OPTIONS.find((s) =>
        s.toLowerCase() === String(studioName || '').toLowerCase().trim()
    ) || STUDIO_OPTIONS[0];
    const all = await getStudioCatalog(label);
    return { metas: all.slice(skip, skip + limit) };
}

/* ============================================================================
 * 12) MANIFEST
 * ============================================================================ */

const currentSeason = getCurrentSeason();
const currentSeasonLabel = `${SEASON_LABELS[currentSeason.season]} ${currentSeason.year}`;
const SEASONS_ARCHIVE = buildSeasonsArchive(9);
const PAGINATION_EXTRAS = [{ name: 'skip' }, { name: 'limit' }];

const manifest = {
    id: 'org.anidark.kitsu.ultimate',
    version: '1.0.0',
    name: 'AniDark Ultimate',
    description: 'O melhor de 3 ecossistemas num só addon: catálogo Kitsu (títulos limpos, capas em alta resolução), EPG AniList com data/hora exatas para o Calendário do Stremio e mapeamento IMDb via MALSync para redundância de streams (Comet, MediaFusion, Jackettio). Inclui Search, Trending & Current, Airing vs Completed, Movies & OVAs, Studios Showcase e Seasons Archive.',
    resources: ['catalog', 'meta'],
    types: ['series', 'movie'],
    idPrefixes: ['kitsu'],
    catalogs: [
        // Pesquisa global (séries + filmes) — sort=-startDate
        { type: 'series', id: 'ad-search', name: 'AD - Search', idPrefixes: ['kitsu'],
          extra: [{ name: 'search', isRequired: true }, ...PAGINATION_EXTRAS] },
        { type: 'movie', id: 'ad-search', name: 'AD - Search', idPrefixes: ['kitsu'],
          extra: [{ name: 'search', isRequired: true }, ...PAGINATION_EXTRAS] },
        // Em Destaque e Temporada Atual (ex.: Spring 2026 — calculado no arranque)
        { type: 'series', id: 'ad-trending', name: `AD - Trending & Current (${currentSeasonLabel})`,
          idPrefixes: ['kitsu'], extra: PAGINATION_EXTRAS },
        { type: 'series', id: 'ad-airing', name: 'AD - Airing', idPrefixes: ['kitsu'], extra: PAGINATION_EXTRAS },
        { type: 'series', id: 'ad-completed', name: 'AD - Completed', idPrefixes: ['kitsu'], extra: PAGINATION_EXTRAS },
        // Filmes (type movie) + OVAs/ONAs/Especiais (type series)
        { type: 'movie', id: 'ad-movies', name: 'AD - Movies & OVAs', idPrefixes: ['kitsu'], extra: PAGINATION_EXTRAS },
        { type: 'series', id: 'ad-ovas', name: 'AD - Movies & OVAs', idPrefixes: ['kitsu'], extra: PAGINATION_EXTRAS },
        { type: 'series', id: 'ad-studios', name: 'AD - Studios Showcase', idPrefixes: ['kitsu'],
          extra: [{ name: 'studio', options: STUDIO_OPTIONS, isRequired: false }, ...PAGINATION_EXTRAS] },
        { type: 'series', id: 'ad-seasons', name: 'AD - Seasons Archive', idPrefixes: ['kitsu'],
          extra: [{ name: 'season', options: SEASONS_ARCHIVE, isRequired: false }, ...PAGINATION_EXTRAS] }
    ]
};

/* ============================================================================
 * 13) HANDLERS DO SDK
 * ============================================================================ */

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
    try {
        const skip = Math.max(0, parseInt(extra.skip, 10) || 0);
        const limit = Math.max(1, Math.min(150, parseInt(extra.limit, 10) || 100));
        switch (id) {
            case 'ad-search':
                return await handleSearch(type, extra.search, skip, limit);
            case 'ad-trending':
                return await handleTrending(skip, limit);
            case 'ad-airing':
                return await handleAiring(skip, limit);
            case 'ad-completed':
                return await handleCompleted(skip, limit);
            case 'ad-movies':
                return await handleMovies(skip, limit);
            case 'ad-ovas':
                return await handleOvas(skip, limit);
            case 'ad-studios':
                return await handleStudios(extra.studio, skip, limit);
            case 'ad-seasons':
                return await handleSeasons(extra.season || SEASONS_ARCHIVE[0], skip, limit);
            default:
                return { metas: [] };
        }
    } catch (error) {
        console.error(`[AniDark] Erro no catálogo "${id}":`, error && error.message);
        return { metas: [] }; // nunca bloquear o servidor
    }
});

builder.defineMetaHandler(async ({ id }) => {
    const started = Date.now();
    try {
        const kitsuId = parseKitsuId(id);
        if (!kitsuId) return { meta: null };

        const cacheKey = `kitsu:${kitsuId}`;
        const cached = caches.meta.get(cacheKey);
        if (cached !== undefined) return { meta: cached };

        const built = await buildMetaDetail(kitsuId);
        if (!built) {
            caches.meta.set(cacheKey, null, TTL.NEGATIVE); // cache negativo curto
            return { meta: null };
        }

        // Smart Cache de duas velocidades
        const ttl = built.airing ? TTL.AIRING : (built.upcoming ? TTL.UPCOMING : TTL.FINISHED);
        caches.meta.set(cacheKey, built.meta, ttl);

        const mode = built.airing ? 'airing → 15 min' : (built.upcoming ? 'upcoming → 6 h' : 'finished → 30 dias');
        console.log(`[AniDark] meta kitsu:${kitsuId} construída em ${Date.now() - started}ms (${mode})`);
        return { meta: built.meta };
    } catch (error) {
        console.error(`[AniDark] Erro na meta "${id}":`, error && error.message);
        return { meta: null }; // nunca bloquear o servidor
    }
});

/* ============================================================================
 * 14) SERVIDOR (Hugging Face Spaces: process.env.PORT || 7000)
 * ============================================================================ */

process.on('unhandledRejection', (reason) => {
    console.error('[AniDark] unhandledRejection:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('[AniDark] uncaughtException:', (error && error.stack) || error);
});

const PORT = parseInt(process.env.PORT, 10) || 7000;

console.log(`[AniDark Ultimate] Temporada atual: ${currentSeasonLabel}`);
console.log(`[AniDark Ultimate] Seasons Archive: ${SEASONS_ARCHIVE.slice(0, 3).join(', ')} ...`);
console.log(`[AniDark Ultimate] A servir na porta ${PORT}`);

serveHTTP(builder.getInterface(), { port: PORT });
