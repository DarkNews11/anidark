const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const manifest = {
    id: "org.anidark.mal",
    version: "3.1.0",
    name: "AniDark",
    description: "MAL Metadata with Kitsu Streams. Prefixed for easy access.",
    resources: ["catalog", "meta"],
    types: ["anime"],
    idPrefixes: ["mal:", "kitsu:"], // Adicionado kitsu aos prefixos para maior compatibilidade
    catalogs: [
        { type: "anime", id: "anidark_trending", name: "AD - Trending Anime" },
        { type: "anime", id: "anidark_current", name: "AD - Current Season" },
        { type: "anime", id: "anidark_movies_trend", name: "AD - Trending Movies" },
        { type: "anime", id: "anidark_movies_current", name: "AD - Movies Current Season" }, 
        {
            type: "anime",
            id: "anidark_past",
            name: "AD - Anime by Season",
            extra: [{ name: "genre", isRequired: true, options: ["Winter 2026", "Fall 2025", "Summer 2025", "Spring 2025", "Winter 2025", "Fall 2024"] }]
        }
    ]
};

const builder = new addonBuilder(manifest);
const jikanApi = axios.create({ baseURL: "https://api.jikan.moe/v4" });

const cache = {};
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 Horas de Cache

async function fetchWithCache(endpoint) {
    if (cache[endpoint] && (Date.now() - cache[endpoint].timestamp < CACHE_TTL)) {
        return cache[endpoint].data;
    }
    // Delay para respeitar o limite de 3req/sec do Jikan
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
        const response = await jikanApi.get(endpoint, { timeout: 7000 });
        cache[endpoint] = { timestamp: Date.now(), data: response.data.data };
        return response.data.data;
    } catch (error) {
        console.error(`Jikan Error (${endpoint}):`, error.message);
        return null;
    }
}

// Mapeamento ultrarrápido para Kitsu
async function getKitsuId(malId) {
    const key = `k_map_${malId}`;
    if (cache[key]) return cache[key];
    try {
        const res = await axios.get(`https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}`, { timeout: 4000 });
        if (res.data?.data?.[0]) {
            const id = res.data.data[0].relationships.item.data.id;
            cache[key] = id;
            return id;
        }
    } catch (e) { console.error("Kitsu Mapping Fail"); }
    return null;
}

function getSafeTitle(anime) {
    if (!anime) return "Unknown Title";
    // Forçar a ordem de prioridade de nomes ingleses
    return anime.title_english || anime.title || anime.title_japanese || "Unknown Title";
}

builder.defineCatalogHandler(async ({ id, extra }) => {
    let endpoint = "";
    let isMovieSeason = false;

    if (id === "anidark_trending") endpoint = "/top/anime?filter=airing&limit=25";
    else if (id === "anidark_current") endpoint = "/seasons/now?limit=25";
    else if (id === "anidark_movies_trend") endpoint = "/top/anime?type=movie&limit=25";
    else if (id === "anidark_movies_current") { endpoint = "/seasons/now?limit=25"; isMovieSeason = true; }
    else if (id === "anidark_past" && extra.genre) {
        const [s, y] = extra.genre.toLowerCase().split(" ");
        endpoint = `/seasons/${y}/${s}?limit=25`;
    }

    const data = await fetchWithCache(endpoint);
    if (!data) return { metas: [] };

    let results = data;
    if (isMovieSeason) results = results.filter(a => a.type === "Movie");

    return {
        metas: results.map(a => ({
            id: `mal:${a.mal_id}`,
            type: "anime",
            name: getSafeTitle(a),
            poster: a.images?.webp?.large_image_url || a.images?.jpg?.large_image_url || ""
        }))
    };
});

builder.defineMetaHandler(async ({ id }) => {
    const malId = id.split(":")[1];
    
    // Pedidos em paralelo para máxima performance
    const [anime, epData, kitsuId] = await Promise.all([
        fetchWithCache(`/anime/${malId}`),
        fetchWithCache(`/anime/${malId}/episodes`),
        getKitsuId(malId)
    ]);

    if (!anime) return { meta: {} };

    const prefix = kitsuId ? `kitsu:${kitsuId}` : `mal:${malId}`;
    const cleanTitle = getSafeTitle(anime);

    let videos = [];
    if (epData && epData.length > 0) {
        videos = epData.map(e => ({
            id: `${prefix}:${e.mal_id}`,
            title: e.title || `Episode ${e.mal_id}`,
            episode: e.mal_id,
            season: 1
        }));
    } else {
        // Fallback para filmes ou animes sem lista de episódios
        videos = [{ id: `${prefix}:1`, title: cleanTitle, episode: 1, season: 1 }];
    }

    return {
        meta: {
            id: id,
            type: "anime",
            name: cleanTitle,
            description: anime.synopsis || "No description available.",
            poster: anime.images?.webp?.large_image_url || anime.images?.jpg?.large_image_url || "",
            background: anime.trailer?.images?.maximum_image_url || anime.images?.jpg?.large_image_url || "",
            genres: anime.genres?.map(g => g.name) || [],
            releaseInfo: anime.year?.toString() || "",
            videos: videos
        }
    };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const manifest = {
    id: "org.anidark.mal",
    version: "3.0.0",
    name: "AniDark",
    description: "MAL Metadata with Kitsu Streams. The ultimate anime experience.",
    resources: ["catalog", "meta"],
    types: ["anime"],
    idPrefixes: ["mal:"],
    catalogs: [
        { type: "anime", id: "anidark_trending", name: "Trending Anime" },
        { type: "anime", id: "anidark_current", name: "Current Season (Spring 2026)" },
        { type: "anime", id: "anidark_movies_trend", name: "Trending Movies" },
        { type: "anime", id: "anidark_movies_current", name: "Movies (Spring 2026)" }, 
        {
            type: "anime",
            id: "anidark_past",
            name: "Anime by Season",
            extra: [{ name: "genre", isRequired: true, options: ["Winter 2026", "Fall 2025", "Summer 2025", "Spring 2025", "Winter 2025", "Fall 2024"] }]
        }
    ]
};

const builder = new addonBuilder(manifest);
const jikanApi = axios.create({ baseURL: "https://api.jikan.moe/v4" });

// SISTEMA DE CACHE
const cache = {};
const CACHE_TTL = 2 * 60 * 60 * 1000;

async function fetchWithCache(endpoint) {
    if (cache[endpoint] && (Date.now() - cache[endpoint].timestamp < CACHE_TTL)) {
        return cache[endpoint].data;
    }
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1200));
    try {
        const response = await jikanApi.get(endpoint, { timeout: 8000 });
        cache[endpoint] = { timestamp: Date.now(), data: response.data.data };
        return response.data.data;
    } catch (error) {
        console.error(`Erro na API Jikan (${endpoint}):`, error.message);
        return null;
    }
}

