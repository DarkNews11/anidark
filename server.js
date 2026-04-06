const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const manifest = {
    id: "org.anidark.kitsu.pro",
    version: "9.0.0",
    name: "AniDark",
    description: "Infinite Scrolling & Advanced Movie Filters.",
    resources: ["catalog", "meta"],
    types: ["anime"],
    idPrefixes: ["kitsu:"],
    catalogs: [
        { type: "anime", id: "anidark_trending", name: "AD - Trending Anime" },
        // O parâmetro { name: "skip" } é o que diz ao Stremio que este catálogo tem mais páginas
        { type: "anime", id: "anidark_current", name: "AD - Current Season", extra: [{ name: "skip" }] },
        { type: "anime", id: "anidark_movies_trend", name: "AD - Trending Movies", extra: [{ name: "skip" }] },
        { type: "anime", id: "anidark_movies_current", name: "AD - Movies Spring 2026", extra: [{ name: "skip" }] }, 
        {
            type: "anime",
            id: "anidark_past",
            name: "AD - Anime by Season",
            extra: [
                { name: "genre", isRequired: true, options: ["Winter 2026", "Fall 2025", "Summer 2025", "Spring 2025", "Winter 2025", "Fall 2024"] },
                { name: "skip" }
            ]
        },
        // O novo catálogo de filmes antigos
        {
            type: "anime",
            id: "anidark_movies_past",
            name: "AD - Movies by Season",
            extra: [
                { name: "genre", isRequired: true, options: ["Winter 2026", "Fall 2025", "Summer 2025", "Spring 2025", "Winter 2025", "Fall 2024"] },
                { name: "skip" }
            ]
        }
    ]
};

const builder = new addonBuilder(manifest);
const kitsuApi = axios.create({ baseURL: "https://kitsu.io/api/edge" });

const cache = {};
const CACHE_TTL = 3 * 60 * 60 * 1000;

async function fetchWithCache(endpoint) {
    if (cache[endpoint] && (Date.now() - cache[endpoint].timestamp < CACHE_TTL)) {
        return cache[endpoint].data;
    }
    try {
        const response = await kitsuApi.get(endpoint, { timeout: 6000 });
        cache[endpoint] = { timestamp: Date.now(), data: response.data.data };
        return response.data.data;
    } catch (error) {
        return null; 
    }
}

function getBestTitle(attrs) {
    if (!attrs) return "Unknown Title";
    return attrs.titles?.en || attrs.titles?.en_us || attrs.titles?.en_jp || attrs.canonicalTitle || "Unknown Title";
}

// 1. CATÁLOGOS COM PAGINAÇÃO DINÂMICA
builder.defineCatalogHandler(async ({ id, extra }) => {
    // O skip diz quantos animes devemos saltar (página 1 salta 0, página 2 salta 20, etc.)
    const skip = extra.skip || 0; 
    const limit = 20; // O Kitsu prefere blocos de 20 para estabilidade
    
    let endpoint = "";

    if (id === "anidark_trending") {
        endpoint = `/trending/anime?limit=${limit}`; // O trending não suporta bem paginação
    } else if (id === "anidark_current") {
        endpoint = `/anime?filter[season]=spring&filter[seasonYear]=2026&sort=-userCount&page[limit]=${limit}&page[offset]=${skip}`;
    } else if (id === "anidark_movies_trend") {
        endpoint = `/anime?filter[subtype]=movie&sort=-userCount&page[limit]=${limit}&page[offset]=${skip}`;
    } else if (id === "anidark_movies_current") {
        endpoint = `/anime?filter[subtype]=movie&filter[season]=spring&filter[seasonYear]=2026&sort=-userCount&page[limit]=${limit}&page[offset]=${skip}`;
    } else if (id === "anidark_past" && extra.genre) {
        const [s, y] = extra.genre.toLowerCase().split(" ");
        endpoint = `/anime?filter[season]=${s}&filter[seasonYear]=${y}&sort=-userCount&page[limit]=${limit}&page[offset]=${skip}`;
    } else if (id === "anidark_movies_past" && extra.genre) {
        // Filtro específico para o novo separador de filmes
        const [s, y] = extra.genre.toLowerCase().split(" ");
        endpoint = `/anime?filter[subtype]=movie&filter[season]=${s}&filter[seasonYear]=${y}&sort=-userCount&page[limit]=${limit}&page[offset]=${skip}`;
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

// 2. METADADOS E EPISÓDIOS (Mantém a blindagem perfeita de compatibilidade)
builder.defineMetaHandler(async ({ id }) => {
    const kitsuId = id.split(":")[1];
    
    const [anime, epsData] = await Promise.all([
        fetchWithCache(`/anime/${kitsuId}`),
        fetchWithCache(`/anime/${kitsuId}/episodes?page[limit]=20`)
    ]);

    if (!anime) return { meta: {} };
    const attrs = anime.attributes;
    const cleanTitle = getBestTitle(attrs);

    let videos = [];
    const totalEps = (attrs.episodeCount && attrs.episodeCount > 0) ? attrs.episodeCount : 24;
    
    if (attrs.subtype === "movie" || attrs.episodeCount === 1) {
        videos = [{ id: `kitsu:${kitsuId}:1`, title: cleanTitle, episode: 1, season: 1 }];
    } else {
        let lastEpNumber = 0;
        
        if (epsData && epsData.length > 0) {
            const validEps = epsData.filter(ep => ep.attributes && ep.attributes.number != null);
            validEps.sort((a, b) => a.attributes.number - b.attributes.number);
            validEps.forEach(ep => {
                const epNum = parseInt(ep.attributes.number);
                videos.push({
                    id: `kitsu:${kitsuId}:${epNum}`,
                    title: ep.attributes.titles?.en_us || ep.attributes.titles?.en_jp || `Episode ${epNum}`,
                    episode: epNum,
                    season: 1,
                    thumbnail: ep.attributes.thumbnail?.original || null,
                    released: ep.attributes.airdate ? new Date(ep.attributes.airdate).toISOString() : undefined
                });
                lastEpNumber = epNum;
            });
        }
        
        const maxToGenerate = Math.max(totalEps, lastEpNumber);
        for (let i = lastEpNumber + 1; i <= maxToGenerate; i++) {
            videos.push({
                id: `kitsu:${kitsuId}:${i}`,
                title: `Episode ${i}`,
                episode: i,
                season: 1
            });
        }
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
            videos: videos
        }
    };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
