const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const manifest = {
    id: "org.anidark.kitsu.pro",
    version: "4.0.0",
    name: "AniDark",
    description: "Kitsu Engine with V9 UI features. 100% Stream Compatibility.",
    resources: ["catalog", "meta"],
    types: ["anime"],
    idPrefixes: ["kitsu:"],
    catalogs: [
        { type: "anime", id: "anidark_trending", name: "AD - Trending Anime" },
        { type: "anime", id: "anidark_current", name: "AD - Current Season" },
        { type: "anime", id: "anidark_movies_trend", name: "AD - Trending Movies" },
        { type: "anime", id: "anidark_movies_current", name: "AD - Movies Spring 2026" }, 
        {
            type: "anime",
            id: "anidark_past",
            name: "AD - Anime by Season",
            extra: [{ name: "genre", isRequired: true, options: ["Winter 2026", "Fall 2025", "Summer 2025", "Spring 2025", "Winter 2025", "Fall 2024"] }]
        }
    ]
};

const builder = new addonBuilder(manifest);
const kitsuApi = axios.create({ baseURL: "https://kitsu.io/api/edge" });

// Sistema de Cache
const cache = {};
const CACHE_TTL = 3 * 60 * 60 * 1000;

async function fetchWithCache(endpoint) {
    if (cache[endpoint] && (Date.now() - cache[endpoint].timestamp < CACHE_TTL)) {
        return cache[endpoint].data;
    }
    try {
        const response = await kitsuApi.get(endpoint, { timeout: 7000 });
        cache[endpoint] = { timestamp: Date.now(), data: response.data.data };
        return response.data.data;
    } catch (error) {
        console.error(`Erro Kitsu (${endpoint}):`, error.message);
        return null;
    }
}

// Filtro agressivo para Títulos em Inglês
function getBestTitle(attrs) {
    if (!attrs) return "Unknown Title";
    return attrs.titles?.en || attrs.titles?.en_us || attrs.titles?.en_jp || attrs.canonicalTitle || "Unknown Title";
}

// 1. CATÁLOGOS
builder.defineCatalogHandler(async ({ id, extra }) => {
    let endpoint = "/anime?limit=25";

    if (id === "anidark_trending") endpoint = "/trending/anime?limit=25";
    else if (id === "anidark_current") endpoint = "/anime?filter[season]=spring&filter[seasonYear]=2026&sort=-userCount&limit=25";
    else if (id === "anidark_movies_trend") endpoint = "/anime?filter[subtype]=movie&sort=-userCount&limit=25";
    else if (id === "anidark_movies_current") endpoint = "/anime?filter[subtype]=movie&filter[season]=spring&filter[seasonYear]=2026&sort=-userCount&limit=25";
    else if (id === "anidark_past" && extra.genre) {
        const [s, y] = extra.genre.toLowerCase().split(" ");
        endpoint = `/anime?filter[season]=${s}&filter[seasonYear]=${y}&sort=-userCount&limit=25`;
    }

    const data = await fetchWithCache(endpoint);
    if (!data) return { metas: [] };

    return {
        metas: data.map(anime => ({
            id: `kitsu:${anime.id}`,
            type: "anime",
            name: getBestTitle(anime.attributes),
            poster: anime.attributes.posterImage?.large || anime.attributes.posterImage?.original || ""
        }))
    };
});

// 2. METADADOS E PROTEÇÃO DA PÁGINA
builder.defineMetaHandler(async ({ id }) => {
    const kitsuId = id.split(":")[1];
    
    // Puxamos a informação do anime e a primeira página de episódios
    const [anime, epsData] = await Promise.all([
        fetchWithCache(`/anime/${kitsuId}`),
        fetchWithCache(`/anime/${kitsuId}/episodes?page[limit]=40`)
    ]);

    if (!anime) return { meta: {} };
    const attrs = anime.attributes;
    const cleanTitle = getBestTitle(attrs);

    // Mapeamento dos episódios nativos do Kitsu para carregar as streams
    let videos = [];
    if (epsData && epsData.length > 0) {
        epsData.sort((a, b) => a.attributes.number - b.attributes.number);
        videos = epsData.map(ep => ({
            id: `kitsu:${kitsuId}:${ep.attributes.number}`,
            title: ep.attributes.titles?.en_us || ep.attributes.titles?.en_jp || `Episode ${ep.attributes.number}`,
            episode: ep.attributes.number,
            season: 1,
            released: ep.attributes.airdate ? new Date(ep.attributes.airdate).toISOString() : undefined
        }));
    } else if (attrs.subtype === "movie" || attrs.episodeCount === 1) {
        videos = [{ id: `kitsu:${kitsuId}:1`, title: cleanTitle, episode: 1, season: 1 }];
    }

    return {
        meta: {
            id: id,
            type: "anime",
            name: cleanTitle,
            description: attrs.synopsis || "Sinopse não disponível.",
            poster: attrs.posterImage?.large || "",
            background: attrs.coverImage?.original || attrs.posterImage?.original || "",
            genres: attrs.subtype ? [attrs.subtype] : [],
            releaseInfo: attrs.startDate ? attrs.startDate.split("-")[0] : "",
            videos: videos.length > 0 ? videos : undefined
        }
    };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