// O MOTOR DE TRADUÇÃO MAL -> KITSU
async function getKitsuId(malId) {
    const cacheKey = `kitsu_mapping_${malId}`;
    if (cache[cacheKey]) return cache[cacheKey];

    try {
        const url = `https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}`;
        const response = await axios.get(url, { timeout: 5000 });
        
        if (response.data && response.data.data && response.data.data.length > 0) {
            const kitsuId = response.data.data[0].relationships.item.data.id;
            cache[cacheKey] = kitsuId; // Guarda na cache para ser instantâneo da próxima vez
            return kitsuId;
        }
    } catch (error) {
        console.error(`Erro a traduzir MAL ${malId} para Kitsu:`, error.message);
    }
    return null; // Se falhar, devolve null e o código usa o MAL ID como plano B
}

function getSafeImage(anime) {
    if (!anime || !anime.images) return "";
    return anime.images.webp?.large_image_url || anime.images.jpg?.large_image_url || "";
}

function getSafeTitle(anime) {
    if (!anime) return "Unknown Title";
    return anime.title_english || anime.title || "Unknown Title";
}

// 1. CATÁLOGO
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    let endpoint = "";
    let isMovieCurrentSeason = false;

    if (id === "anidark_trending") endpoint = "/top/anime?filter=airing&limit=20";
    else if (id === "anidark_current") endpoint = "/seasons/now?limit=20";
    else if (id === "anidark_movies_trend") endpoint = "/top/anime?type=movie&limit=20";
    else if (id === "anidark_movies_current") {
        endpoint = "/seasons/now?limit=25"; 
        isMovieCurrentSeason = true;
    }
    else if (id === "anidark_past" && extra.genre) {
        const [season, year] = extra.genre.toLowerCase().split(" ");
        endpoint = `/seasons/${year}/${season}?limit=20`;
    }

    const rawData = await fetchWithCache(endpoint);
    if (!rawData) return { metas: [] };

    let animes = rawData;
    if (isMovieCurrentSeason) {
        animes = animes.filter(a => a.type === "Movie");
    }

    const metas = animes.map(anime => ({
        id: `mal:${anime.mal_id}`,
        type: "anime",
        name: getSafeTitle(anime),
        poster: getSafeImage(anime),
    }));

    return { metas };
});

// 2. METADADOS E EPISÓDIOS COM TRADUÇÃO INJETADA
builder.defineMetaHandler(async ({ type, id }) => {
    const malId = id.split(":")[1];
    
    // Puxa Dados do MAL e o ID do Kitsu em simultâneo
    const [anime, episodesData, kitsuId] = await Promise.all([
        fetchWithCache(`/anime/${malId}`),
        fetchWithCache(`/anime/${malId}/episodes`),
        getKitsuId(malId)
    ]);
    
    if (!anime) return { meta: {} };

    let backgroundUrl = getSafeImage(anime);
    if (anime.trailer && anime.trailer.images && anime.trailer.images.maximum_image_url) {
        backgroundUrl = anime.trailer.images.maximum_image_url;
    }

    // Define qual é o prefixo a usar (Dá prioridade ao Kitsu para os addons de vídeo funcionarem)
    const prefix = kitsuId ? `kitsu:${kitsuId}` : `mal:${malId}`;

    let videos = [];
    if (episodesData && episodesData.length > 0) {
        videos = episodesData.map(ep => ({
            id: `${prefix}:${ep.mal_id}`, // Injeção do ID Traduzido
            title: ep.title || `Episode ${ep.mal_id}`,
            episode: ep.mal_id,
            season: 1,
            released: ep.aired ? new Date(ep.aired).toISOString() : undefined
        }));
    } else if (anime.type === "Movie" || anime.episodes === 1) {
        videos = [{
            id: `${prefix}:1`,
            title: getSafeTitle(anime),
            episode: 1,
            season: 1
        }];
    }

    return {
        meta: {
            id: id, // O Stremio pensa que isto é MAL
            type: "anime",
            name: getSafeTitle(anime),
            description: anime.synopsis || "Sinopse não disponível.",
            poster: getSafeImage(anime),
            background: backgroundUrl,
            genres: anime.genres ? anime.genres.map(g => g.name) : [],
            releaseInfo: anime.year ? anime.year.toString() : "",
            videos: videos // Mas os vídeos levam a máscara do Kitsu!
        }
    };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
