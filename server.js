const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const manifest = {
    id: "org.anidark.kitsu.pro",
    version: "11.0.0",
    name: "AniDark",
    description: "Search explicitly sorted by newest release.",
    resources: ["catalog", "meta"],
    types: ["anime", "movie"],
    idPrefixes: ["kitsu:"],
    catalogs: [
        { type: "anime", id: "anidark_search", name: "AD - Search", extra: [{ name: "search", isRequired: true }] },
        { type: "anime", id: "anidark_trending", name: "AD - Trending Anime" },
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

builder.defineCatalogHandler(async ({ id, extra }) => {
    const skip = extra.skip || 0; 
    const limit = 20; 
    let endpoint = "";

    if (extra.search) {
        // Adicionado &sort=-startDate para forçar do mais recente para o mais antigo
        endpoint = `/anime?filter[text]=${encodeURIComponent(extra.search)}&sort=-startDate&page[limit]=${limit}&page[offset]=${skip}`;
    } else if (id === "anidark_trending") {
        endpoint = `/trending/anime?limit=${limit}`; 
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

builder.defineMetaHandler(async ({ id }) => {
    const kitsuId = id.split(":")[1];
    
    const [anime, epsData] = await Promise.all([
        fetchWithCache(`/anime/${kitsuId}`),
        fetchWithCache(`/anime/${kitsuId}/episodes?page[limit]=20`)
    ]);

    if (!anime) return { meta: {} };
    const attrs = anime.attributes;
    const cleanTitle = getBestTitle(attrs);
    const isMovie = attrs.subtype === "movie";
    const finalType = isMovie ? "movie" : "anime";

    let videos = undefined;

    if (!isMovie) {
        videos = [];
        const totalEps = (attrs.episodeCount && attrs.episodeCount > 0) ? attrs.episodeCount : 24;
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
            type: finalType,
            name: cleanTitle,
            description: attrs.synopsis || "Sinopse não disponível.",
            poster: attrs.posterImage?.large || "",
            background: attrs.coverImage?.original || attrs.posterImage?.original || "",
            genres: attrs.subtype ? [attrs.subtype] : [],
            releaseInfo: attrs.startDate ? attrs.startDate.split("-")[0] : "",
            ...(videos && { videos })
        }
    };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
